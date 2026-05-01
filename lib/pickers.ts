/**
 * Shared picker flows for repo + worktree selection.
 *
 * Used by cd.ts and code.ts to avoid duplicating the
 * repo → worktree two-step picker with "switch repo" escape hatch.
 */

import { execSync } from "child_process";
import { join } from "path";
import { getRepoIdentity, getKnownRepos, pickWorktreeFromRepo, getWorkspacePackages, type KnownRepo } from "./repo.ts";
import { enrichBranches, formatBranchLabel } from "./enrich.ts";

const SWITCH_REPO     = "__switch_repo__"     as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getRemoteUrl(repoPath: string): Promise<string | undefined> {
  try {
    return execSync("git config --get remote.origin.url", {
      cwd: repoPath, encoding: "utf8", stdio: "pipe",
    }).trim();
  } catch {
    return undefined;
  }
}

async function buildWorktreeOptions(
  worktrees: Array<{ path: string; branch: string }>,
  remoteUrl?: string,
): Promise<{ value: string; label: string; hint: string }[]> {
  const enriched = await enrichBranches(worktrees, remoteUrl);
  return enriched.map((eb) => ({
    value: eb.path,
    label: formatBranchLabel(eb),
    hint: "",
  }));
}

function repoOptionsFromList(repos: KnownRepo[]): { value: string; label: string; hint: string }[] {
  return repos.map(r => ({
    value: r.repoName,
    label: r.repoName,
    hint: r.worktrees.length > 1
      ? `${r.worktrees.length} worktrees`
      : r.worktrees[0]?.path.replace(process.env.HOME || "", "~") || "",
  }));
}

// ─── Pickers ─────────────────────────────────────────────────────────────────

/**
 * Show a worktree picker with a "switch to a different repo" escape hatch.
 * Filters out the current worktree. Returns SWITCH_REPO if user picks that.
 */
export async function pickWorktreeWithSwitch(
  repo: KnownRepo,
  currentPath: string,
  opts?: { stderr?: boolean },
): Promise<string | typeof SWITCH_REPO> {
  const { filterableSelect, BackNavigation } = await import("./rt-render.tsx");

  if (repo.worktrees.length === 0) return SWITCH_REPO;

  const remoteUrl = await getRemoteUrl(repo.worktrees[0]?.path || currentPath);
  const options = await buildWorktreeOptions(repo.worktrees, remoteUrl);

  // Annotate the current worktree so the user knows where they are
  for (const opt of options) {
    if (opt.value === currentPath) opt.hint = "(current)";
  }

  try {
    return await filterableSelect({
      message: `${repo.repoName} worktrees`,
      options,
      backLabel: "Switch to a different repo",
      ...(opts?.stderr ? { stderr: true } : {}),
    }) as string;
  } catch (err) {
    if (err instanceof BackNavigation) return SWITCH_REPO;
    throw err;
  }
}

/**
 * Two-step repo → worktree picker from all known repos.
 * Auto-selects when there's only one option at either step.
 */
export async function pickFromAllRepos(
  repos: KnownRepo[],
  opts?: { stderr?: boolean; errorMessage?: string; includePackages?: boolean },
): Promise<string> {
  const { filterableSelect, BackNavigation } = await import("./rt-render.tsx");

  if (repos.length === 0) {
    const msg = opts?.errorMessage || "no known repos found — run rt from inside a git repo first";
    const writer = opts?.stderr ? console.error : console.log;
    writer(`\n  ${msg}\n`);
    process.exit(1);
  }

  // Loop: back from worktree/package picker restarts at repo picker
  while (true) {
    let selectedRepo: KnownRepo;

    if (repos.length === 1) {
      selectedRepo = repos[0]!;
    } else {
      const picked = await filterableSelect({
        message: "Pick a repo",
        options: repoOptionsFromList(repos),
        ...(opts?.stderr ? { stderr: true } : {}),
      });
      if (!picked) process.exit(1);
      selectedRepo = repos.find(r => r.repoName === picked)!;
    }

    // Resolve worktree path (or auto-select if only one)
    let worktreePath: string;
    if (selectedRepo.worktrees.length === 1) {
      worktreePath = selectedRepo.worktrees[0]!.path;
    } else {
      try {
        worktreePath = await pickWorktreeFromRepo(
          selectedRepo,
          `${selectedRepo.repoName} worktrees`,
          { backLabel: repos.length > 1 ? "Switch repo" : undefined },
        );
      } catch (err) {
        if (err instanceof BackNavigation) continue;
        throw err;
      }
    }

    // If caller wants package-level navigation and this is a monorepo, go one
    // level deeper instead of returning the worktree root directly.
    if (opts?.includePackages) {
      const packages = getWorkspacePackages(worktreePath);
      if (packages.length > 0) {
        try {
          return await pickPackageWithEscape(selectedRepo, worktreePath, repos, opts);
        } catch (err) {
          if (err instanceof BackNavigation) continue;
          throw err;
        }
      }
    }

    return worktreePath;
  }
}

