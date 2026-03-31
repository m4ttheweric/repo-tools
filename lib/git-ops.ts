/**
 * Portable git operations for rt branch management.
 *
 * Ported from worktree-context's git.ts — no VS Code dependencies.
 * Uses child_process for all git commands.
 *
 * Stash format uses GitHub Desktop's `!!GitHub_Desktop<branch>` marker
 * for full interoperability with GitHub Desktop and worktree-context.
 */

import { execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BranchInfo {
  name: string;
  ref: string;
  isLocal: boolean;
  commitEpoch: number;
}

export interface DesktopStashEntry {
  name: string;       // e.g. "stash@{0}"
  branchName: string;
}

// ─── Branch listing ──────────────────────────────────────────────────────────

/**
 * List all local + remote branches, sorted by committer date (most recent first).
 * Remote branches that have a matching local branch are deduplicated.
 */
export function listAllBranches(cwd: string): BranchInfo[] {
  try {
    const stdout = execSync(
      'git branch -a --sort=-committerdate --format="%(refname:short)\t%(committerdate:unix)"',
      { cwd, encoding: "utf8", stdio: "pipe" },
    );
    const seen = new Map<string, number>();
    const results: BranchInfo[] = [];

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const [ref, epochStr] = trimmed.split("\t");
      if (!ref) continue;
      const commitEpoch = parseInt(epochStr ?? "0", 10) || 0;

      if (ref.includes("->") || ref === "origin" || ref.endsWith("/HEAD")) continue;

      const isRemote = ref.startsWith("origin/");
      const displayName = isRemote ? ref.replace(/^origin\//, "") : ref;
      if (displayName === "HEAD") continue;

      const existingIdx = seen.get(displayName);
      if (existingIdx !== undefined) {
        if (!isRemote && !results[existingIdx]!.isLocal) {
          results[existingIdx] = { name: displayName, ref, isLocal: true, commitEpoch };
        }
        continue;
      }
      seen.set(displayName, results.length);
      results.push({ name: displayName, ref, isLocal: !isRemote, commitEpoch });
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Get the set of branch names checked out in any worktree.
 * These branches can't be switched to from another worktree.
 */
export function getWorktreeBranches(cwd: string): Set<string> {
  try {
    const stdout = execSync("git worktree list --porcelain", {
      cwd, encoding: "utf8", stdio: "pipe",
    });
    const branches = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branches.add(ref.replace(/^refs\/heads\//, ""));
      }
    }
    return branches;
  } catch {
    return new Set();
  }
}

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

// ─── Stash (GitHub Desktop-compatible) ───────────────────────────────────────

const DESKTOP_STASH_RE = /!!GitHub_Desktop<(.+)>$/;

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

/**
 * Stash uncommitted changes with a GitHub Desktop-compatible marker.
 * Interoperable with GitHub Desktop and worktree-context VS Code extension.
 */
export function stashChanges(cwd: string, branch: string): void {
  const message = `!!GitHub_Desktop<${branch}>`;
  execSync(`git stash push -u -m "${message}"`, { cwd, stdio: "pipe" });
}

/**
 * Find the most recent GitHub Desktop-tagged stash entry for a branch.
 */
export function findDesktopStash(cwd: string, branch: string): DesktopStashEntry | null {
  try {
    const stdout = execSync("git stash list", {
      cwd, encoding: "utf8", stdio: "pipe",
    });
    for (const line of stdout.split("\n")) {
      const match = DESKTOP_STASH_RE.exec(line);
      if (match && match[1] === branch) {
        const nameMatch = /^(stash@\{\d+\})/.exec(line);
        if (nameMatch) {
          return { name: nameMatch[1]!, branchName: branch };
        }
      }
    }
  } catch { /* no stashes */ }
  return null;
}

/** Pop a specific stash entry by name (e.g. "stash@{0}"). */
export function popStash(cwd: string, stashName: string): void {
  execSync(`git stash pop "${stashName}"`, { cwd, stdio: "pipe" });
}

/** Drop a specific stash entry by name without applying it. */
export function dropStash(cwd: string, stashName: string): void {
  execSync(`git stash drop "${stashName}"`, { cwd, stdio: "pipe" });
}

// ─── Checkout / Branch creation ──────────────────────────────────────────────

/** Checkout an existing branch. */
export function checkoutBranch(cwd: string, branch: string): void {
  execSync(`git checkout "${branch}"`, { cwd, stdio: "pipe" });
}

/** Create a new branch and check it out. */
export function createBranch(cwd: string, branch: string, startPoint?: string): void {
  const args = ["checkout", "-b", branch];
  if (startPoint) args.push(startPoint);
  execSync(`git ${args.map(a => `"${a}"`).join(" ")}`, { cwd, stdio: "pipe" });
}

/** Fetch a specific remote branch. */
export function fetchRemoteBranch(cwd: string, remote: string, branch: string): void {
  execSync(`git fetch "${remote}" "${branch}"`, { cwd, stdio: "pipe" });
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
