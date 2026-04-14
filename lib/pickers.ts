/**
 * Shared picker flows for repo + worktree selection.
 *
 * Used by cd.ts and code.ts to avoid duplicating the
 * repo → worktree two-step picker with "switch repo" escape hatch.
 */

import { execSync } from "child_process";
import { getRepoIdentity, getKnownRepos, pickWorktreeFromRepo, type KnownRepo } from "./repo.ts";
import { enrichBranches, formatBranchLabel } from "./enrich.ts";

const SWITCH_REPO = "__switch_repo__" as const;

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
  const { filterableSelect } = await import("./rt-render.tsx");

  if (repo.worktrees.length === 0) return SWITCH_REPO;

  const remoteUrl = await getRemoteUrl(repo.worktrees[0]?.path || currentPath);
  const options = await buildWorktreeOptions(repo.worktrees, remoteUrl);

  // Annotate the current worktree so the user knows where they are
  for (const opt of options) {
    if (opt.value === currentPath) opt.hint = "(current)";
  }

  options.unshift({
    value: SWITCH_REPO,
    label: "↩ Switch to a different repo",
    hint: "",
  });

  return filterableSelect({
    message: `${repo.repoName} worktrees`,
    options,
    ...(opts?.stderr ? { stderr: true } : {}),
  });
}

/**
 * Two-step repo → worktree picker from all known repos.
 * Auto-selects when there's only one option at either step.
 */
export async function pickFromAllRepos(
  repos: KnownRepo[],
  opts?: { stderr?: boolean; errorMessage?: string },
): Promise<string> {
  const { filterableSelect, BackNavigation } = await import("./rt-render.tsx");

  if (repos.length === 0) {
    const msg = opts?.errorMessage || "no known repos found — run rt from inside a git repo first";
    const writer = opts?.stderr ? console.error : console.log;
    writer(`\n  ${msg}\n`);
    process.exit(1);
  }

  // Loop: back from worktree picker restarts at repo picker
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
      selectedRepo = repos.find(r => r.repoName === picked)!;
    }

    if (selectedRepo.worktrees.length === 1) {
      return selectedRepo.worktrees[0]!.path;
    }

    try {
      return await pickWorktreeFromRepo(
        selectedRepo,
        `${selectedRepo.repoName} worktrees`,
        { backLabel: repos.length > 1 ? "Switch repo" : undefined },
      );
    } catch (err) {
      if (err instanceof BackNavigation) continue;
      throw err;
    }
  }
}

/** Check if user chose to switch repos. */
export function isSwitchRepo(value: string): boolean {
  return value === SWITCH_REPO;
}