/** Check if user chose to switch repos. */
export function isSwitchRepo(value: string): boolean {
  return value === SWITCH_REPO;
}

// ─── Monorepo package picker ─────────────────────────────────────────────────

/**
 * Package picker for monorepos (pnpm workspace). Shows all packages in the
 * current worktree plus escape hatches to switch worktree or repo.
 *
 * Returns the absolute path of the selected destination (package dir,
 * worktree root, or a different worktree/repo root).
 */
export async function pickPackageWithEscape(
  repo: KnownRepo,
  worktreePath: string,
  allRepos: KnownRepo[],
  opts?: { stderr?: boolean },
): Promise<string> {
  const { filterableSelect, BackNavigation } = await import("./rt-render.tsx");

  const packages = getWorkspacePackages(worktreePath);
  const currentBranch = repo.worktrees.find((wt) => wt.path === worktreePath)?.branch ?? "";
  const hasMultipleWorktrees = repo.worktrees.length > 1;

  // Loop: BackNavigation from the worktree picker returns here
  const hasMultipleRepos   = allRepos.length > 1;

  while (true) {
    const options: { value: string; label: string; hint: string }[] = [
      { value: worktreePath, label: "(root)", hint: currentBranch },
      ...packages.map((p) => ({
        value: join(worktreePath, p.path),
        label: p.name,
        hint: p.path,
      })),
      // Only offer repo-switching when there's more than one repo tracked
      ...(hasMultipleRepos
        ? [{ value: SWITCH_REPO, label: "↩  Switch repo", hint: `${allRepos.length} repos` }]
        : []),
    ];

    try {
      const picked = await filterableSelect({
        message: `${repo.repoName}`,
        options,
        // "Switch worktree" as a back arrow at the top — mirrors rt run's backLabel pattern
        backLabel: hasMultipleWorktrees ? "Switch worktree" : undefined,
        ...(opts?.stderr ? { stderr: true } : {}),
      });

      if (picked === SWITCH_REPO) {
        return pickFromAllRepos(allRepos, { ...opts, includePackages: true });
      }

      if (!picked) process.exit(1);
      return picked;

    } catch (err) {
      if (err instanceof BackNavigation) {
        // User hit "← Switch worktree".
        // Use pickWorktreeWithSwitch (adds "↩ Switch to a different repo") only
        // when there are multiple repos to switch to.
        if (hasMultipleRepos) {
          const wtResult = await pickWorktreeWithSwitch(repo, worktreePath, opts);
          if (isSwitchRepo(wtResult)) {
            return pickFromAllRepos(allRepos, { ...opts, includePackages: true });
          }
          return wtResult;
        } else {
          return await pickWorktreeFromRepo(repo, `${repo.repoName} worktrees`);
        }
      }
      throw err;
    }
  }
}

// ─── Worktree branch resolver (--worktree flag) ───────────────────────────────

/**
 * Resolve a worktree by branch name prefix across the given repos.
 * - Exact or unambiguous prefix match → returns path directly (no picker)
 * - Multiple matches → shows a filtered picker
 * - No match → exits with a helpful message
 */
export async function resolveWorktreeByBranch(
  branch: string,
  repos: KnownRepo[],
  opts?: { stderr?: boolean },
): Promise<string> {
  const { filterableSelect } = await import("./rt-render.tsx");

  const lower = branch.toLowerCase();
  const matches: { path: string; branch: string; repoName: string }[] = [];

  for (const repo of repos) {
    for (const wt of repo.worktrees) {
      if (wt.branch.toLowerCase().startsWith(lower)) {
        matches.push({ path: wt.path, branch: wt.branch, repoName: repo.repoName });
      }
    }
  }

  if (matches.length === 0) {
    const writer = opts?.stderr ? process.stderr : process.stdout;
    writer.write(`\n  no worktree found matching branch: "${branch}"\n\n`);
    process.exit(1);
  }

  if (matches.length === 1) return matches[0]!.path;

  // Ambiguous — show a picker limited to the matching worktrees
  const picked = await filterableSelect({
    message: `Pick worktree ("${branch}"…)`,
    options: matches.map((m) => ({
      value: m.path,
      label: m.branch,
      hint: repos.length > 1 ? m.repoName : m.path.replace(process.env.HOME ?? "", "~"),
    })),
    ...(opts?.stderr ? { stderr: true } : {}),
  });

  if (!picked) process.exit(1);
  return picked;
}
