/**
 * rt sync — Daily workflow sync composer.
 *
 * Smart enough to detect the situation and do the right thing:
 *
 *   1. Fetch origin
 *   2. If local diverged from origin/your-branch → resetToOrigin (GitLab rebase scenario)
 *   3. If behind origin/master → rebaseOnto (daily catch-up)
 *   4. Push if anything changed (--force-with-lease)
 *
 * Usage:
 *   rt sync                  sync current worktree
 *   rt sync all               sync all worktrees with open MRs
 *   rt sync --dry-run         show what would happen
 */

import { exec, execSync, spawnSync } from "child_process";
import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";
import { getCurrentBranch, getRemoteDefaultBranch, hasUncommittedChanges } from "../lib/git-ops.ts";
import { loadSyncConfig } from "../lib/sync-config.ts";
import { rebaseOnto, type RebaseResult } from "./git/rebase.ts";
import { resetToOrigin, type ResetResult } from "./git/reset.ts";
import { syncLog } from "../lib/sync-log.ts";
import type { CommandContext } from "../lib/command-tree.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SyncSummary {
  branch: string;
  worktree: string;
  resetResult: ResetResult | null;
  rebaseResult: RebaseResult | null;
  pushed: boolean;
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

/** Non-blocking git command — allows spinners to animate. */
function gitAsync(args: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`git ${args}`, { cwd, encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout ?? "").trim());
    });
  });
}

/**
 * Check if local and origin/branch have diverged (i.e. neither is an ancestor of the other).
 */
function hasDivergedFromRemote(branch: string, cwd: string): boolean {
  const remoteBranch = `origin/${branch}`;
  try {
    git(`rev-parse --verify ${remoteBranch}`, cwd);
  } catch {
    return false; // remote branch doesn't exist — not diverged
  }

  const localSha = git("rev-parse HEAD", cwd);
  const remoteSha = git(`rev-parse ${remoteBranch}`, cwd);

  if (localSha === remoteSha) return false; // identical

  const mergeBase = git(`merge-base HEAD ${remoteBranch}`, cwd);
  // Diverged if merge-base is neither the local nor the remote SHA
  // (i.e. both sides have commits beyond the common ancestor)
  return mergeBase !== localSha && mergeBase !== remoteSha;
}

/**
 * Check if there are commits to push.
 */
function hasUnpushedCommits(branch: string, cwd: string): boolean {
  try {
    const count = git(`rev-list --count origin/${branch}..HEAD`, cwd);
    return parseInt(count, 10) > 0;
  } catch {
    return false;
  }
}

// ─── Single-branch sync ─────────────────────────────────────────────────────

