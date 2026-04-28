/**
 * Repo identity, pickers, and workspace discovery.
 *
 * Re-exports types and helpers from focused modules so existing
 * imports (`from "../lib/repo.ts"`) continue to work.
 */

import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

// ─── Re-exports ──────────────────────────────────────────────────────────────

export { getRepoRoot, getCurrentBranch, getRemoteUrl } from "./git.ts";
export { updateRepoIndex, getKnownRepos, type KnownRepo } from "./repo-index.ts";
export {
  loadRepoConfig, loadOrCreateRepoConfig, saveRepoConfig,
  type RepoConfig, type SetupStep,
} from "./repo-config.ts";

// ─── Internal imports ────────────────────────────────────────────────────────

import { getRepoRoot, getRemoteUrl } from "./git.ts";
import { updateRepoIndex, getKnownRepos, type KnownRepo } from "./repo-index.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

export const RT_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

// ─── Repo identity ──────────────────────────────────────────────────────────

export interface RepoIdentity {
  repoName: string;
  repoRoot: string;
  dataDir: string;
  remoteUrl: string;
  baseUrl: string;
}

function deriveRepoName(remoteUrl: string): string {
  return remoteUrl
    .replace(/^git@[^:]+:/, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\.git$/, "")
    .split("/")
    .pop() || "unknown";
}

function deriveBaseUrl(remoteUrl: string): string {
  return remoteUrl
    .replace(/\.git$/, "")
    .replace(/^git@([^:]+):(.*)/, "https://$1/$2");
}

export function getRepoIdentity(): RepoIdentity | null {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return null;

  const remoteUrl = getRemoteUrl();
  if (!remoteUrl) return null;

  const repoName = deriveRepoName(remoteUrl);
  const dataDir = join(homedir(), ".rt", repoName);
  mkdirSync(dataDir, { recursive: true });

  updateRepoIndex(repoName, repoRoot);

  return {
    repoName,
    repoRoot,
    dataDir,
    remoteUrl,
    baseUrl: deriveBaseUrl(remoteUrl),
  };
}

/**
 * Get repo identity, falling back to the interactive worktree picker
 * if not currently inside a git repo.
 */
export async function requireIdentity(commandLabel?: string): Promise<RepoIdentity> {
  let identity = getRepoIdentity();
  if (identity) return identity;

  const selected = await pickWorktree(commandLabel ? `Pick a repo for ${commandLabel}` : "Pick a repo");
  process.chdir(selected);

  identity = getRepoIdentity();
  if (!identity) {
    console.log(`\n  could not identify repo\n`);
    process.exit(1);
  }
  return identity;
}

/**
 * Get repo identity at the repo level (no worktree picker step).
 * Falls back to a repo-only picker if not currently inside a git repo.
 * Chdirs to the first worktree of the selected repo.
 *
 * Used by commands that operate on repo-wide config (e.g. hooks, port).
 */
export async function requireRepoIdentity(commandLabel?: string): Promise<RepoIdentity> {
  let identity = getRepoIdentity();
  if (identity) return identity;

  const repos = getKnownRepos();

  if (repos.length === 0) {
    console.log(`\n  not in a git repo and no known repos found`);
    console.log(`  run rt from inside a git repo first to register it\n`);
    process.exit(1);
  }

  let selectedRepo = repos[0]!;

  if (repos.length > 1) {
    if (!process.stdin.isTTY) {
      console.log(`\n  not in a git repo — run interactively to pick one\n`);
      process.exit(1);
    }

    const { filterableSelect } = await import("./rt-render.tsx");
    const picked = await filterableSelect({
      message: commandLabel ? `Pick a repo for ${commandLabel}` : "Pick a repo",
      options: repos.map(r => ({
        value: r.repoName,
        label: r.repoName,
        hint: r.worktrees.length > 1
          ? `${r.worktrees.length} worktrees`
          : r.worktrees[0]?.path.replace(process.env.HOME || "", "~") || "",
      })),
    });
    if (!picked) process.exit(0);  // Esc on picker — clean exit
    const match = repos.find(r => r.repoName === picked);
    if (!match) process.exit(0);
    selectedRepo = match;
  }

  process.chdir(selectedRepo.worktrees[0]!.path);

  identity = getRepoIdentity();
  if (!identity) {
    console.log(`\n  could not identify repo\n`);
    process.exit(1);
  }
  return identity;
}

