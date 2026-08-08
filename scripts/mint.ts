#!/usr/bin/env tsx
// Minting helper for publish-entry (plan §2.6, §4 M5): mint a UUIDv4, move
// drafts/<shortName>.yaml -> published/<uuid>.yaml, rewriting only `id`.
// Everything else about the file is untouched — check 6 (move purity) depends on that.
// Usage: npm run mint -- drafts/<shortName>.yaml
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { randomUUID } from 'node:crypto';
import { DEF_PREFIX } from './lib/repo.ts';

export function mint(draftPath: string): { uuid: string; publishedPath: string } {
  if (!existsSync(draftPath)) throw new Error(`no such draft: ${draftPath}`);
  const raw = readFileSync(draftPath, 'utf8');
  const doc = parse(raw) as Record<string, unknown>;
  if (typeof doc !== 'object' || doc === null) throw new Error(`${draftPath} is not a YAML mapping`);

  const uuid = randomUUID();
  const publishedPath = join('published', `${uuid}.yaml`);
  // Rewrite only the id line so the rest of the file — comments included — survives untouched;
  // re-serializing the whole document would strip comments and could reorder keys unnecessarily.
  const idLine = /^id:\s*.*$/m;
  if (!idLine.test(raw)) throw new Error(`${draftPath} has no top-level "id:" line to rewrite`);
  const rewritten = raw.replace(idLine, `id: ${DEF_PREFIX}${uuid}`);

  mkdirSync('published', { recursive: true });
  writeFileSync(publishedPath, rewritten);
  return { uuid, publishedPath };
}

function main(): void {
  const draftPath = process.argv[2];
  if (!draftPath) {
    console.error('usage: npm run mint -- drafts/<shortName>.yaml');
    process.exitCode = 1;
    return;
  }
  const { uuid, publishedPath } = mint(draftPath);
  console.log(`minted ${uuid}`);
  console.log(`wrote ${publishedPath} — now: git rm ${draftPath}, then git add and open the publish PR`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
