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

/** A worktree root paired with the branch checked out there (empty if detached). */
export interface WorktreeRef {
  path: string;
  branch: string;
}

/**
 * Enumerate worktrees for a repo as {path, branch} pairs. Like
 * listWorktreeRoots but also resolves the branch from the porcelain `branch
 * refs/heads/<name>` line (empty string when the worktree is detached).
 * Paths are filtered to those that exist on disk; returns [] on any git error.
 */
export function listWorktrees(repoPath: string): WorktreeRef[] {
  let out: string;
  try {
    out = execSync("git worktree list --porcelain", {
      cwd: repoPath, encoding: "utf8", stdio: "pipe",
    });
  } catch {
    return [];
  }
  const refs: WorktreeRef[] = [];
  let path: string | null = null;
  let branch = "";
  const flush = () => {
    if (path && existsSync(path)) refs.push({ path, branch });
    path = null;
    branch = "";
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return refs;
}