// ─── Pickers ─────────────────────────────────────────────────────────────────

/**
 * Two-step interactive picker: repo → worktree.
 * Auto-selects when there's only one option at either step.
 */
export async function pickWorktree(prompt: string): Promise<string> {
  const repos = getKnownRepos();

  if (repos.length === 0) {
    console.log(`\n  not in a git repo and no known repos found`);
    console.log(`  run rt from inside a git repo first to register it\n`);
    process.exit(1);
  }

  const totalWorktrees = repos.reduce((n, r) => n + r.worktrees.length, 0);
  if (totalWorktrees === 1) {
    return repos[0]!.worktrees[0]!.path;
  }

  if (!process.stdin.isTTY) {
    console.log(`\n  not in a git repo — run interactively to pick one\n`);
    process.exit(1);
  }

  let selectedRepo: KnownRepo;

  if (repos.length === 1) {
    selectedRepo = repos[0]!;
  } else {
    const { filterableSelect } = await import("./rt-render.tsx");
    const repoOptions = repos.map(r => ({
      value: r.repoName,
      label: r.repoName,
      hint: r.worktrees.length > 1
        ? `${r.worktrees.length} worktrees`
        : r.worktrees[0]?.path.replace(process.env.HOME || "", "~") || "",
    }));

    const picked = await filterableSelect({ message: "Select a repo", options: repoOptions });
    if (!picked) process.exit(0);            // user escaped — clean exit, no error
    const match = repos.find(r => r.repoName === picked);
    if (!match) process.exit(0);             // shouldn't happen, but don't crash
    selectedRepo = match;
  }

  if (selectedRepo.worktrees.length === 1) {
    return selectedRepo.worktrees[0]!.path;
  }

  // Clear between repo and worktree picker
  console.clear();

  const wtPath = await pickWorktreeFromRepo(selectedRepo, "Select a worktree");
  if (!wtPath) process.exit(0);              // user escaped the worktree picker
  return wtPath;
}

/**
 * Pick a worktree from a specific repo (enriched with Linear ticket info).
 */
export async function pickWorktreeFromRepo(repo: KnownRepo, prompt?: string, opts?: { backLabel?: string }): Promise<string> {
  const { filterableSelect } = await import("./rt-render.tsx");
  const { enrichBranches, formatBranchLabel } = await import("./enrich.ts");

  let remoteUrl: string | undefined;
  try {
    remoteUrl = execSync("git config --get remote.origin.url", {
      cwd: repo.worktrees[0]?.path, encoding: "utf8", stdio: "pipe",
    }).trim();
  } catch { /* no remote */ }

  const enriched = await enrichBranches(
    repo.worktrees.map(wt => ({ path: wt.path, branch: wt.branch })),
    remoteUrl,
  );

  const options = enriched.map(eb => ({
    value: eb.path,
    label: formatBranchLabel(eb),
    hint: "",
  }));

  return filterableSelect({
    message: prompt || `${repo.repoName} worktrees`,
    options,
    backLabel: opts?.backLabel,
  });
}

/**
 * Interactive repo/worktree picker, triggered by --pick.
 *
 * 1. If in a repo with worktrees → show worktrees + "Pick from all repos"
 * 2. If "Pick from all repos" → show repos → pick worktree if multiple
 * 3. Returns updated RepoIdentity after chdir
 */
