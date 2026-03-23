/**
 * Global repo index — tracks all known repos in ~/.rt/repos.json.
 *
 * Provides repo discovery with worktree enumeration so commands
 * can offer pickers when run outside a git repo.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KnownRepo {
  repoName: string;
  /** All available worktree paths */
  worktrees: { path: string; branch: string; isBare: boolean }[];
  dataDir: string;
}

// ─── Index CRUD ──────────────────────────────────────────────────────────────

interface RepoIndex {
  [repoName: string]: string; // repoName → primary repo root path
}

function repoIndexPath(): string {
  return join(homedir(), ".rt", "repos.json");
}

function loadRepoIndex(): RepoIndex {
  try {
    return JSON.parse(readFileSync(repoIndexPath(), "utf8"));
  } catch {
    return {};
  }
}

export function updateRepoIndex(repoName: string, repoRoot: string): void {
  const index = loadRepoIndex();
  try {
    const mainWorktree = execSync("git worktree list --porcelain", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    const mainPath = mainWorktree.split("\n")[0]?.replace("worktree ", "").trim();
    index[repoName] = mainPath || repoRoot;
  } catch {
    index[repoName] = repoRoot;
  }
  try {
    writeFileSync(repoIndexPath(), JSON.stringify(index, null, 2));
  } catch { /* best effort */ }
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Get all known repos from the global index, with worktree discovery.
 * Used when rt is run outside a git repo to offer a picker.
 */
export function getKnownRepos(): KnownRepo[] {
  const index = loadRepoIndex();
  const repos: KnownRepo[] = [];

  for (const [repoName, mainPath] of Object.entries(index)) {
    if (!existsSync(mainPath)) continue;

    const worktrees: KnownRepo["worktrees"] = [];
    try {
      const output = execSync("git worktree list --porcelain", {
        cwd: mainPath,
        encoding: "utf8",
        stdio: "pipe",
      });

      let currentPath = "";
      let currentBranch = "";
      let isBare = false;

      for (const line of output.split("\n")) {
        if (line.startsWith("worktree ")) {
          if (currentPath) {
            worktrees.push({ path: currentPath, branch: currentBranch, isBare });
          }
          currentPath = line.replace("worktree ", "").trim();
          currentBranch = "";
          isBare = false;
        } else if (line.startsWith("branch ")) {
          currentBranch = line.replace("branch refs/heads/", "").trim();
        } else if (line === "bare") {
          isBare = true;
        }
      }
      if (currentPath) {
        worktrees.push({ path: currentPath, branch: currentBranch, isBare });
      }
    } catch {
      worktrees.push({ path: mainPath, branch: "", isBare: false });
    }

    repos.push({
      repoName,
      worktrees: worktrees.filter(w => !w.isBare && existsSync(w.path)),
      dataDir: join(homedir(), ".rt", repoName),
    });
  }

  return repos.filter(r => r.worktrees.length > 0);
}
