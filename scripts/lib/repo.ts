import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/** Canonical identifier authority (plan §2.3; domain amendment 2026-08-05). */
export const CANONICAL_BASE = 'https://material-identity.eu';
export const DEF_PREFIX = `${CANONICAL_BASE}/def/`;
export const CONCEPT_PREFIX = `${CANONICAL_BASE}/concept/`;

export type RepoDir = 'drafts' | 'published' | 'concepts';

export interface RepoFile {
  dir: RepoDir;
  /** Filename including extension, e.g. `<uuid>.yaml`. */
  name: string;
  /** Filename without the `.yaml` extension. */
  stem: string;
  /** Path relative to the repo root, e.g. `published/<uuid>.yaml`. */
  relPath: string;
  /** Parsed YAML document; undefined when parsing failed (see RepoModel.errors). */
  doc: Record<string, unknown> | undefined;
}

export interface ValidationIssue {
  check: string;
  file: string;
  message: string;
}

export interface RepoModel {
  root: string;
  drafts: RepoFile[];
  published: RepoFile[];
  concepts: RepoFile[];
  /** Load-time problems (unparseable YAML, non-object documents). */
  errors: ValidationIssue[];
}

function loadDir(root: string, dir: RepoDir, errors: ValidationIssue[]): RepoFile[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const files: RepoFile[] = [];
  for (const name of readdirSync(abs).sort()) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue;
    const relPath = `${dir}/${name}`;
    const stem = name.replace(/\.ya?ml$/, '');
    let doc: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = parse(readFileSync(join(abs, name), 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push({ check: 'load', file: relPath, message: 'document is not a YAML mapping' });
      } else {
        doc = parsed as Record<string, unknown>;
      }
    } catch (err) {
      errors.push({ check: 'load', file: relPath, message: `YAML parse error: ${(err as Error).message}` });
    }
    files.push({ dir, name, stem, relPath, doc });
  }
  return files;
}

/** Load drafts/, published/, concepts/ into the single in-memory model all checks and the build consume. */
export function loadRepo(root: string): RepoModel {
  const errors: ValidationIssue[] = [];
  return {
    root,
    drafts: loadDir(root, 'drafts', errors),
    published: loadDir(root, 'published', errors),
    concepts: loadDir(root, 'concepts', errors),
    errors,
  };
}
