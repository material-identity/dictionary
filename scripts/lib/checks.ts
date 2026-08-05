import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2019Module from 'ajv/dist/2019.js';
import addFormatsModule from 'ajv-formats';

// ajv/ajv-formats ship CJS; under native ESM the class may sit on .default or be the export itself.
const Ajv2019 = (Ajv2019Module as unknown as { default?: typeof Ajv2019Module }).default ?? Ajv2019Module;
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import { CONCEPT_PREFIX, DEF_PREFIX, type RepoFile, type RepoModel, type ValidationIssue } from './repo.ts';

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

export interface CheckResult {
  name: string;
  issues: ValidationIssue[];
}

/** Run all M1 checks (2–5) plus load errors. Checks 1, 6, 7, 8 land in M2. */
export function runChecks(repo: RepoModel): CheckResult[] {
  return [
    { name: 'load', issues: repo.errors },
    { name: 'check 2 — schema', issues: checkSchema(repo) },
    { name: 'check 3 — identity', issues: checkIdentity(repo) },
    { name: 'check 4 — version chain', issues: checkVersionChain(repo) },
    { name: 'check 5 — pinning', issues: checkPinning(repo) },
  ];
}
