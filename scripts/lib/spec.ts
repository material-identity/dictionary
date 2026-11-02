/**
 * Hosted DPP content specifications (#135; schema repo docs/design/content-spec-jsonld.md).
 *
 * material-identity/schema GENERATES a specification; this repo only HOSTS it, byte-identical.
 * The source tree is `spec/<act>/<version>/`, add-only like published/ (check 1), holding exactly
 * the files the hand-over carries. The build copies them under the names the Worker maps the
 * canonical IRIs onto, so nothing here ever rewrites a byte.
 *
 * Reading is through oxigraph — already a dependency for the Turtle tests — with no document
 * loader: a remote `@context` fails to load, which is exactly the design's rule that a spec's own
 * context is inline (§2.3), so the digest covers its complete meaning.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import oxigraph from 'oxigraph';
import { CANONICAL_BASE, type ValidationIssue } from './repo.ts';

export const SPEC_ROOT = 'spec';
export const ACT_PATTERN = /^[a-z][a-z0-9-]*$/;
export const VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;

const SH = 'http://www.w3.org/ns/shacl#';
const MI = 'https://material-identity.eu/ns#';
const DCAT = 'http://www.w3.org/ns/dcat#';
const DCTERMS = 'http://purl.org/dc/terms/';
const SPDX = 'http://spdx.org/rdf/terms#';
const ADMS = 'http://www.w3.org/ns/adms#';

export const PREFIXES = `PREFIX sh: <${SH}> PREFIX mi: <${MI}> PREFIX dcat: <${DCAT}> PREFIX dcterms: <${DCTERMS}> PREFIX spdx: <${SPDX}> PREFIX adms: <${ADMS}> `;

export type SpecRole = 'spec' | 'context' | 'dcat' | 'compressed' | 'full';

/** One handed-over file and, if it is served on its own, the URL and origin name it is served as. */
export interface SpecFile {
  role: SpecRole;
  /** Name in the hand-over and in `spec/<act>/<version>/`. */
  source: string;
  /** Name below `site/spec/<act>/<version>/`; undefined for the DCAT record, which /catalog serves. */
  served?: string;
  /** Canonical URL; for the DCAT record, the catalogue it is merged into. */
  url: string;
  mediaType: string;
  bytes: Buffer;
  sha256: string;
}

export interface HostedSpec {
  act: string;
  version: string;
  /** `https://material-identity.eu/spec/<act>/<version>` */
  iri: string;
  /** `spec/<act>/<version>` */
  relDir: string;
  files: SpecFile[];
  /** The specification's RDF (its own document only). */
  graph: oxigraph.Store;
  /** The DCAT record as JSON (merged into /catalog as written) and as RDF (checked). */
  dcatJson: Record<string, unknown>;
  dcatGraph: oxigraph.Store;
}

export interface SpecLoad {
  specs: HostedSpec[];
  issues: ValidationIssue[];
}

export const specIri = (act: string, version: string): string => `${CANONICAL_BASE}/spec/${act}/${version}`;

/** The hand-over, file by file (design §7.2 step 3), and where each one is served. */
function layout(act: string, iri: string): Array<Omit<SpecFile, 'bytes' | 'sha256'>> {
  return [
    { role: 'spec', source: `${act}.jsonld`, served: 'index.jsonld', url: iri, mediaType: 'application/ld+json' },
    { role: 'context', source: `${act}.context.jsonld`, served: 'context.jsonld', url: `${iri}/context.jsonld`, mediaType: 'application/ld+json' },
    { role: 'dcat', source: `${act}.dcat.jsonld`, url: `${CANONICAL_BASE}/catalog`, mediaType: 'application/ld+json' },
    { role: 'compressed', source: 'compressed.schema.json', served: 'compressed.schema.json', url: `${iri}/compressed.schema.json`, mediaType: 'application/schema+json' },
    { role: 'full', source: 'full.schema.json', served: 'full.schema.json', url: `${iri}/full.schema.json`, mediaType: 'application/schema+json' },
  ];
}

/** Parse JSON-LD with no document loader: remote contexts fail, as they must (design §2.3). */
export function parseJsonLd(text: string, base: string): oxigraph.Store {
  const store = new oxigraph.Store();
  store.load(text, { format: 'application/ld+json', base_iri: base });
  return store;
}

const dirs = (abs: string): string[] => readdirSync(abs).sort();
const isDir = (abs: string): boolean => statSync(abs).isDirectory();

/**
 * Every `spec/<act>/<version>/`, sorted by act then version. Structural problems (names, missing or
 * extra files, unparseable JSON or JSON-LD) are returned as issues and the directory is skipped.
 */
