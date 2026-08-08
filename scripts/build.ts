#!/usr/bin/env tsx
// Build (plan §4 M3, redesigned per issue #57): repo model → site/ — canonical JSON +
// human HTML per entry, one stylesheet. Deterministic transform, no network, content
// never altered. Usage: npm run build [-- --root <dir>] [-- --out <dir>]
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRepo } from './lib/repo.ts';
import { canonicalJson } from './lib/emit.ts';
import { RefIndex, renderEntryPage, renderIndexPages } from './lib/render.ts';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));

export interface BuildResult {
  entries: number;
  out: string;
}

export function build(root: string, out: string): BuildResult {
  const repo = loadRepo(root);
  if (repo.errors.length > 0) {
    const detail = repo.errors.map((e) => `${e.file}: ${e.message}`).join('\n');
    throw new Error(`refusing to build from an unloadable repo:\n${detail}`);
  }
  const refs = new RefIndex(repo);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'def'), { recursive: true });
  cpSync(join(LIB_DIR, 'lib', 'styles.css'), join(out, 'styles.css'));

  let entries = 0;
  for (const file of repo.published) {
    if (!file.doc) continue;
    writeFileSync(join(out, 'def', `${file.stem}.json`), canonicalJson(file.doc));
    writeFileSync(join(out, 'def', `${file.stem}.html`), renderEntryPage(file, repo, refs));
    entries += 1;
  }
  for (const page of renderIndexPages(repo, refs)) {
    writeFileSync(join(out, page.name), page.html);
  }
  return { entries, out };
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const root = flagValue(args, '--root') ?? process.cwd();
  const out = flagValue(args, '--out') ?? join(root, 'site');
  const result = build(root, out);
  console.log(`built ${result.entries} entries into ${result.out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
