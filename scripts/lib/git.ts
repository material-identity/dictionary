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
 * Confirms `root` is itself a git work-tree top level (not some nested directory, e.g. a
 * fixture tree living inside this repo) — every history-scanning helper here needs that so
 * paths in git's output line up with paths relative to `root` without extra translation.
 */
function requireToplevel(root: string): string | { unavailable: string } {
  let toplevel: string;
  try {
    toplevel = git(root, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return { unavailable: `${root} is not inside a git work tree` };
  }
  if (realpathSync(toplevel) !== realpathSync(root)) {
    return { unavailable: `${root} is not the git work-tree root (${toplevel})` };
  }
  return toplevel;
}

/**
 * Build the git context for a repo root, or explain why one is unavailable.
 * The root must be the work-tree top level: for fixture trees nested inside this
 * repository the diff would otherwise report repo-level paths against fixture files.
 */
export function createGitContext(root: string, base: string): GitContext | { unavailable: string } {
  const toplevel = requireToplevel(root);
  if (typeof toplevel !== 'string') return toplevel;
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

/**
 * For the RSS feed (#56): when each currently-published file was first added, keyed by path
 * relative to `root`. Not stored anywhere in the entries themselves — derived the same way
 * "current"/"superseded" are (#57), from git history rather than from any data field. A
 * single full-history scan rather than one `git log` per file. Silently empty (never throws)
 * outside a git work-tree top level — fixture-tree builds just render items with no pubDate.
 */
export function getAddedDates(root: string): Map<string, string> {
  const dates = new Map<string, string>();
  if (typeof requireToplevel(root) !== 'string') return dates;

  let output: string;
  try {
    // --no-renames: without it, a drafts/ -> published/ publish move (see checkMovePurity)
    // is reported as a rename, not an add, and --diff-filter=A would never match it.
    output = git(root, ['log', '--no-renames', '--name-status', '--diff-filter=A', '--format=\x01%aI']);
  } catch {
    return dates;
  }

  let currentDate: string | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('\x01')) {
      currentDate = line.slice(1);
    } else if (currentDate && line.startsWith('A\t')) {
      // git log defaults to newest-first; keep overwriting so the final value (from the
      // oldest matching commit) is the true "first added" date, even in the — currently
      // impossible per check 1 — case of a path being re-added after deletion.
      dates.set(line.slice(2), currentDate);
    }
  }
  return dates;
}
