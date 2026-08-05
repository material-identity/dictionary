import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2019Module from 'ajv/dist/2019.js';
import addFormatsModule from 'ajv-formats';

// ajv/ajv-formats ship CJS; under native ESM the class may sit on .default or be the export itself.
const Ajv2019 = (Ajv2019Module as unknown as { default?: typeof Ajv2019Module }).default ?? Ajv2019Module;
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import { parse } from 'yaml';
import { CONCEPT_PREFIX, DEF_PREFIX, type RepoFile, type RepoModel, type ValidationIssue } from './repo.ts';
import type { DiffEntry, GitContext } from './git.ts';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'dictionary-entry.schema.json');

/**
 * Internal references that must be version-pinned to a published file (R5, plan §2.3).
 * Exempt by design: isVersionOf (names the concept), isDefinedBy (names the dictionary).
 */
const PINNED_URI_FIELDS = ['unit', 'quantityKind', 'coherentSiUnit', 'itemType'] as const;

function defUuid(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith(DEF_PREFIX)) return undefined;
  const rest = uri.slice(DEF_PREFIX.length);
  return rest.includes('/') ? undefined : rest;
}

function conceptUuid(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith(CONCEPT_PREFIX)) return undefined;
  const rest = uri.slice(CONCEPT_PREFIX.length);
  return rest.includes('/') ? undefined : rest;
}

/** Check 2 — every published/ file and every drafts/ file validates against the envelope schema. */
export function checkSchema(repo: RepoModel): ValidationIssue[] {
  const ajv = new Ajv2019({ allErrors: true, strict: false });
  addFormats(ajv);
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

/** Check 4 — isVersionOf resolves to a concept file, version unique per concept, replaces resolves within the concept. */
export function checkVersionChain(repo: RepoModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const check = '4 version-chain';
  const conceptFiles = new Set(repo.concepts.map((f) => f.stem));
  const publishedByUuid = new Map<string, RepoFile>(repo.published.map((f) => [f.stem, f]));
  const versionsPerConcept = new Map<string, Map<string, string>>();

  for (const file of repo.published) {
    if (!file.doc) continue;
    const isVersionOf = file.doc.isVersionOf;

    const cUuid = conceptUuid(isVersionOf);
    if (cUuid === undefined) {
      issues.push({ check, file: file.relPath, message: `isVersionOf "${String(isVersionOf)}" is not canonical (${CONCEPT_PREFIX}<uuid>)` });
    } else if (!conceptFiles.has(cUuid)) {
      issues.push({ check, file: file.relPath, message: `isVersionOf points to missing concept file concepts/${cUuid}.yaml` });
    }

    const version = file.doc.version;
    if (typeof isVersionOf === 'string' && typeof version === 'string') {
      let versions = versionsPerConcept.get(isVersionOf);
      if (!versions) versionsPerConcept.set(isVersionOf, (versions = new Map()));
      const other = versions.get(version);
      if (other !== undefined) {
        issues.push({ check, file: file.relPath, message: `version "${version}" already used by ${other} for the same concept` });
      } else {
        versions.set(version, file.relPath);
      }
    }

    const replaces = file.doc.replaces;
    if (replaces !== undefined) {
      const rUuid = defUuid(replaces);
      const target = rUuid === undefined ? undefined : publishedByUuid.get(rUuid);
      if (!target?.doc) {
        issues.push({ check, file: file.relPath, message: `replaces "${String(replaces)}" does not resolve to a published entry` });
      } else if (target.doc.isVersionOf !== isVersionOf) {
        issues.push({ check, file: file.relPath, message: `replaces "${String(replaces)}" belongs to a different concept` });
      }
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
        if (el && typeof el === 'object') requirePinned(file, `elements[${i}].dictionaryReference`, (el as Record<string, unknown>).dictionaryReference);
      });
    }
  }
  return issues;
}

/** Check 1 — immutability (R6): only additions are allowed under published/. */
export function checkImmutability(diff: DiffEntry[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const entry of diff) {
    if (!entry.path.startsWith('published/')) continue;
    if (entry.status === 'A') continue;
    const verb = entry.status === 'D' ? 'deleted' : entry.status === 'M' ? 'modified' : `changed (${entry.status})`;
    issues.push({
      check: '1 immutability',
      file: entry.path,
      message: `published file ${verb} — published/ is add-only (R6); publish a new version instead`,
    });
  }
  return issues;
}

interface VersionRecord {
  entry?: unknown;
  version?: unknown;
  status?: unknown;
  replacedBy?: unknown;
}

const STATUS_RANK: Record<string, number> = { active: 0, deprecated: 1, tombstoned: 2 };

function conceptRecords(doc: Record<string, unknown>): VersionRecord[] {
  return Array.isArray(doc.versions) ? (doc.versions as VersionRecord[]) : [];
}

/**
 * Check 6 — concept consistency. Static rules always run; the append-only rules
 * (records never removed, transitions forward-only) need the base version via git.
 */
