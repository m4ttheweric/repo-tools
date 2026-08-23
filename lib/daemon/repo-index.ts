/**
 * Repo discovery — the repo index (name → absolute path, in state.db's kv
 * store) and per-repo git metadata resolution.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { loadRepoIndex as loadRepoIndexFromStore } from "../repo-index.ts";
import type { RepoIndex } from "./handlers/types.ts";

/** Thin re-export so this module's existing callers keep working unchanged. */
export function loadRepoIndex(): RepoIndex {
  return loadRepoIndexFromStore();
}

/**
 * Resolve the path of the git config file that governs `repoPath`.
 * For worktrees, .git is a file pointing at the main repo's git dir.
 */
export function resolveGitConfigPath(repoPath: string): string | null {
  const dotGit = join(repoPath, ".git");
  if (!existsSync(dotGit)) return null;

  try {
    const stat = statSync(dotGit);
    if (stat.isFile()) {
      // Worktree: .git is a file like "gitdir: /path/to/main/.git/worktrees/branch"
      const content = readFileSync(dotGit, "utf8").trim();
      const gitdir = content.replace("gitdir: ", "");
      // Navigate up to the main .git/config
      const mainGitDir = resolve(repoPath, gitdir, "..", "..");
      return join(mainGitDir, "config");
    }
    // Normal repo
    return join(dotGit, "config");
  } catch {
    return null;
  }
}
