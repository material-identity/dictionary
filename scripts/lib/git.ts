import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

/**
 * Git plumbing for the diff-aware checks (1, 6, 7). Diffs run with --no-renames so a
 * drafts/ → published/ move always appears as D + A — check 1 sees the D, check 7 pairs
 * the D with the A by content. Rename detection would hide the pair inside one R entry.
 */

export interface DiffEntry {
  /** A added, M modified, D deleted, T type change (no R/C — renames are disabled). */
  status: string;
  /** Path relative to the repo root. */
  path: string;
}

export interface GitContext {
  base: string;
  diff: DiffEntry[];
  /** Content of a file at the merge-base of base...HEAD; undefined if it did not exist. */
  readBaseFile: (relPath: string) => string | undefined;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Build the git context for a repo root, or explain why one is unavailable.
 * The root must be the work-tree top level: for fixture trees nested inside this
 * repository the diff would otherwise report repo-level paths against fixture files.
 */
export function createGitContext(root: string, base: string): GitContext | { unavailable: string } {
  let toplevel: string;
  try {
    toplevel = git(root, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return { unavailable: `${root} is not inside a git work tree` };
  }
  if (realpathSync(toplevel) !== realpathSync(root)) {
    return { unavailable: `${root} is not the git work-tree root (${toplevel})` };
  }
  let mergeBase: string;
  try {
    mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  } catch {
    return { unavailable: `cannot resolve merge-base of "${base}" and HEAD` };
  }

  const diff: DiffEntry[] = git(root, ['diff', '--name-status', '--no-renames', `${mergeBase}...HEAD`])
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status.trim(), path: rest.join('\t') };
    });

  const readBaseFile = (relPath: string): string | undefined => {
    try {
      return git(root, ['show', `${mergeBase}:${relPath}`]);
    } catch {
      return undefined;
    }
  };

  return { base, diff, readBaseFile };
}

export function isGitContext(ctx: GitContext | { unavailable: string }): ctx is GitContext {
  return !('unavailable' in ctx);
}