export function loadSpecs(root: string): SpecLoad {
  const specs: HostedSpec[] = [];
  const issues: ValidationIssue[] = [];
  const check = 'spec layout';
  const base = join(root, SPEC_ROOT);
  if (!existsSync(base)) return { specs, issues };

  for (const act of dirs(base)) {
    const actAbs = join(base, act);
    if (!isDir(actAbs) || !ACT_PATTERN.test(act)) {
      issues.push({ check, file: `${SPEC_ROOT}/${act}`, message: `not an act directory (expected ${ACT_PATTERN})` });
      continue;
    }
    for (const version of dirs(actAbs).sort(compareVersions)) {
      const relDir = `${SPEC_ROOT}/${act}/${version}`;
      const abs = join(actAbs, version);
      if (!isDir(abs) || !VERSION_PATTERN.test(version)) {
        issues.push({ check, file: relDir, message: `not a version directory (expected ${VERSION_PATTERN})` });
        continue;
      }
      const iri = specIri(act, version);
      const expected = layout(act, iri);
      const present = new Set(dirs(abs));
      const before = issues.length;
      for (const f of expected) {
        if (!present.has(f.source)) issues.push({ check, file: `${relDir}/${f.source}`, message: 'missing from the hand-over' });
      }
      for (const name of present) {
        if (!expected.some((f) => f.source === name)) issues.push({ check, file: `${relDir}/${name}`, message: 'not part of a content-specification hand-over' });
      }
      if (issues.length > before) continue;

      const files: SpecFile[] = expected.map((f) => {
        const bytes = readFileSync(join(abs, f.source));
        return { ...f, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
      });
      const parsed = new Map<SpecRole, { json: unknown; graph?: oxigraph.Store }>();
      for (const f of files) {
        const text = f.bytes.toString('utf8');
        try {
          const json: unknown = JSON.parse(text);
          parsed.set(f.role, { json, graph: f.source.endsWith('.jsonld') ? parseJsonLd(text, f.url) : undefined });
        } catch (err) {
          issues.push({ check, file: `${relDir}/${f.source}`, message: `does not parse as ${f.source.endsWith('.jsonld') ? 'JSON-LD' : 'JSON'}: ${(err as Error).message}` });
        }
      }
      if (issues.length > before) continue;
      const dcatJson = parsed.get('dcat')!.json;
      if (!dcatJson || typeof dcatJson !== 'object' || Array.isArray(dcatJson)) {
        issues.push({ check, file: `${relDir}/${act}.dcat.jsonld`, message: 'the DCAT record is not a JSON object' });
        continue;
      }
      specs.push({
        act, version, iri, relDir, files,
        graph: parsed.get('spec')!.graph!,
        dcatJson: dcatJson as Record<string, unknown>,
        dcatGraph: parsed.get('dcat')!.graph!,
      });
    }
  }
  return { specs, issues };
}

/** `v0.0.10` after `v0.0.9`: numeric, not lexical. Non-versions sort after, by name. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] | undefined => (VERSION_PATTERN.test(v) ? v.slice(1).split('.').map(Number) : undefined);
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return pa ? -1 : pb ? 1 : a.localeCompare(b, 'en');
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// ------------------------------------------------------------------ reading a spec

type Value = oxigraph.NamedNode | oxigraph.BlankNode | oxigraph.Literal;
type Row = Map<string, Value>;

export function select(store: oxigraph.Store, where: string): Row[] {
  return store.query(`${PREFIXES} SELECT * WHERE { ${where} }`) as unknown as Row[];
}

export function ask(store: oxigraph.Store, where: string): boolean {
  return store.query(`${PREFIXES} ASK { ${where} }`) as unknown as boolean;
}

/** Literal values of one predicate on one subject, keyed by language tag ('' when untagged). */
function langValues(store: oxigraph.Store, subject: string, predicate: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rows = select(store, `<${subject}> ${predicate} ?v`).sort((a, b) => a.get('v')!.value.localeCompare(b.get('v')!.value, 'en'));
  for (const row of rows) {
    const v = row.get('v')!;
    const key = v.termType === 'Literal' ? (v as oxigraph.Literal).language : '';
    if (out[key] === undefined) out[key] = v.value;
  }
  return out;
}

function one(store: oxigraph.Store, subject: string, predicate: string): string | undefined {
  return select(store, `<${subject}> ${predicate} ?v`).map((r) => r.get('v')!.value).sort()[0];
}

export interface Pin {
  /** `dcat:downloadURL` — the pinned entry IRI. */
  url: string;
  sha256?: string;
}

/** `dcterms:requires` → distributions (pinned entries) of the subject. */
export function distributionPins(store: oxigraph.Store, subject: string, predicate = 'dcterms:requires'): Pin[] {
  const rows = select(store, `<${subject}> ${predicate} ?d . ?d dcat:downloadURL ?u . OPTIONAL { ?d spdx:checksum ?c . ?c spdx:checksumValue ?sum }`);
  const pins = new Map<string, Pin>();
  for (const row of rows) {
    const url = row.get('u')!.value;
    const sha256 = row.get('sum')?.value;
    if (!pins.has(url) || (sha256 !== undefined && pins.get(url)!.sha256 === undefined)) pins.set(url, { url, sha256 });
  }
  return [...pins.values()].sort((a, b) => a.url.localeCompare(b.url, 'en'));
}

export interface Membership {
  /** Dotted element-id path from the root, e.g. `nominalDimensions.nominalThickness`. */
  path: string[];
  /** The dictionary entry: `sh:path` when it is an IRI, else the list item's `mi:itemType`. */
  entry?: string;
  mandatory: boolean;
  accessCategory?: string;
  condition?: string;
}

export interface SpecSummary {
  title: Record<string, string>;
  description: Record<string, string>;
  version?: string;
  issued?: string;
  license?: string;
  status?: string;
  series?: string;
  conformsTo?: string;
  dppSchemaVersion?: string;
  passportContext?: string;
  releases: Array<{ iri: string; version?: string }>;
  pins: Pin[];
  memberships: Membership[];
}

/** What the HTML, the series index and the catalogue say about a spec — read from its RDF. */
export function summarize(spec: HostedSpec): SpecSummary {
  const g = spec.graph;
  const s = spec.iri;
  const releases = select(g, `<${s}> dcterms:requires ?r . ?r a dcat:Dataset . OPTIONAL { ?r dcat:version ?v }`)
    .map((r) => ({ iri: r.get('r')!.value, version: r.get('v')?.value }))
    .sort((a, b) => a.iri.localeCompare(b.iri, 'en'));
  return {
    title: langValues(g, s, 'dcterms:title'),
    description: langValues(g, s, 'dcterms:description'),
    version: one(g, s, 'dcat:version'),
    issued: one(g, s, 'dcterms:issued'),
    license: one(g, s, 'dcterms:license'),
    status: one(g, s, 'adms:status'),
    series: one(g, s, 'dcat:isVersionOf'),
    conformsTo: one(g, s, 'dcterms:conformsTo'),
    dppSchemaVersion: one(g, s, 'mi:dppSchemaVersion'),
    passportContext: one(g, s, 'mi:passportContext'),
    releases: releases.filter((r, i) => i === 0 || r.iri !== releases[i - 1].iri),
    pins: distributionPins(g, s),
    memberships: memberships(g, s),
  };
}

/**
 * Memberships depth-first in `sh:order` (design §3.2: array position is not significant in RDF).
 * A membership is any property shape with an `mi:elementId`; its children sit under its `sh:node`.
 */
function memberships(g: oxigraph.Store, root: string): Membership[] {
  const rows = select(g, `
    { <${root}> sh:property ?p . BIND(<${root}> AS ?parent) } UNION { ?parent sh:node ?n . ?n sh:property ?p }
    ?p mi:elementId ?id .
    OPTIONAL { ?p sh:path ?path FILTER(isIRI(?path)) }
    OPTIONAL { ?p mi:itemType ?item }
    OPTIONAL { ?p sh:order ?order }
    OPTIONAL { ?p sh:minCount ?min }
    OPTIONAL { ?p mi:accessCategory ?access }
    OPTIONAL { ?p mi:condition ?cond FILTER(langMatches(lang(?cond), "en")) }`);
  const key = (t: Value): string => `${t.termType}:${t.value}`;
  interface Node { key: string; id: string; order: number; m: Omit<Membership, 'path'> }
  const children = new Map<string, Node[]>();
  const seen = new Set<string>();
  for (const r of rows) {
    const k = key(r.get('p')!);
    if (seen.has(k)) continue;
    seen.add(k);
    const parent = key(r.get('parent')!);
    const node: Node = {
      key: k,
      id: r.get('id')!.value,
      order: Number(r.get('order')?.value ?? Number.MAX_SAFE_INTEGER),
      m: {
        entry: r.get('path')?.value ?? r.get('item')?.value,
        mandatory: Number(r.get('min')?.value ?? 0) >= 1,
        accessCategory: r.get('access')?.value,
        condition: r.get('cond')?.value,
      },
    };
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const out: Membership[] = [];
  const walk = (parentKey: string, path: string[], visiting: Set<string>): void => {
    const list = [...(children.get(parentKey) ?? [])].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, 'en'));
    for (const n of list) {
      if (visiting.has(n.key)) continue; // a shape graph may be cyclic; a table may not
      out.push({ path: [...path, n.id], ...n.m });
      walk(n.key, [...path, n.id], new Set([...visiting, n.key]));
    }
  };
  walk(`NamedNode:${root}`, [], new Set());
  return out;
}
