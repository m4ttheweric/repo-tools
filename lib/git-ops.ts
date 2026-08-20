/**
 * Portable git operations shared by rt's daemon and CLI surfaces.
 *
 * Ported from worktree-context's git.ts — no VS Code dependencies.
 * Uses child_process for all git commands.
 */

import { execSync } from "child_process";

/**
 * Get the current branch name (or null if detached HEAD).
 */
export function getCurrentBranch(cwd: string): string | null {
  try {
    return execSync("git symbolic-ref --quiet --short HEAD", {
      cwd, encoding: "utf8", stdio: "pipe",
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if working tree has uncommitted changes.
 */
export function hasUncommittedChanges(cwd: string): boolean {
  try {
    const stdout = execSync("git status --porcelain", {
      cwd, encoding: "utf8", stdio: "pipe",
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Detect whether origin/main or origin/master exists. */
export function getRemoteDefaultBranch(cwd: string): string | null {
  for (const candidate of ["origin/main", "origin/master"]) {
    try {
      execSync(`git rev-parse --verify ${candidate}`, { cwd, stdio: "pipe" });
      return candidate;
    } catch { /* doesn't exist */ }
  }
  return null;
}
