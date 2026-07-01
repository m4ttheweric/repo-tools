/**
 * Repo discovery — the ~/.rt/repos.json index (name → absolute path) and
 * per-repo git metadata resolution.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { RT_DIR } from "../daemon-config.ts";
import type { RepoIndex } from "./handlers/types.ts";

export const REPOS_JSON_PATH = join(RT_DIR, "repos.json");

export function loadRepoIndex(): RepoIndex {
  try {
    return JSON.parse(readFileSync(REPOS_JSON_PATH, "utf8"));
  } catch {
    return {};
  }
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
