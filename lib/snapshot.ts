/**
 * Worktree snapshots for `rt validate` — build a commit of the worktree's
 * exact state (staged + unstaged + untracked-not-ignored) without touching
 * the user's HEAD, index, or files.
 *
 * The trick is a throwaway GIT_INDEX_FILE: read-tree HEAD into it, `add -A`
 * on top (which respects .gitignore), then write-tree/commit-tree from that
 * private index. The user's real index is never opened for writing and no
 * ref is created — the snapshot commit is reachable only by sha, exactly
 * what `git push <receiver> <sha>:refs/snapshots/<tree>` needs.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WorktreeSnapshot {
  /** Tree sha of the snapshotted state — the farm's verdict cache key. */
  tree: string;
  /** Snapshot commit (parent = the worktree's HEAD). */
  commit: string;
  /** merge-base of HEAD and the base ref (the repo's default branch). */
  mergeBase: string;
  /** Paths changed between mergeBase and the snapshot commit. */
  changedFiles: string[];
}

/** The base ref does not resolve to a commit in this worktree. */
export class SnapshotBaseRefError extends Error {
  constructor(public readonly baseRef: string) {
    super(
      `base ref ${baseRef} not found in this worktree — fetch the remote, or fix defaultBranch in the repo overlay (~/.rt/repos/<repoId>/repo.jsonc)`,
    );
    this.name = "SnapshotBaseRefError";
  }
}

/** Run git in `cwd` with extra env, capturing stdout; throws with stderr on failure. */
async function git(cwd: string, env: Record<string, string>, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/**
 * Build a commit of the exact worktree state without touching the user's
 * index. `cwd` may be anywhere inside the worktree — the snapshot always
 * covers the whole tree from the worktree root.
 *
 * `changedFiles` is diffed mergeBase..snapshotCommit (NOT the worktree),
 * so uncommitted edits count. The merge-base uses the local `baseRef`
 * (the repo's default branch — see resolveBaseRef in lib/validate-farm.ts);
 * the controller re-computes against the mirror (Task 10 calibration
 * reconciles the two). Throws SnapshotBaseRefError when `baseRef` does not
 * resolve, before any snapshot work happens.
 */
export async function snapshotWorktree(
  cwd: string,
  baseRef: string = "refs/remotes/origin/master",
): Promise<WorktreeSnapshot> {
  const root = (await git(cwd, {}, ["rev-parse", "--show-toplevel"])).trim();
  try {
    await git(root, {}, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  } catch {
    throw new SnapshotBaseRefError(baseRef);
  }
  const tmpIndex = join(tmpdir(), `rt-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await git(root, env, ["read-tree", "HEAD"]);
    await git(root, env, ["add", "-A", "--", "."]);
    const tree = (await git(root, env, ["write-tree"])).trim();
    const head = (await git(root, {}, ["rev-parse", "HEAD"])).trim();
    const commit = (await git(root, env, ["commit-tree", tree, "-p", head, "-m", "rt validate snapshot"])).trim();
    const mergeBase = (await git(root, {}, ["merge-base", "HEAD", baseRef])).trim();
    const changedFiles = (await git(root, {}, ["diff", "--name-only", mergeBase, commit]))
      .trim()
      .split("\n")
      .filter(Boolean);
    return { tree, commit, mergeBase, changedFiles };
  } finally {
    await rm(tmpIndex, { force: true });
  }
}