export async function pickRepoInteractive(): Promise<RepoIdentity> {
  const { filterableSelect } = await import("./rt-render.tsx");
  const repos = getKnownRepos();

  if (repos.length === 0) {
    console.log(`\n  no known repos — run rt from inside a git repo first\n`);
    process.exit(1);
  }

  // Find current repo (if any)
  const currentIdentity = getRepoIdentity();
  const currentRepo = currentIdentity
    ? repos.find((r) => r.repoName === currentIdentity.repoName)
    : null;

  let selectedPath: string;

  if (currentRepo && currentRepo.worktrees.length > 1) {
    // Show current repo's worktrees + escape hatch
    const { enrichBranches, formatBranchLabel } = await import("./enrich.ts");

    let remoteUrl: string | undefined;
    try {
      remoteUrl = execSync("git config --get remote.origin.url", {
        cwd: currentRepo.worktrees[0]?.path, encoding: "utf8", stdio: "pipe",
      }).trim();
    } catch { /* no remote */ }

    const enriched = await enrichBranches(
      currentRepo.worktrees.map((wt) => ({ path: wt.path, branch: wt.branch })),
      remoteUrl,
    );

    const options = enriched.map((eb) => ({
      value: eb.path,
      label: formatBranchLabel(eb),
      hint: "",
    }));

    options.push({
      value: "__all_repos__",
      label: "Pick from all repos",
      hint: `${repos.length} repos available`,
    });

    const picked = await filterableSelect({
      message: `${currentRepo.repoName} worktrees`,
      options,
    });

    if (!picked) process.exit(0);            // Esc on worktree picker
    if (picked === "__all_repos__") {
      selectedPath = await pickFromAllRepos(repos);
    } else {
      selectedPath = picked;
    }
  } else {
    // Not in a repo or repo has only one worktree → go straight to all repos
    selectedPath = await pickFromAllRepos(repos);
  }

  process.chdir(selectedPath);
  const identity = getRepoIdentity();
  if (!identity) {
    console.log(`\n  could not identify repo\n`);
    process.exit(1);
  }
  return identity;
}

async function pickFromAllRepos(repos: KnownRepo[]): Promise<string> {
  const { filterableSelect } = await import("./rt-render.tsx");

  const repoOptions = repos.map((r) => ({
    value: r.repoName,
    label: r.repoName,
    hint: r.worktrees.length > 1
      ? `${r.worktrees.length} worktrees`
      : r.worktrees[0]?.path.replace(process.env.HOME || "", "~") || "",
  }));

  const pickedRepo = await filterableSelect({ message: "Pick a repo", options: repoOptions });
  if (!pickedRepo) process.exit(0);        // Esc on all-repos picker
  const repo = repos.find((r) => r.repoName === pickedRepo);
  if (!repo) process.exit(0);

  if (repo.worktrees.length === 1) {
    return repo.worktrees[0]!.path;
  }

  const wtPath = await pickWorktreeFromRepo(repo, "Pick a worktree");
  if (!wtPath) process.exit(0);            // Esc on worktree picker
  return wtPath;
}

// ─── Workspace package discovery ─────────────────────────────────────────────

export interface WorkspacePackage {
  name: string;
  path: string;
}

function readWorkspaceGlobs(repoRoot: string): string[] {
  const pnpmFile = join(repoRoot, "pnpm-workspace.yaml");
  if (existsSync(pnpmFile)) {
    return readFileSync(pnpmFile, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim().replace(/['"]/g, ""));
  }

  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) return ws;
    if (ws && Array.isArray(ws.packages)) return ws.packages;
  } catch {
    /* fall through */
  }
  return [];
}

/**
 * Discover workspace packages from pnpm-workspace.yaml or the `workspaces`
 * field in root package.json (npm / yarn / bun shape — both the array form
 * and the yarn-classic `{ packages: [...] }` form).
 */
export function getWorkspacePackages(repoRoot: string): WorkspacePackage[] {
  const entries = readWorkspaceGlobs(repoRoot);
  if (entries.length === 0) return [];

  const packages: WorkspacePackage[] = [];

  for (const entry of entries) {
    const baseDir = entry.replace("/*", "").replace("/**", "");
    const fullDir = join(repoRoot, baseDir);

    if (!existsSync(fullDir)) continue;

    if (entry.includes("*")) {
      try {
        for (const child of readdirSync(fullDir, { withFileTypes: true })) {
          if (!child.isDirectory()) continue;
          const pkgJsonPath = join(fullDir, child.name, "package.json");
          if (existsSync(pkgJsonPath)) {
            try {
              const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
              packages.push({
                name: pkg.name || child.name,
                path: `${baseDir}/${child.name}`,
              });
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    } else {
      const pkgJsonPath = join(repoRoot, baseDir, "package.json");
      if (existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
          packages.push({
            name: pkg.name || baseDir.split("/").pop() || baseDir,
            path: baseDir,
          });
        } catch { /* skip */ }
      }
    }
  }

  return packages.sort((a, b) => a.path.localeCompare(b.path));
}