async function syncBranch(
  cwd: string,
  dataDir: string,
  opts: { dryRun?: boolean; quiet?: boolean },
): Promise<SyncSummary> {
  // Guard: rebase-in-progress takes priority — getCurrentBranch returns null
  // during a rebase, which would cause a confusing "detached HEAD" error later.
  try {
    const { spawnSync } = await import("child_process");
    const r = spawnSync("git", ["rebase", "--show-current-patch"], {
      cwd, stdio: "pipe",
    });
    if (r.status === 0) {
      return {
        branch: "HEAD",
        worktree: cwd,
        resetResult: null,
        rebaseResult: null,
        pushed: false,
        error: "rebase in progress — run 'git rebase --abort' or '--continue' first",
      };
    }
  } catch { /* git too old to support --show-current-patch, ignore */ }

  const branch = getCurrentBranch(cwd);
  if (!branch) {
    return {
      branch: "HEAD",
      worktree: cwd,
      resetResult: null,
      rebaseResult: null,
      pushed: false,
      error: "not on a branch (detached HEAD)",
    };
  }


  const defaultBranch = getRemoteDefaultBranch(cwd);
  const defaultBranchName = defaultBranch?.replace("origin/", "") ?? "master";

  // Don't sync the default branch itself
  if (branch === defaultBranchName) {
    if (!opts.quiet) {
      console.log(`  ${dim}${branch} is the default branch — skipping${reset}`);
    }
    return {
      branch,
      worktree: cwd,
      resetResult: null,
      rebaseResult: null,
      pushed: false,
    };
  }

  // Guard: refuse to sync with uncommitted changes
  if (hasUncommittedChanges(cwd)) {
    return {
      branch,
      worktree: cwd,
      resetResult: null,
      rebaseResult: null,
      pushed: false,
      error: "uncommitted changes — commit or stash before syncing",
    };
  }

  const config = loadSyncConfig(dataDir);
  let resetResult: ResetResult | null = null;
  let rebaseResult: RebaseResult | null = null;
  let needsPush = false;

  syncLog.worktree(cwd, branch);

  const { createStepRunner } = await import("../lib/rt-render.tsx");
  const steps = createStepRunner();

  // 1. Fetch once (rebase/reset will skip their own fetch)
  try {
    await steps.run("fetching origin…", () => gitAsync("fetch origin", cwd), {
      done: "origin fetched",
    });
  } catch (err) {
    return {
      branch,
      worktree: cwd,
      resetResult: null,
      rebaseResult: null,
      pushed: false,
      error: `fetch failed: ${err}`,
    };
  }

  // 2. Check if diverged from origin/your-branch (GitLab rebase scenario)
  if (hasDivergedFromRemote(branch, cwd)) {
    steps.log(`diverged from origin/${branch} — syncing with remote first`, "warn");

    if (opts.dryRun) {
      steps.log(`would reset to origin/${branch}`);
    } else {
      resetResult = await resetToOrigin({
        cwd,
        quiet: opts.quiet,
        autoConfirm: true,
        skipFetch: true,
      });

      syncLog.phase("reset-to-origin", resetResult as unknown as Record<string, unknown>);

      if (resetResult.status === "error") {
        syncLog.worktreeEnd(branch, resetResult.error);
        return {
          branch,
          worktree: cwd,
          resetResult,
          rebaseResult: null,
          pushed: false,
          error: resetResult.error,
        };
      }

      if (resetResult.status !== "in-sync") {
        needsPush = true;
      }
    }
  }

  // 3. Check if behind origin/master — rebase
  rebaseResult = await rebaseOnto({
    cwd,
    dataDir,
    autoResolve: config.autoResolve,
    dryRun: opts.dryRun,
    quiet: opts.quiet,
    skipFetch: true,
  });

  syncLog.phase("rebase-onto", rebaseResult as unknown as Record<string, unknown>);

  if (rebaseResult.status === "error" || rebaseResult.status === "conflict") {
    syncLog.worktreeEnd(branch, rebaseResult.status === "error" ? rebaseResult.error : "unresolvable conflicts");
    return {
      branch,
      worktree: cwd,
      resetResult,
      rebaseResult,
      pushed: false,
      error: rebaseResult.status === "error" ? rebaseResult.error : "unresolvable conflicts",
    };
  }

  if (rebaseResult.status === "ok") {
    needsPush = true;
  }

  // 4. Push if anything changed
  let pushed = false;
  if (needsPush && !opts.dryRun) {
    try {
      await steps.run("pushing…", () =>
        gitAsync(`push --force-with-lease origin ${branch}`, cwd),
        { done: "pushed" },
      );
      pushed = true;
      syncLog.cmd(`push --force-with-lease origin ${branch}`, cwd, 0, "", "");
    } catch (err: any) {
      syncLog.cmd(`push --force-with-lease origin ${branch}`, cwd, 1, "", String(err));
      // steps.run already printed the ✗ error line
    }
  }

  syncLog.worktreeEnd(branch, undefined);
  return { branch, worktree: cwd, resetResult, rebaseResult, pushed };
}

// ─── Multi-worktree sync ─────────────────────────────────────────────────────

