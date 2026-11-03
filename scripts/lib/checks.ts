import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import Ajv2019Module from 'ajv/dist/2019.js';
import addFormatsModule from 'ajv-formats';
import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import { DEF_PREFIX, type RepoFile, type RepoModel, type ValidationIssue } from './repo.ts';
import { type DiffEntry, type GitContext, getReleases, getReleaseTags, type Release, RELEASE_TAG, shippedBy } from './git.ts';
import { entrySha256 } from './emit.ts';
import { buildCatalog, CATALOG_IRI, embeddedDataset, jsonLd, releaseIri, seriesIri } from './dcat.ts';
import { CC0, VOCABULARY } from './rdf.ts';
import oxigraph from 'oxigraph';
import { ask, distributionPins, loadSpecs, membershipReferences, parseJsonLd, select, type HostedSpec, type SpecLoad } from './spec.ts';

// ajv/ajv-formats ship CJS; under native ESM the class may sit on .default or be the export itself.
const Ajv2019 = (Ajv2019Module as unknown as { default?: typeof Ajv2019Module }).default ?? Ajv2019Module;
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'dictionary-entry.schema.json');
/** RFC 9116 recommends an expiry under a year; past it, tooling treats the contact as stale. */
const SECURITY_TXT_MAX_MONTHS = 12;
const DAY_MS = 86_400_000;

/**
 * Internal references that must be version-pinned to a published file (R5, plan §2.3).
 * Exempt by design: isDefinedBy (names the dictionary), replaces (its own check 4 — it
 * additionally forbids forks, which plain pinning doesn't express).
 */
const PINNED_URI_FIELDS = ['unit', 'quantityKind', 'coherentSiUnit', 'itemType'] as const;

function defUuid(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith(DEF_PREFIX)) return undefined;
  const rest = uri.slice(DEF_PREFIX.length);
  return rest.includes('/') ? undefined : rest;
}

