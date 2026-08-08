import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import Ajv2019Module from 'ajv/dist/2019.js';
import addFormatsModule from 'ajv-formats';
import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import { DEF_PREFIX, type RepoFile, type RepoModel, type ValidationIssue } from './repo.ts';
import type { DiffEntry, GitContext } from './git.ts';

// ajv/ajv-formats ship CJS; under native ESM the class may sit on .default or be the export itself.
const Ajv2019 = (Ajv2019Module as unknown as { default?: typeof Ajv2019Module }).default ?? Ajv2019Module;
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'dictionary-entry.schema.json');

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
      message: `published file ${verb} — published/ is add-only (R6); publish a new entry with replaces instead`,
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

export interface CheckResult {
  name: string;
  issues: ValidationIssue[];
  /** Present when the check could not run (no git context) — reported, never silent. */
  skipped?: string;
}

/** Run all validate.ts checks (1–6). Checks 1 and 6 need a git context. Check 7 (two-yes gate) lives in CI only. */
export function runChecks(repo: RepoModel, git?: GitContext): CheckResult[] {
  const noGit = 'no git context (base unresolvable or root is not a work-tree top level)';
  return [
    { name: 'load', issues: repo.errors },
    git
      ? { name: 'check 1 — immutability', issues: checkImmutability(git.diff) }
      : { name: 'check 1 — immutability', issues: [], skipped: noGit },
    { name: 'check 2 — schema', issues: checkSchema(repo) },
    { name: 'check 3 — identity', issues: checkIdentity(repo) },
    { name: 'check 4 — replaces', issues: checkReplaces(repo) },
    { name: 'check 5 — pinning', issues: checkPinning(repo) },
    git
      ? { name: 'check 6 — move purity', issues: checkMovePurity(repo, git) }
      : { name: 'check 6 — move purity', issues: [], skipped: noGit },
  ];
}