async function syncAll(
  repoName: string,
  opts: { dryRun?: boolean },
): Promise<void> {
  // Get all worktrees from daemon cache
  const { daemonQuery, isDaemonRunning } = await import("../lib/daemon-client.ts");
  const running = await isDaemonRunning();

  if (!running) {
    console.error(`\n  ${yellow}daemon not running — start with: rt daemon start${reset}`);
    console.error(`  ${dim}--all requires the daemon for worktree discovery${reset}\n`);
    process.exit(1);
  }

  // Get repos + cache to filter branches with open MRs
  const reposResult = await daemonQuery("repos");


  if (!reposResult?.ok || !reposResult.data) {
    console.error(`\n  ${red}failed to get repos from daemon${reset}\n`);
    process.exit(1);
  }

  // daemon "repos" response: { repos: { [name]: { path, worktrees } }, watched: [...] }
  const repoMap = (reposResult.data as any)?.repos as Record<
    string,
    { path: string; worktrees: { path: string; branch: string }[] }
  > | undefined;

  if (!repoMap) {
    console.error(`\n  ${red}unexpected repos response from daemon${reset}\n`);
    process.exit(1);
  }

  const repoEntry = repoMap[repoName];
  if (!repoEntry) {
    console.error(`\n  ${yellow}repo "${repoName}" not known to daemon — is it registered?${reset}\n`);
    process.exit(1);
  }

  // Use daemon's worktree list directly (no need to re-run git worktree list)
  const worktrees = repoEntry.worktrees.map((wt) => ({
    repoName,
    path: wt.path,
    branch: wt.branch,
  }));


  // Filter to branches with open MRs (or just sync all — user might want both)
  const defaultBranches = new Set(["main", "master", "develop"]);

  const syncable = worktrees.filter((wt) => {
    // Skip default branches
    if (defaultBranches.has(wt.branch)) return false;
    // Skip detached HEADs
    if (wt.branch === "HEAD") return false;
    return true;
  });

  if (syncable.length === 0) {
    console.log(`\n  ${dim}no feature branches to sync${reset}\n`);
    return;
  }

  console.log(`\n  ${bold}${cyan}rt sync all${reset} ${dim}(${syncable.length} branches)${reset}\n`);

  const summaries: SyncSummary[] = [];

  for (const wt of syncable) {
    console.log(`  ${bold}${wt.repoName}${reset} ${dim}(${wt.branch})${reset}`);

    // We need to resolve the dataDir for each repo
    const { getRepoIdentity } = await import("../lib/repo.ts");
    const origCwd = process.cwd();
    process.chdir(wt.path);
    const identity = getRepoIdentity();
    process.chdir(origCwd);

    if (!identity) {
      console.log(`    ${yellow}⚠ could not resolve identity — skipping${reset}`);
      summaries.push({
        branch: wt.branch,
        worktree: wt.path,
        resetResult: null,
        rebaseResult: null,
        pushed: false,
        error: "could not resolve repo identity",
      });
      console.log("");
      continue;
    }

    const summary = await syncBranch(wt.path, identity.dataDir, {
      dryRun: opts.dryRun,
      quiet: false,
    });
    summaries.push(summary);
    console.log("");
  }

  // Aggregate summary
  const ok = summaries.filter((s) => !s.error);
  const failed = summaries.filter((s) => s.error);
  const pushed = summaries.filter((s) => s.pushed);
  const upToDate = summaries.filter(
    (s) => !s.error && s.rebaseResult?.status === "up-to-date" && !s.resetResult,
  );

  console.log(`  ${dim}─────────────────────────────${reset}`);
  if (ok.length > 0) {
    console.log(`  ${green}✓${reset} ${ok.length} synced (${pushed.length} pushed, ${upToDate.length} up to date)`);
  }
  if (failed.length > 0) {
    console.log(`  ${red}✗${reset} ${failed.length} failed:`);
    for (const f of failed) {
      console.log(`    ${red}•${reset} ${f.branch} — ${f.error}`);
    }
  }
  console.log("");
}

// ─── CLI handler ─────────────────────────────────────────────────────────────

/** rt sync all — syncs all worktrees of the current repo (repo context only) */
export async function syncAllCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const repoName = ctx.identity!.repoName;
  syncLog.start(`rt sync all  repo=${repoName}${dryRun ? "  --dry-run" : ""}`);
  try {
    await syncAll(repoName, { dryRun });
  } finally {
    syncLog.end();
  }
}

export async function syncCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const dryRun = args.includes("--dry-run");

  // Single worktree sync
  const cwd = ctx.identity!.repoRoot;
  const dataDir = ctx.identity!.dataDir;

  console.log(`\n  ${bold}${cyan}rt sync${reset}\n`);

  syncLog.start(`rt sync  cwd=${cwd}${dryRun ? "  --dry-run" : ""}`);
  let summary;
  try {
    summary = await syncBranch(cwd, dataDir, { dryRun });
  } finally {
    syncLog.end();
  }

  if (summary.error) {
    console.error(`\n  ${red}${summary.error}${reset}\n`);
    process.exit(1);
  }

  console.log("");
}
