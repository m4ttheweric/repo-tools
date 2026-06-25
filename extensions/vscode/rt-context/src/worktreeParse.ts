import * as path from 'path';
import type { WorktreeEntry } from './types';

/**
 * Parse `git worktree list --porcelain` into WorktreeEntry[].
 *
 * Porcelain is used instead of the human-readable `git worktree list` format
 * because the latter can't be reliably matched: detached worktrees render as
 * "(detached HEAD)" with no `[branch]`, and git appends annotations like
 * `locked`/`prunable` after the branch. The previous regex required a trailing
 * `[branch]`, so it silently dropped every detached worktree (e.g. warm-pool
 * entries that haven't been assigned a branch yet). Porcelain emits one stable
 * key/value record per worktree, so each kind round-trips losslessly.
 *
 * `currentFolder` is the basename of the active workspace's repo root; the
 * entry whose directory basename matches is flagged `isCurrent`.
 */
export function parseWorktreePorcelain(stdout: string, currentFolder: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let dirPath: string | null = null;
  let branch: string | null = null;
  let bare = false;

  const flush = () => {
    // Skip the bare main-repo entry — it has no working tree to open.
    if (dirPath && !bare) {
      const name = path.basename(dirPath);
      entries.push({ dirPath, name, branch, isCurrent: name === currentFolder });
    }
    dirPath = null;
    branch = null;
    bare = false;
  };

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      dirPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'bare') {
      bare = true;
    }
    // A `detached` line leaves branch = null, which is exactly what we want.
  }
  flush();

  return entries;
}
