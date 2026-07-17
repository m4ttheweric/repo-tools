/**
 * Global repo index — tracks all known repos in ~/.rt/repos.json.
 *
 * Provides repo discovery with worktree enumeration so commands
 * can offer pickers when run outside a git repo.
 */

import { execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { repoDataDir } from "./rt-paths.ts";
import { readJson, writeJson } from "./json-store.ts";
import { dim } from "./ansi.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KnownRepo {
  repoName: string;
  /** All available worktree paths */
  worktrees: { path: string; branch: string; isBare: boolean }[];
  dataDir: string;
  /** False for repos discovered by scanning sibling directories, never
   *  explicitly visited by rt. Omitted (implicitly true) for indexed repos. */
  registered?: boolean;
}

// ─── Index CRUD ──────────────────────────────────────────────────────────────

interface RepoIndex {
  [repoName: string]: string; // repoName → primary repo root path
}

function repoIndexPath(): string {
  return join(homedir(), ".rt", "repos.json");
}

function loadRepoIndex(): RepoIndex {
  return readJson<RepoIndex>(repoIndexPath(), {});
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
    writeJson(repoIndexPath(), index);
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
      dataDir: repoDataDir(repoName),
    });
  }

  const known = repos.filter(r => r.worktrees.length > 0);
  const knownNames = new Set(known.map(r => r.repoName));
  const knownPaths = new Set(known.flatMap(r => r.worktrees.map(w => w.path)));

  return [...known, ...scanUnregisteredRepos(known, knownNames, knownPaths)];
}

/**
 * Scan the parent directories of already-registered repos for sibling git
 * repos that have never been visited by rt (and so are absent from
 * repos.json). This is what lets `rt cd` surface a repo the first time you
 * ever pick it, instead of requiring you to `cd` there manually first.
 *
 * Only looks one level deep and only under directories that already contain
 * a registered repo — there's no separate "roots" config to keep in sync.
 */
function scanUnregisteredRepos(
  known: KnownRepo[],
  knownNames: Set<string>,
  knownPaths: Set<string>,
): KnownRepo[] {
  const roots = new Set(known.map(r => dirname(r.worktrees[0]!.path)).filter(existsSync));
  const unregistered: KnownRepo[] = [];

  for (const root of roots) {
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (knownNames.has(entry.name)) continue;

      const repoPath = join(root, entry.name);
      if (knownPaths.has(repoPath)) continue;
      if (!existsSync(join(repoPath, ".git"))) continue;

      let branch = "";
      try {
        branch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: repoPath, encoding: "utf8", stdio: "pipe",
        }).trim();
      } catch { /* detached HEAD or other edge case — leave blank */ }

      unregistered.push({
        repoName: entry.name,
        worktrees: [{ path: repoPath, branch, isBare: false }],
        dataDir: repoDataDir(entry.name),
        registered: false,
      });
    }
  }

  return unregistered;
}

// ─── Picker option formatting ───────────────────────────────────────────────

/** Shared repo → picker-option mapping, dimmed + labeled for unregistered repos. */
export function repoOption(r: KnownRepo): { value: string; label: string; hint: string; color?: string } {
  const location = r.worktrees.length > 1
    ? `${r.worktrees.length} worktrees`
    : r.worktrees[0]?.path.replace(homedir(), "~") || "";

  return {
    value: r.repoName,
    label: r.repoName,
    hint: r.registered === false
      ? (location ? `${location} · unregistered` : "unregistered")
      : location,
    ...(r.registered === false ? { color: dim } : {}),
  };
}
