/**
 * resolveWorktree — map an absolute cwd to the repo worktree that contains it.
 *
 * Pure path matching: the winning worktree is the one whose path is `cwd`
 * itself or a path-boundary prefix of `cwd` (so "/a/b" matches "/a/b/src" but
 * not "/a/b-other"). When worktrees nest, the longest match wins.
 */

export interface WorktreeInfo {
  repo: string;
  path: string;
  branch: string;
}

/** True when `path` is `cwd` or a parent directory of `cwd` (boundary-aware). */
function contains(path: string, cwd: string): boolean {
  return cwd === path || cwd.startsWith(path.endsWith("/") ? path : path + "/");
}

export function resolveWorktree(
  cwd: string,
  worktrees: WorktreeInfo[],
): WorktreeInfo | undefined {
  let best: WorktreeInfo | undefined;
  for (const wt of worktrees) {
    if (contains(wt.path, cwd) && (!best || wt.path.length > best.path.length)) {
      best = wt;
    }
  }
  return best;
}