export function checkConceptConsistency(repo: RepoModel, git?: GitContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const check = '6 concept-consistency';
  const publishedById = new Map(repo.published.filter((f) => f.doc).map((f) => [String(f.doc!.id), f]));

  for (const concept of repo.concepts) {
    if (!concept.doc) continue;
    const conceptUri = `${CONCEPT_PREFIX}${concept.stem}`;
    const records = conceptRecords(concept.doc);
    if (!Array.isArray(concept.doc.versions)) {
      issues.push({ check, file: concept.relPath, message: 'versions[] missing or not a list' });
    }

    // every published version of this concept appears exactly once in versions[]
    const counts = new Map<string, number>();
    for (const rec of records) counts.set(String(rec.entry), (counts.get(String(rec.entry)) ?? 0) + 1);
    for (const entry of repo.published) {
      if (!entry.doc || entry.doc.isVersionOf !== conceptUri) continue;
      const n = counts.get(String(entry.doc.id)) ?? 0;
      if (n !== 1) {
        issues.push({ check, file: concept.relPath, message: `published version ${String(entry.doc.id)} appears ${n} times in versions[] (must be exactly once)` });
      }
    }

    // records resolve to published entries of this concept, with matching version
    for (const rec of records) {
      const target = publishedById.get(String(rec.entry));
      if (!target?.doc) {
        issues.push({ check, file: concept.relPath, message: `versions[] entry "${String(rec.entry)}" does not resolve to a published file` });
        continue;
      }
      if (target.doc.isVersionOf !== conceptUri) {
        issues.push({ check, file: concept.relPath, message: `versions[] entry "${String(rec.entry)}" belongs to a different concept` });
      }
      if (String(rec.version) !== String(target.doc.version)) {
        issues.push({ check, file: concept.relPath, message: `versions[] record for "${String(rec.entry)}" says version "${String(rec.version)}" but the entry says "${String(target.doc.version)}"` });
      }
      if (rec.status === 'tombstoned' && rec.replacedBy === undefined) {
        issues.push({ check, file: concept.relPath, message: `tombstoned record "${String(rec.entry)}" has no replacedBy` });
      }
      if (typeof rec.status === 'string' && !(rec.status in STATUS_RANK)) {
        issues.push({ check, file: concept.relPath, message: `record "${String(rec.entry)}" has unknown status "${rec.status}"` });
      }
    }

    // exactly one active; currentVersion exists and is that active record
    const active = records.filter((r) => r.status === 'active');
    if (active.length !== 1) {
      issues.push({ check, file: concept.relPath, message: `expected exactly one active version, found ${active.length}` });
    }
    const current = concept.doc.currentVersion;
    if (current === undefined) {
      issues.push({ check, file: concept.relPath, message: 'currentVersion missing' });
    } else if (!records.some((r) => String(r.entry) === String(current) && r.status === 'active')) {
      issues.push({ check, file: concept.relPath, message: `currentVersion "${String(current)}" is not an active record in versions[]` });
    }
  }

  // append-only rules against the base (needs git)
  if (git) {
    for (const entry of git.diff) {
      if (!entry.path.startsWith('concepts/')) continue;
      if (entry.status === 'D') {
        issues.push({ check, file: entry.path, message: 'concept file deleted — concept resources are append-only' });
        continue;
      }
      if (entry.status !== 'M') continue;
      const baseText = git.readBaseFile(entry.path);
      if (baseText === undefined) continue;
      let baseDoc: Record<string, unknown>;
      try {
        baseDoc = parse(baseText) as Record<string, unknown>;
      } catch {
        continue; // base was unparseable; nothing to compare against
      }
      const current = repo.concepts.find((f) => f.relPath === entry.path);
      if (!current?.doc) continue;
      const newRecords = new Map(conceptRecords(current.doc).map((r) => [String(r.entry), r]));
      for (const oldRec of conceptRecords(baseDoc)) {
        const newRec = newRecords.get(String(oldRec.entry));
        if (!newRec) {
          issues.push({ check, file: entry.path, message: `version record "${String(oldRec.entry)}" was removed — versions[] is append-only` });
          continue;
        }
        const oldRank = STATUS_RANK[String(oldRec.status)] ?? 0;
        const newRank = STATUS_RANK[String(newRec.status)] ?? 0;
        if (newRank < oldRank) {
          issues.push({ check, file: entry.path, message: `record "${String(oldRec.entry)}" moved backward ${String(oldRec.status)} → ${String(newRec.status)} (transitions are forward-only)` });
        }
      }
    }
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
 * Check 7 — move purity: a draft deleted while published files are added must reappear
 * as one of those published files, content-identical apart from the minted id.
 * Deleting a draft without publishing anything is a legitimate withdrawal.
 */
export function checkMovePurity(repo: RepoModel, git: GitContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const check = '7 move-purity';
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

export interface CheckResult {
  name: string;
  issues: ValidationIssue[];
  /** Present when the check could not run (no git context) — reported, never silent. */
  skipped?: string;
}

/** Run all validate.ts checks (1–7). Checks 1, 6 (append-only rules), 7 need a git context. Check 8 lives in CI. */
export function runChecks(repo: RepoModel, git?: GitContext): CheckResult[] {
  const noGit = 'no git context (base unresolvable or root is not a work-tree top level)';
  return [
    { name: 'load', issues: repo.errors },
    git
      ? { name: 'check 1 — immutability', issues: checkImmutability(git.diff) }
      : { name: 'check 1 — immutability', issues: [], skipped: noGit },
    { name: 'check 2 — schema', issues: checkSchema(repo) },
    { name: 'check 3 — identity', issues: checkIdentity(repo) },
    { name: 'check 4 — version chain', issues: checkVersionChain(repo) },
    { name: 'check 5 — pinning', issues: checkPinning(repo) },
    { name: 'check 6 — concept consistency', issues: checkConceptConsistency(repo, git) },
    git
      ? { name: 'check 7 — move purity', issues: checkMovePurity(repo, git) }
      : { name: 'check 7 — move purity', issues: [], skipped: noGit },
  ];
}
