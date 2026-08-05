#!/usr/bin/env tsx
// All checks runnable locally: npm run validate [-- --root <dir>]
// M1 scope: load + checks 2–5. Checks 1, 6, 7 land in M2 (issues #10–#12); check 8 lives in CI only.
import { pathToFileURL } from 'node:url';
import { loadRepo } from './lib/repo.ts';
import { runChecks } from './lib/checks.ts';

export interface ValidationRun {
  ok: boolean;
  lines: string[];
}

export function runValidation(root: string): ValidationRun {
  const results = runChecks(loadRepo(root));
  const lines: string[] = [];
  let ok = true;
  for (const { name, issues } of results) {
    if (issues.length === 0) {
      lines.push(`ok      ${name}`);
    } else {
      ok = false;
      lines.push(`FAIL    ${name}`);
      for (const issue of issues) lines.push(`        ${issue.file}: ${issue.message}`);
    }
  }
  return { ok, lines };
}

function main(): void {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf('--root');
  const root = rootFlag !== -1 && args[rootFlag + 1] ? args[rootFlag + 1] : process.cwd();
  const { ok, lines } = runValidation(root);
  for (const line of lines) console.log(line);
  if (!ok) {
    console.error('\nvalidate: FAILED');
    process.exitCode = 1;
  } else {
    console.log('\nvalidate: OK');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