/** Check 2 — every published/ file and every drafts/ file validates against the envelope schema. */
// Syntax sanity check, not a full UCUM grammar validator (see e.g. @lhncbc/ucum-lhc for that) —
// rejects whitespace/unicode, accepts UCUM's own punctuation (brackets for non-metric atoms
// like "[psi]", braces for annotations, ./ for products/quotients).
const UCUM_CODE_PATTERN = /^[A-Za-z0-9[\]{}_.^\-*/%'"]+$/;

export function checkSchema(repo: RepoModel): ValidationIssue[] {
  const ajv = new Ajv2019({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addFormat('ucum-code', UCUM_CODE_PATTERN);
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object;
  const validate = ajv.compile(schema);

  const issues: ValidationIssue[] = [];
  for (const file of [...repo.published, ...repo.drafts]) {
    if (!file.doc) continue; // load errors are reported separately
    if (validate(file.doc)) continue;
    for (const err of validate.errors ?? []) {
      issues.push({
        check: '2 schema',
        file: file.relPath,
        message: `${err.instancePath || '/'} ${err.message ?? 'invalid'}`,
      });
    }
  }
  return issues;
}

/** Check 3 — filename = UUID = id, canonical domain, RFC 4122 v4, no duplicate ids. */
export function checkIdentity(repo: RepoModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Map<string, string>();

  for (const file of repo.published) {
    if (!file.doc) continue;
    const check = '3 identity';

    if (!uuidValidate(file.stem) || uuidVersion(file.stem) !== 4) {
      issues.push({ check, file: file.relPath, message: `filename "${file.stem}" is not an RFC 4122 v4 UUID` });
    }

    const id = file.doc.id;
    if (typeof id !== 'string') {
      issues.push({ check, file: file.relPath, message: 'missing or non-string id' });
      continue;
    }

    const idUuid = defUuid(id);
    if (idUuid === undefined) {
      issues.push({ check, file: file.relPath, message: `id "${id}" is not canonical (${DEF_PREFIX}<uuid>)` });
    } else {
      if (!uuidValidate(idUuid) || uuidVersion(idUuid) !== 4) {
        issues.push({ check, file: file.relPath, message: `id UUID "${idUuid}" is not an RFC 4122 v4 UUID` });
      }
      if (idUuid !== file.stem) {
        issues.push({ check, file: file.relPath, message: `filename UUID "${file.stem}" does not match id UUID "${idUuid}"` });
      }
    }

    const first = seen.get(id);
    if (first !== undefined) {
      issues.push({ check, file: file.relPath, message: `duplicate id "${id}" (also in ${first})` });
    } else {
      seen.set(id, file.relPath);
    }
  }
  return issues;
}

/**
 * Check 4 — replaces integrity. `replaces` (if present) must resolve to an existing
 * published entry, and at most one published entry may replace any given target — a fork
 * would make "current" (nothing replaces me) ambiguous. No forward-only check is needed:
 * `replaces` can only name something already published, and published entries never
 * change, so a cycle is structurally impossible.
 */
export function checkReplaces(repo: RepoModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const check = '4 replaces';
  const publishedUuids = new Set(repo.published.map((f) => f.stem));
  const claimedBy = new Map<string, string>(); // target uuid -> first file that replaces it

  for (const file of repo.published) {
    if (!file.doc) continue;
    const replaces = file.doc.replaces;
    if (replaces === undefined) continue;

    if (replaces === file.doc.id) {
      issues.push({ check, file: file.relPath, message: 'replaces its own id' });
      continue;
    }

    const targetUuid = defUuid(replaces);
    if (targetUuid === undefined || !publishedUuids.has(targetUuid)) {
      issues.push({ check, file: file.relPath, message: `replaces "${String(replaces)}" does not resolve to a published entry` });
      continue;
    }

    const first = claimedBy.get(targetUuid);
    if (first !== undefined) {
      issues.push({ check, file: file.relPath, message: `replaces "${String(replaces)}", but ${first} already does — at most one entry may replace a given entry` });
    } else {
      claimedBy.set(targetUuid, file.relPath);
    }
  }
  return issues;
}

/** Check 5 — every internal reference in a published entry resolves to a file in published/ at head (R5). */
export function checkPinning(repo: RepoModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const check = '5 pinning';
  const publishedUuids = new Set(repo.published.map((f) => f.stem));

  const requirePinned = (file: RepoFile, field: string, value: unknown) => {
    const uuid = defUuid(value);
    if (uuid === undefined || !publishedUuids.has(uuid)) {
      issues.push({ check, file: file.relPath, message: `${field} "${String(value)}" does not resolve to a file in published/` });
    }
  };

  for (const file of repo.published) {
    if (!file.doc) continue;

    for (const field of PINNED_URI_FIELDS) {
      if (file.doc[field] !== undefined) requirePinned(file, field, file.doc[field]);
    }

    const enumeration = file.doc.enumeration;
    if (Array.isArray(enumeration)) {
      enumeration.forEach((member, i) => requirePinned(file, `enumeration[${i}]`, member));
    }

    const conversions = file.doc.conversions;
    if (Array.isArray(conversions)) {
      conversions.forEach((conv, i) => {
        if (conv && typeof conv === 'object') requirePinned(file, `conversions[${i}].toUnit`, (conv as Record<string, unknown>).toUnit);
      });
    }

    const elements = file.doc.elements;
    if (Array.isArray(elements)) {
      elements.forEach((el, i) => {
        if (!el || typeof el !== 'object') return;
        const member = el as Record<string, unknown>;
        requirePinned(file, `elements[${i}].dictionaryReference`, member.dictionaryReference);
        if (member.accessCategory !== undefined) requirePinned(file, `elements[${i}].accessCategory`, member.accessCategory);
      });
    }
  }
  return issues;
}

/**
 * security.txt freshness (#109). An *expired* security.txt is worse than none — tooling reads
 * it as an unmonitored contact — and a static file rots silently, so the ratchet (plan §2.7)
 * turns "remember to renew it" into a check that refuses the next PR instead.
 */
export function checkSecurityTxt(root: string, now: Date = new Date(), horizonDays = 0): ValidationIssue[] {
  const check = 'security.txt';
  const file = '.well-known/security.txt';
  const path = join(root, file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return []; // a repo without one is fine (fixture trees have none); a stale one is not
  }

  const issues: ValidationIssue[] = [];
  const field = (name: string): string | undefined =>
    new RegExp(`^${name}:\\s*(.+)$`, 'mi').exec(text)?.[1].trim();

  for (const required of ['Contact', 'Expires']) {
    if (field(required) === undefined) issues.push({ check, file, message: `missing required field "${required}" (RFC 9116)` });
  }

  const expires = field('Expires');
  if (expires !== undefined) {
    const at = new Date(expires);
    if (Number.isNaN(at.getTime())) {
      issues.push({ check, file, message: `Expires "${expires}" is not a valid timestamp` });
    } else if (at <= now) {
      issues.push({ check, file, message: `Expires ${at.toISOString()} has passed — renew it; an expired security.txt reads as an unmonitored contact` });
    } else if (at.getTime() <= now.getTime() + horizonDays * DAY_MS) {
      issues.push({ check, file, message: `Expires ${at.toISOString()}, within the ${horizonDays}-day horizon — renew it before it lapses` });
    } else {
      const ceiling = new Date(now);
      ceiling.setMonth(ceiling.getMonth() + SECURITY_TXT_MAX_MONTHS);
      if (at > ceiling) issues.push({ check, file, message: `Expires ${at.toISOString()} is more than ${SECURITY_TXT_MAX_MONTHS} months out (RFC 9116 recommends less)` });
    }
  }

  const encryption = field('Encryption');
  if (encryption !== undefined && encryption.startsWith('https://material-identity.eu/')) {
    const local = join(dirname(path), encryption.replace('https://material-identity.eu/.well-known/', ''));
    try {
      readFileSync(local);
    } catch {
      issues.push({ check, file, message: `Encryption points at ${encryption}, which is not present in .well-known/` });
    }
  }
  return issues;
}

/**
 * Expiry of the published PGP key (#133). Takes `gpg --with-colons` output so the logic is pure
 * and testable; `checkPgpKey` is the thin wrapper that shells out. A primary key or subkey that
 * is revoked, expired, or inside the horizon is reported; a key with no expiry is fine.
 */
export function pgpKeyExpiryIssues(colons: string, now: Date, horizonDays = 0): string[] {
  const messages: string[] = [];
  let keys = 0;
  for (const line of colons.split('\n')) {
    const f = line.split(':');
    if (f[0] !== 'pub' && f[0] !== 'sub') continue;
    keys++;
    const label = `${f[0] === 'pub' ? 'primary key' : 'subkey'} ${f[4]}`;
    if (f[1] === 'r') {
      messages.push(`${label} is revoked`);
      continue;
    }
    if (f[6] === '') continue;
    const at = new Date(Number(f[6]) * 1000);
    if (at <= now) messages.push(`${label} expired ${at.toISOString()} — publish a renewed key`);
    else if (at.getTime() <= now.getTime() + horizonDays * DAY_MS) {
      messages.push(`${label} expires ${at.toISOString()}, within the ${horizonDays}-day horizon — extend it and republish`);
    }
  }
  if (keys === 0) messages.push('contains no parseable public key');
  return messages;
}

export function checkPgpKey(root: string, now: Date = new Date(), horizonDays = 0): ValidationIssue[] {
  const check = 'pgp-key';
  const file = '.well-known/pgp-security.asc';
  const path = join(root, file);
  try {
    readFileSync(path);
  } catch {
    return []; // absent is fine, as for security.txt
  }
  let colons: string;
  try {
    colons = execFileSync('gpg', ['--batch', '--no-tty', '--show-keys', '--with-colons', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return [{ check, file, message: missing ? 'gpg is not installed, so the key cannot be checked' : 'gpg could not read the key' }];
  }
  return pgpKeyExpiryIssues(colons, now, horizonDays).map((message) => ({ check, file, message }));
}

const POC = `${VOCABULARY}#ProofOfConcept`;
const REGULAR_FILE = '100644';
const EXECUTABLE_FILE = '100755';

/**
 * Check 1 — immutability (R6): only additions are allowed under published/, and under spec/ — a
 * hosted content specification is served immutable, so a change is a new contract version (#135).
 */
export function checkImmutability(diff: DiffEntry[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const entry of diff) {
    const spec = entry.path.startsWith('spec/');
    if (!spec && !entry.path.startsWith('published/')) continue;
    if (entry.status === 'A' && entry.mode !== undefined && entry.mode !== REGULAR_FILE && entry.mode !== EXECUTABLE_FILE) {
      // A symlink (120000) or submodule (160000) is "added" once and then changes whatever it
      // points at without touching this path again — add-only would hold in name only.
      issues.push({
        check: '1 immutability',
        file: entry.path,
        message: `added with git mode ${entry.mode}, not as a regular file — a symlink or submodule under ${spec ? 'spec/' : 'published/'} would let its content change without a diff here`,
      });
      continue;
    }
    if (entry.status === 'A') continue;
    const verb = entry.status === 'D' ? 'deleted' : entry.status === 'M' ? 'modified' : `changed (${entry.status})`;
    issues.push({
      check: '1 immutability',
      file: entry.path,
      message: spec
        ? `hosted specification file ${verb} — spec/ is add-only (#135); a change is a new contract version under a new directory`
        : `published file ${verb} — published/ is add-only (R6); publish a new entry with replaces instead`,
    });
  }
  return issues;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    return deepEqual(ka, kb) && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

function withoutId(doc: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = doc;
  return rest;
}

/**
 * Check 6 — move purity: a draft deleted while published files are added must reappear
 * as one of those published files, content-identical apart from the minted id.
 * Deleting a draft without publishing anything is a legitimate withdrawal.
 */
export function checkMovePurity(repo: RepoModel, git: GitContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const check = '6 move-purity';
  const deletedDrafts = git.diff.filter((e) => e.status === 'D' && e.path.startsWith('drafts/'));
  const addedPublished = new Set(git.diff.filter((e) => e.status === 'A' && e.path.startsWith('published/')).map((e) => e.path));
  if (deletedDrafts.length === 0 || addedPublished.size === 0) return issues;

  const candidates = repo.published.filter((f) => f.doc && addedPublished.has(f.relPath));
  for (const draft of deletedDrafts) {
    const baseText = git.readBaseFile(draft.path);
    if (baseText === undefined) continue;
    let draftDoc: Record<string, unknown>;
    try {
      draftDoc = parse(baseText) as Record<string, unknown>;
    } catch {
      issues.push({ check, file: draft.path, message: 'deleted draft is unparseable at base — cannot verify the move' });
      continue;
    }
    const stripped = withoutId(draftDoc);
    if (!candidates.some((f) => deepEqual(stripped, withoutId(f.doc!)))) {
      issues.push({
        check,
        file: draft.path,
        message: 'deleted draft matches no added published file (a publish move must be content-identical apart from id)',
      });
    }
  }
  return issues;
}

/**
 * The values of `predicate` on `subject` are exactly `[expected]`. A bare ASK would only prove the
 * expected value is among them, and the page then shows whichever one sorts first — a second
 * licence or status (say a `JAVASCRIPT:` IRI) would ride along unchecked (security review of #136).
 */
function exactly(store: oxigraph.Store, subject: string, predicate: string, expected: string): boolean {
  const values = new Set(select(store, `<${subject}> ${predicate} ?v`).map((r) => `${r.get('v')!.termType}:${r.get('v')!.value}`));
  return values.size === 1 && values.has(`NamedNode:${expected}`);
}

/** The spec itself, or one of its `#fragment` nodes (the record's distributions). */
const aboutSpec = (spec: HostedSpec, iri: string): boolean => iri === spec.iri || iri.startsWith(`${spec.iri}#`);

/**
 * The statements a spec's DCAT record contributes to /catalog, read from the catalogue as it is
 * served: the catalogue built around this one record, minus the same catalogue with the record
 * reduced to a bare reference. Parsing the record on its own would check another set of triples
 * than the one served — the embedded node reads in the catalogue's context plus the contexts
 * re-attached to it, and a scoped context dropped on the way could change what its terms mean
 * (code review of #136). The catalogue's own statements carry no blank nodes, so every statement
 * with one is the record's.
 */
export function catalogStatements(spec: HostedSpec): oxigraph.Store {
  const served = (s: HostedSpec): oxigraph.Store => parseJsonLd(jsonLd(buildCatalog([], [s])), CATALOG_IRI);
  const without = served({ ...spec, dcatJson: {} });
  const contributed = new oxigraph.Store();
  for (const q of served(spec).match(null, null, null, null)) if (!without.has(q)) contributed.add(q);
  return contributed;
}

/**
 * Subjects other than the spec (or its #fragments) that the record's embedded dataset node makes
 * statements about in /catalog. A nested node, an `@reverse` or an `@included` could otherwise put
 * triples about entries, releases or other specs into the catalogue. Blank nodes are local to the
 * record and pass; anything in a named graph is reported too.
 */
export function foreignSubjects(spec: HostedSpec): string[] {
  const foreign = new Set<string>();
  for (const q of catalogStatements(spec).match(null, null, null, null)) {
    if (q.graph.termType !== 'DefaultGraph') foreign.add(`graph ${q.graph.value}`);
    else if (q.subject.termType === 'NamedNode' && !aboutSpec(spec, q.subject.value)) foreign.add(q.subject.value);
  }
  return [...foreign].sort();
}

/**
 * Hosted content specifications (#135). This repo hosts what material-identity/schema generated
 * and does not re-validate content (design §7.2 step 4) — but it refuses to serve, as immutable,
 * a file that is not what it claims to be: JSON-LD that does not parse with an inline context, a
 * spec that is not marked as a proof of concept or not CC0, an id, version, act or version series
 * that disagrees with where it is served, a membership reference that is not pinned or a pin no
 * membership uses, a pin to an entry this dictionary has not published (or whose served bytes
 * differ from the pinned digest), or a DCAT record whose statements in /catalog leave a served file
 * without a matching checksum or are about a subject other than its spec.
 */
export function checkSpecs(load: SpecLoad, repo: RepoModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [...load.issues];
  const check = 'spec';
  const published = new Map(repo.published.filter((f) => f.doc).map((f) => [f.stem, f.doc!]));

  for (const spec of load.specs) {
    const file = `${spec.relDir}/${spec.act}.jsonld`;
    const add = (message: string, at = file): void => { issues.push({ check, file: at, message }); };
    const g = spec.graph;
    const s = `<${spec.iri}>`;
    const series = seriesIri(spec.act);

    if (!ask(g, `${s} a mi:ContentSpecification`)) add(`no node ${spec.iri} typed mi:ContentSpecification — the @id must be the IRI the spec is served at`);
    if (!exactly(g, spec.iri, 'adms:status', POC)) add('adms:status is not exactly mi:ProofOfConcept — every hosted specification is a proof of concept and must say so in-band');
    if (!exactly(g, spec.iri, 'dcterms:license', CC0)) add(`dcterms:license is not exactly CC0 (<${CC0}>)`);
    if (!ask(g, `${s} dcat:version "${spec.version}"`)) add(`dcat:version is not "${spec.version}", the version directory it is served from`);
    if (!ask(g, `${s} mi:act "${spec.act}"`)) add(`mi:act is not "${spec.act}", the act directory it is served from`);
    if (!exactly(g, spec.iri, 'dcat:isVersionOf', series)) add(`dcat:isVersionOf is not exactly <${series}>, the series /spec/${spec.act} lists it in`);

    // Every checksum stated for a pin is checked, so a second, conflicting digest fails too.
    const pins = distributionPins(g, spec.iri);
    if (pins.length === 0) add('pins no dictionary entry (dcterms:requires → dcat:Distribution with a dcat:downloadURL)');
    for (const pin of pins) {
      const uuid = defUuid(pin.url);
      const doc = uuid === undefined ? undefined : published.get(uuid);
      if (doc === undefined) {
        add(`pinned ${pin.url} is not an entry in published/`);
      } else if (pin.sha256 === undefined) {
        add(`pinned ${pin.url} carries no spdx:checksum — a pin without a digest is never publishable`);
      } else {
        const served = entrySha256(doc);
        if (pin.sha256 !== served) add(`pinned ${pin.url} has checksum ${pin.sha256}, but /def/${uuid} serves ${served}`);
      }
    }
    // The schema repo's rule, held here too: every reference is pinned, every pin is used. A
    // membership whose entry is unpinned is held to no digest; an unused pin is not a reference.
    const pinned = new Set(pins.map((p) => p.url));
    const used = membershipReferences(g);
    for (const ref of used) {
      if (!pinned.has(ref)) add(`membership reference ${ref} is not pinned in dcterms:requires — nothing holds that entry to a digest`);
    }
    for (const url of [...pinned].filter((u) => !used.includes(u))) {
      add(`pinned ${url} is used by no membership (sh:path, mi:itemType, mi:accessCategory) — every pin is a reference, or it is not a pin`);
    }

    // The record is checked as /catalog serves it, not as it parses on its own (catalogStatements).
    const dcatFile = `${spec.relDir}/${spec.act}.dcat.jsonld`;
    const d = catalogStatements(spec);
    if (embeddedDataset(spec) === undefined) add(`the DCAT record has no node for ${spec.iri}`, dcatFile);
    if (!ask(d, `${s} a dcat:Dataset`)) add(`the DCAT record does not describe ${spec.iri} as a dcat:Dataset`, dcatFile);
    if (!exactly(d, spec.iri, 'adms:status', POC)) add('the DCAT record does not mark the spec exactly mi:ProofOfConcept', dcatFile);
    if (!exactly(d, spec.iri, 'dcterms:license', CC0)) add(`the DCAT record's dcterms:license is not exactly CC0 (<${CC0}>)`, dcatFile);
    if (!exactly(d, spec.iri, 'dcat:isVersionOf', series)) add(`the DCAT record's dcat:isVersionOf is not exactly <${series}>`, dcatFile);
    // Every served file is a checksummed distribution, and every checksum stated for a distribution
    // matches the hosted bytes — not just one of them: the record is the only digest of the context
    // and the schemas, so a file it leaves out would be hosted with nothing holding it fixed.
    const served = spec.files.filter((f) => f.served !== undefined);
    const rows = select(d, `<${spec.iri}> dcat:distribution ?d . ?d dcat:downloadURL ?u . OPTIONAL { ?d spdx:checksum ?c . ?c spdx:checksumValue ?sum }`);
    const sums = new Map<string, Set<string | undefined>>();
    for (const r of rows) {
      const url = r.get('u')!.value;
      sums.set(url, (sums.get(url) ?? new Set()).add(r.get('sum')?.value));
    }
    for (const f of served) {
      if (!sums.has(f.url)) add(`the DCAT record lists no distribution of the hosted ${f.source} (dcat:downloadURL <${f.url}>)`, dcatFile);
    }
    for (const [url, values] of [...sums].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      const hosted = served.find((f) => f.url === url);
      if (hosted === undefined) { add(`distribution ${url} is not a file hosted for this spec`, dcatFile); continue; }
      for (const sum of [...values].sort()) {
        if (sum !== hosted.sha256) add(`distribution ${url} has checksum ${sum ?? '(none)'}, but the hosted ${hosted.source} hashes to ${hosted.sha256}`, dcatFile);
      }
    }
    for (const subject of foreignSubjects(spec)) {
      add(`the DCAT record states something about ${subject}, which is not this spec or one of its #fragments — /catalog takes only statements about the spec`, dcatFile);
    }
  }
  return issues;
}

/**
 * The two-phase rule (schema design §7.2): a spec pins a dictionary release that exists — a
 * `vYYYY.MM.DD` tag of this repository, named by `dcat:version` on the one `dcterms:requires`
 * dcat:Dataset at its `/release/<tag>` IRI — and that release already contains every entry it pins
 * (the entry first shipped in that release or an earlier one). `firstRelease` is getReleases():
 * published path → the first release that shipped it.
 */
export function checkSpecReleases(load: SpecLoad, repo: RepoModel, tags: Release[], firstRelease: Map<string, Release>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const check = 'spec release';
  const known = new Set(tags.map((t) => t.tag));
  const pathOf = new Map(repo.published.map((f) => [f.stem, f.relPath]));
  for (const spec of load.specs) {
    const add = (message: string): void => { issues.push({ check, file: `${spec.relDir}/${spec.act}.jsonld`, message }); };
    const releases = select(spec.graph, `<${spec.iri}> dcterms:requires ?r . ?r a dcat:Dataset . OPTIONAL { ?r dcat:version ?v }`)
      .map((r) => ({ iri: r.get('r')!.value, version: r.get('v')?.value }));
    const distinct = [...new Map(releases.map((r) => [`${r.iri} ${r.version ?? ''}`, r])).values()];
    if (distinct.length !== 1) {
      add(`pins ${distinct.length} dictionary releases — exactly one dcterms:requires dcat:Dataset with a dcat:version is required`);
      continue;
    }
    const [{ iri, version }] = distinct;
    if (version === undefined || !RELEASE_TAG.test(version) || iri !== releaseIri(version)) {
      add(`pinned release ${iri} (dcat:version ${version ?? '(none)'}) is not a vYYYY.MM.DD release at ${releaseIri(version ?? '<tag>')}`);
      continue;
    }
    if (!known.has(version)) {
      add(`pinned release ${version} is not a release tag of this repository`);
      continue;
    }
    for (const url of [...new Set(distributionPins(spec.graph, spec.iri).map((p) => p.url))]) {
      const uuid = defUuid(url);
      const path = uuid === undefined ? undefined : pathOf.get(uuid);
      if (path === undefined) continue; // reported by the spec check
      const shipped = firstRelease.get(path);
      if (!shippedBy(shipped, version)) {
        add(`pinned ${url} is not in release ${version} (${shipped === undefined ? 'not released yet' : `first shipped in ${shipped.tag}`}) — a spec pins entries of the release it names`);
      }
    }
  }
  return issues;
}

export interface CheckResult {
  name: string;
  issues: ValidationIssue[];
  /** Present when the check could not run (no git context) — reported, never silent. */
  skipped?: string;
}

/**
 * The pinned-release check needs the release tags and the history that says which release first
 * shipped each entry: skipped without a git context, and in a clone that carries no release tag
 * (a shallow checkout fetches none), rather than failing every pin for want of history.
 */
function releaseCheck(specs: SpecLoad, repo: RepoModel, hasGit: boolean): CheckResult {
  const name = 'spec — pinned dictionary release';
  if (specs.specs.length === 0) return { name, issues: [] };
  if (!hasGit) return { name, issues: [], skipped: 'no git context (base unresolvable or root is not a work-tree top level)' };
  const tags = getReleaseTags(repo.root);
  if (tags.length === 0) return { name, issues: [], skipped: 'no vYYYY.MM.DD release tag in this clone (shallow, or tags not fetched)' };
  return { name, issues: checkSpecReleases(specs, repo, tags, getReleases(repo.root)) };
}

/**
 * Run all validate.ts checks (1–6, plus the unnumbered hosted-spec and security.txt guards). Checks 1 and 6 need
 * a git context. Check 7 (two-yes gate) lives in CI only.
 */
export function runChecks(repo: RepoModel, git?: GitContext, horizonDays = 0): CheckResult[] {
  const noGit = 'no git context (base unresolvable or root is not a work-tree top level)';
  const specs = loadSpecs(repo.root);
  return [
    { name: 'load', issues: repo.errors },
    git
      ? { name: 'check 1 — immutability', issues: checkImmutability(git.diff) }
      : { name: 'check 1 — immutability', issues: [], skipped: noGit },
    { name: 'check 2 — schema', issues: checkSchema(repo) },
    { name: 'check 3 — identity', issues: checkIdentity(repo) },
    { name: 'check 4 — replaces', issues: checkReplaces(repo) },
    { name: 'check 5 — pinning', issues: checkPinning(repo) },
    // Unnumbered like security.txt: 1–6 are the entry rules. Hosted specs ride on check 1 (add-only).
    { name: 'spec — hosted content specifications', issues: checkSpecs(specs, repo) },
    releaseCheck(specs, repo, git !== undefined),
    git
      ? { name: 'check 6 — move purity', issues: checkMovePurity(repo, git) }
      : { name: 'check 6 — move purity', issues: [], skipped: noGit },
    // Deliberately unnumbered: 1–6 are the entry rules and 7 is the CI two-yes gate. This one
    // guards the repo's own security contact, not the dictionary (#109).
    { name: 'security.txt — RFC 9116 freshness', issues: checkSecurityTxt(repo.root, new Date(), horizonDays) },
    { name: 'pgp-key — expiry', issues: checkPgpKey(repo.root, new Date(), horizonDays) },
  ];
}
