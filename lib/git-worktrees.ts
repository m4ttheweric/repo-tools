/**
 * Worktree enumeration helpers.
 *
 * `git worktree list --porcelain` is parsed in many places across rt — most of
 * them want different fields (branch, HEAD, primary-vs-linked) and have their
 * own parsers. This module is the canonical helper for callers that just want
 * the worktree-root paths and nothing else, e.g. the Doppler reconciler.
 *
 * Paths are filtered to only those that exist on disk: if a worktree was
 * removed externally (`rm -rf <path>` without `git worktree remove`), git's
 * porcelain output still lists it, but it's not a worktree we can usefully
 * operate on.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";

/**
 * Enumerate the worktree roots for a repo. Returns absolute paths, filtered
 * to those that exist on disk. Returns an empty array if `repoPath` isn't a
 * git repo or git fails for any other reason.
 */
export function listWorktreeRoots(repoPath: string): string[] {
  let out: string;
  try {
    out = execSync("git worktree list --porcelain", {
      cwd: repoPath, encoding: "utf8", stdio: "pipe",
    });
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      const path = line.slice("worktree ".length).trim();
      if (existsSync(path)) roots.push(path);
    }
  }
  return roots;
}
