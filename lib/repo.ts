/**
 * Repo identity, pickers, and workspace discovery.
 *
 * Re-exports types and helpers from focused modules so existing
 * imports (`from "../lib/repo.ts"`) continue to work.
 */

import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, mkdirSync, realpathSync } from "fs";
import { basename, join, resolve } from "path";
import { repoDataDir } from "./rt-paths.ts";
import { identityFromRemote, serializeIdentity } from "./settings/identity.ts";

// ─── Re-exports ──────────────────────────────────────────────────────────────

export { getRepoRoot, getCurrentBranch, getRemoteUrl } from "./git.ts";
export { updateRepoIndex, getKnownRepos, repoOption, repoOptions, missingRepoRefusal, type KnownRepo } from "./repo-index.ts";

// ─── Internal imports ────────────────────────────────────────────────────────

import { getRepoRoot, getRemoteUrl } from "./git.ts";
import { updateRepoIndex, getKnownRepos, repoOption, repoOptions, missingRepoRefusal, type KnownRepo } from "./repo-index.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

export const RT_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

// ─── Repo identity ──────────────────────────────────────────────────────────

export interface RepoIdentity {
  repoName: string;
  /** Serialized wire identity (rt-client's `RepoIdentity`) — the store/index key. */
  identity: string;
  repoRoot: string;
  dataDir: string;
  remoteUrl: string;
  baseUrl: string;
}

/**
 * Repo name from a remote URL: strip the scp-style or http(s) host prefix and
 * the `.git` suffix, then take the last path segment. Exported because callers
 * that must NOT trigger `getRepoIdentity`'s `updateRepoIndex` side effect
 * (e.g. `commands/endpoint.ts`) still need the identical derivation.
 */
export function deriveRepoName(remoteUrl: string): string {
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

function getRemoteUrlForRoot(repoRoot: string): string | null {
  try {
    return execSync("git remote get-url origin", {
      cwd: repoRoot, encoding: "utf8", stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Reads the origin remote the same way rt-client's async `deriveRepoIdentity`
 * does (`git config --get remote.origin.url`), not `getRemoteUrlForRoot`'s
 * `git remote get-url origin` — under an `insteadOf` rewrite the two spellings
 * diverge and would mint two identities for one repo.
 */
function readOriginRemoteForIdentity(repoRoot: string): string | null {
  try {
    const out = execSync("git config --get remote.origin.url", {
      cwd: repoRoot, encoding: "utf8", stdio: "pipe",
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Main-worktree realpath, computed the same way rt-client's async
 * `deriveRepoIdentity` computes it, so a `path`-kind identity derived here
 * (sync) and there (async) agree byte-for-byte: first `worktree` line of
 * `git worktree list` (main is always listed first), resolved through its own
 * `--show-toplevel` — not `--git-common-dir/..`, which escapes the tree under
 * `--separate-git-dir` and merges every repo sharing one metadata parent into
 * one identity (git lists the git DIR as main there; the toplevel hop
 * degrades that case to this worktree's own toplevel).
 */
function mainWorktreeRoot(repoRoot: string): string {
  const toplevelOf = (dir: string): string | null => {
    try {
      const out = execSync("git rev-parse --show-toplevel", {
        cwd: dir, encoding: "utf8", stdio: "pipe",
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  };
  let target = repoRoot;
  try {
    const listed = execSync("git worktree list --porcelain", {
      cwd: repoRoot, encoding: "utf8", stdio: "pipe",
    });
    const first = /^worktree (.+)$/m.exec(listed)?.[1]?.trim();
    target = (first ? toplevelOf(first) : null) ?? toplevelOf(repoRoot) ?? repoRoot;
  } catch {
    // not a git dir / git unavailable: fall back to the repo root itself
  }
  // realpath throws on a path that no longer exists; degrade to the literal
  // path so a gone worktree still derives an identity instead of throwing.
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Core identity derivation for an arbitrary repo root (does not depend on
 * cwd). `getRepoIdentity()` is the cwd-based entry point every existing
 * caller uses.
 */
export function getRepoIdentityForRoot(repoRoot: string): RepoIdentity | null {
  // A repo is identified by its origin remote when it has one. Local-only repos
  // (no remote) still get an identity derived from the main worktree's realpath
  // so local commands (run, commit, nav, code) work. Remote-oriented
  // commands (mr, open) gate themselves on remoteUrl/baseUrl being non-empty.
  const remoteUrl = getRemoteUrlForRoot(repoRoot);
  const repoName = remoteUrl ? deriveRepoName(remoteUrl) : basename(repoRoot);

  const originRemote = readOriginRemoteForIdentity(repoRoot);
  const remoteIdentity = originRemote ? identityFromRemote(originRemote) : null;
  const identity = serializeIdentity(
    remoteIdentity ?? { kind: "path", id: mainWorktreeRoot(repoRoot) },
  );

  const dataDir = repoDataDir(identity);
  mkdirSync(dataDir, { recursive: true });

  updateRepoIndex(identity, repoRoot);

  return {
    repoName,
    identity,
    repoRoot,
    dataDir,
    remoteUrl: remoteUrl ?? "",
    baseUrl: remoteUrl ? deriveBaseUrl(remoteUrl) : "",
  };
}

export function getRepoIdentity(): RepoIdentity | null {
  const repoRoot = getRepoRoot();
  if (!repoRoot) return null;
  return getRepoIdentityForRoot(repoRoot);
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

/** Never chdir into a repo whose indexed path is gone — locate it first. */
function refuseIfMissing(repo: KnownRepo): void {
  if (!repo.missing) return;
  console.error(`\n  ${missingRepoRefusal(repo)}\n`);
  process.exit(1);
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

  const repos = getKnownRepos({ includeMissing: true });

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
      options: repoOptions(repos),
    });
    if (!picked) process.exit(0);  // Esc on picker — clean exit
    const match = repos.find(r => r.repoName === picked);
    if (!match) process.exit(0);
    selectedRepo = match;
  }

  refuseIfMissing(selectedRepo);
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
  const repos = getKnownRepos({ includeMissing: true });

  if (repos.length === 0) {
    console.log(`\n  not in a git repo and no known repos found`);
    console.log(`  run rt from inside a git repo first to register it\n`);
    process.exit(1);
  }

  const totalWorktrees = repos.reduce((n, r) => n + r.worktrees.length, 0);
  if (totalWorktrees === 1) {
    refuseIfMissing(repos[0]!);
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
    const options = repoOptions(repos);

    const picked = await filterableSelect({ message: "Select a repo", options });
    if (!picked) process.exit(0);            // user escaped — clean exit, no error
    const match = repos.find(r => r.repoName === picked);
    if (!match) process.exit(0);             // shouldn't happen, but don't crash
    selectedRepo = match;
  }
  refuseIfMissing(selectedRepo);

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
 * Returns null when the picker is cancelled (Esc / Ctrl-C).
 */
export async function pickWorktreeFromRepo(repo: KnownRepo, prompt?: string, opts?: { backLabel?: string }): Promise<string | null> {
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

  const options = repoOptions(repos);

  const pickedRepo = await filterableSelect({ message: "Pick a repo", options });
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
    // Strip "/**" before "/*" — the shorter pattern would otherwise eat the
    // first two chars of "/**" (e.g. "packages/**" → "packages*").
    const baseDir = entry.replace("/**", "").replace("/*", "");
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
