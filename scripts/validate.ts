#!/usr/bin/env tsx
// All checks runnable locally: npm run validate [-- --root <dir>] [-- --base <ref>] [-- --horizon-days <n>]
// Checks 1, 6 (append-only rules), 7 diff against <base> (default: main; CI passes the
// PR base SHA). Check 8 (two-yes gate) lives in pr-checks.yml — it needs the GitHub API.
import { pathToFileURL } from 'node:url';
import { loadRepo } from './lib/repo.ts';
import { runChecks } from './lib/checks.ts';
import { createGitContext, isGitContext } from './lib/git.ts';

export interface ValidateOptions {
  base?: string;
  /** Also fail expiry checks that fall due within this many days (the scheduled watch uses it). */
  horizonDays?: number;
}

export interface ValidationRun {
  ok: boolean;
  lines: string[];
}

export function runValidation(root: string, options: ValidateOptions = {}): ValidationRun {
  const repo = loadRepo(root);
  const ctx = createGitContext(root, options.base ?? 'main');
  const git = isGitContext(ctx) ? ctx : undefined;

  const lines: string[] = [];
  if (!git) lines.push(`note    ${(ctx as { unavailable: string }).unavailable}`);

  let ok = true;
  for (const { name, issues, skipped } of runChecks(repo, git, options.horizonDays)) {
    if (skipped) {
      lines.push(`skip    ${name} — ${skipped}`);
    } else if (issues.length === 0) {
      lines.push(`ok      ${name}`);
    } else {
      ok = false;
      lines.push(`FAIL    ${name}`);
      for (const issue of issues) lines.push(`        ${issue.file}: ${issue.message}`);
    }
  }
  return { ok, lines };
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const root = flagValue(args, '--root') ?? process.cwd();
  const base = flagValue(args, '--base');
  const horizon = flagValue(args, '--horizon-days');
  const horizonDays = horizon === undefined ? undefined : Number(horizon);
  if (horizonDays !== undefined && !(horizonDays >= 0)) {
    console.error(`validate: --horizon-days must be a non-negative number, got "${horizon}"`);
    process.exit(2);
  }
  const { ok, lines } = runValidation(root, { base, horizonDays });
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
