/**
 * Low-level git helpers.
 * Thin wrappers around `git` CLI commands with safe error handling.
 */

import { execSync } from "child_process";

/** Get the root of the current git repo, or null if not in one. */
export function getRepoRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}

/** Get the current branch name, or null on failure. */
export function getCurrentBranch(): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}

/** Get the remote origin URL, or null if no remote. */
export function getRemoteUrl(): string | null {
  try {
    return execSync("git remote get-url origin", {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}
