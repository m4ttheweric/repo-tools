/**
 * rt git reset — Safe reset with divergence detection.
 *
 * Three modes:
 *   --origin      Reset to origin/current-branch (after GitLab rebase button)
 *   --head --soft Soft reset to HEAD (unstage)
 *   --head --hard Hard reset to HEAD (discard changes)
 *
 * The --origin flow:
 *   1. Fetch origin
 *   2. Compare local HEAD vs origin/<branch> using patch-id
 *   3. Detect: identical / behind / diverged (same patches) / diverged (extra commits)
 *   4. If extra local commits: offer to reset + cherry-pick
 *   5. Creates backup branch before any destructive operation
 *
 * Programmatic API (used by rt sync):
 *   resetToOrigin(cwd) → ResetResult
 */

import { execSync, spawnSync } from "child_process";
import { bold, cyan, dim, green, yellow, red, reset } from "../../lib/tui.ts";
import { getCurrentBranch, hasUncommittedChanges } from "../../lib/git-ops.ts";
import { createBackup } from "../../lib/git-backup.ts";
import { syncLog } from "../../lib/sync-log.ts";
import type { CommandContext } from "../../lib/command-tree.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ResetStatus =
  | "in-sync"       // local == origin
  | "fast-forward"  // local is behind, no divergence
  | "reset"         // diverged, all patches on remote — simple reset
  | "cherry-picked" // diverged, local had extra commits — reset + cherry-pick
  | "error";

export interface ResetResult {
  status: ResetStatus;
  /** Branch that was reset. */
  branch: string;
  /** Commits that were cherry-picked on top of the reset. */
  cherryPicked: string[];
  /** Backup branch created before reset. */
  backupBranch: string | null;
  /** Error message if status is "error". */
  error?: string;
}

export interface ResetOptions {
  cwd: string;
  /** If true, suppress output. */
  quiet?: boolean;
  /** If true, skip the confirmation prompt for cherry-picks. */
  autoConfirm?: boolean;
  /** If true, skip git fetch (caller already fetched). */
  skipFetch?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function git(args: string, cwd: string): string {
  let stdout = "";
  let stderr = "";
  try {
    stdout = execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    syncLog.cmd(args, cwd, 0, stdout, "");
    return stdout;
  } catch (err: any) {
    stderr = err?.stderr ?? "";
    stdout = err?.stdout ?? "";
    syncLog.cmd(args, cwd, err?.status ?? 1, stdout, stderr);
    throw err;
  }
}

function log(msg: string, quiet?: boolean): void {
  if (!quiet) process.stderr.write(msg);
}

/**
 * Get the patch-id set for a range of commits.
 * Returns a Map of patch-id → commit SHA.
 *
 * Patch-IDs are content-based hashes of the diff — two commits with the
 * same code change but different SHAs (e.g. after a rebase) share the
 * same patch-id.
 */
function getPatchIds(revRange: string, cwd: string): Map<string, string> {
  const result = new Map<string, string>();
  try {
    // git log outputs patches, patch-id reads them
    const stdout = execSync(
      `git log --format="%H" --reverse ${revRange} | while read sha; do echo "$sha $(git diff-tree -p $sha | git patch-id --stable | cut -d' ' -f1)"; done`,
      { cwd, encoding: "utf8", stdio: "pipe", shell: "/bin/bash" },
    ).trim();

    for (const line of stdout.split("\n")) {
      const parts = line.trim().split(" ");
      if (parts.length === 2 && parts[0] && parts[1]) {
        const [sha, patchId] = parts;
        result.set(patchId!, sha!);
      }
    }
  } catch { /* no commits in range */ }
  return result;
}

/**
 * Get commit info for display.
 */
function getCommitOneliner(sha: string, cwd: string): string {
  try {
    return git(`log --oneline -1 ${sha}`, cwd);
  } catch {
    return sha;
  }
}

// ─── Core reset-to-origin logic ──────────────────────────────────────────────

/**
 * Sync the current branch with its remote counterpart.
 * Used after someone (or GitLab's rebase button) rewrote the remote history.
 */
export async function resetToOrigin(opts: ResetOptions): Promise<ResetResult> {
  const { cwd, quiet, autoConfirm } = opts;
  const branch = getCurrentBranch(cwd);

  if (!branch) {
    return {
      status: "error",
      branch: "HEAD",
      cherryPicked: [],
      backupBranch: null,
      error: "not on a branch (detached HEAD)",
    };
  }

  // Guard: refuse to proceed with uncommitted changes (reset --hard would destroy them)
  if (hasUncommittedChanges(cwd)) {
    return {
      status: "error",
      branch,
      cherryPicked: [],
      backupBranch: null,
      error: "uncommitted changes — commit or stash before syncing",
    };
  }

  const remoteBranch = `origin/${branch}`;

  // 1. Fetch (unless caller already did)
  if (!opts.skipFetch) {
    const { withSpinner } = await import("../../lib/rt-render.tsx");
    const { exec } = await import("child_process");
    const gitAsync = (args: string) =>
      new Promise<void>((resolve, reject) => {
        exec(`git ${args}`, { cwd }, (err) => (err ? reject(err) : resolve()));
      });
    try {
      await withSpinner("fetching origin…", () => gitAsync("fetch origin"), {
        doneLabel: "origin fetched",
      });
    } catch (err) {
      return {
        status: "error",
        branch,
        cherryPicked: [],
        backupBranch: null,
        error: `fetch failed: ${err}`,
      };
    }
  }

  // 2. Check if remote branch exists
  try {
    git(`rev-parse --verify ${remoteBranch}`, cwd);
  } catch {
    return {
      status: "error",
      branch,
      cherryPicked: [],
      backupBranch: null,
      error: `remote branch ${remoteBranch} does not exist`,
    };
  }

  // 3. Compare local and remote
  const localSha = git("rev-parse HEAD", cwd);
  const remoteSha = git(`rev-parse ${remoteBranch}`, cwd);

  // Case A: Identical
  if (localSha === remoteSha) {
    log(`  ${green}✓${reset} ${bold}${branch}${reset} ${dim}already in sync with ${remoteBranch}${reset}\n`, quiet);
    return { status: "in-sync", branch, cherryPicked: [], backupBranch: null };
  }

  // Check merge base to understand relationship
  const mergeBase = git(`merge-base HEAD ${remoteBranch}`, cwd);

  // Case B: Local is behind (remote has new commits, local hasn't diverged)
  if (mergeBase === localSha) {
    log(`  ${dim}fast-forwarding to ${remoteBranch}…${reset}\n`, quiet);
    git(`merge --ff-only ${remoteBranch}`, cwd);
    log(`  ${green}✓${reset} ${bold}${branch}${reset} ${dim}fast-forwarded to ${remoteBranch}${reset}\n`, quiet);
    return { status: "fast-forward", branch, cherryPicked: [], backupBranch: null };
  }

  // Diverged — need to figure out if we have extra commits

  // 4. Get patch-ids for both sides
  const localPatches = getPatchIds(`${mergeBase}..HEAD`, cwd);
  const remotePatches = getPatchIds(`${mergeBase}..${remoteBranch}`, cwd);

  // Find local commits whose patch-id is NOT on the remote
  // These are genuinely extra local commits (not just rebased versions)
  const remotePatchIds = new Set(remotePatches.keys());
  const extraCommits: string[] = [];
  for (const [patchId, sha] of localPatches) {
    if (!remotePatchIds.has(patchId)) {
      extraCommits.push(sha);
    }
  }

  // 5. Create backup before any destructive operation (mandatory)
  let backupBranch: string | null = null;
  try {
    backupBranch = createBackup("reset", cwd);
    log(`  ${dim}backup → ${backupBranch}${reset}\n`, quiet);
  } catch (err) {
    return {
      status: "error",
      branch,
      cherryPicked: [],
      backupBranch: null,
      error: `could not create backup branch: ${err}`,
    };
  }

  if (extraCommits.length === 0) {
    // Case C: Diverged but same content — simple reset
    log(`  ${dim}remote was rebased — resetting to ${remoteBranch}…${reset}\n`, quiet);
    git(`reset --hard ${remoteBranch}`, cwd);
    log(`  ${green}✓${reset} ${bold}${branch}${reset} ${dim}reset to ${remoteBranch}${reset}\n`, quiet);
    return { status: "reset", branch, cherryPicked: [], backupBranch };
  }

  // Case D: Diverged with extra local commits
  log(`\n  ${yellow}⚠${reset} ${bold}${branch}${reset} has ${extraCommits.length} extra commit${extraCommits.length !== 1 ? "s" : ""} not on remote:\n`, quiet);
  for (const sha of extraCommits) {
    log(`    ${dim}•${reset} ${getCommitOneliner(sha, cwd)}\n`, quiet);
  }

  if (!autoConfirm) {
    log(`\n  ${dim}Will reset to ${remoteBranch} and cherry-pick these on top.${reset}\n`, quiet);
    // In interactive mode, we could prompt for confirmation.
    // For now, proceed — the backup is our safety net.
    const { confirm: inkConfirm } = await import("../../lib/rt-render.tsx");
    const ok = await inkConfirm({
      message: "Reset + cherry-pick?",
      initialValue: true,
    });

    if (!ok) {
      log(`\n  ${dim}aborted${reset}\n`, quiet);
      // Delete the backup we just created since we're not doing anything
      if (backupBranch) {
        try { git(`branch -D "${backupBranch}"`, cwd); } catch { /* */ }
      }
      return {
        status: "error",
        branch,
        cherryPicked: [],
        backupBranch: null,
        error: "cancelled by user",
      };
    }
  }

  // Reset to remote
  git(`reset --hard ${remoteBranch}`, cwd);
  log(`  ${dim}reset to ${remoteBranch}${reset}\n`, quiet);

  // Cherry-pick extra commits
  const pickedShas: string[] = [];
  for (const sha of extraCommits) {
    const result = spawnSync("git", ["cherry-pick", sha], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    syncLog.cmd(["cherry-pick", sha], cwd, result.status, result.stdout ?? "", result.stderr ?? "");

    if (result.status !== 0) {
      // Cherry-pick conflict — abort and report
      spawnSync("git", ["cherry-pick", "--abort"], { cwd, stdio: "pipe" });
      log(`  ${red}✗${reset} cherry-pick conflict on ${getCommitOneliner(sha, cwd)}\n`, quiet);
      if (backupBranch) {
        log(`  ${dim}restore with: rt git restore${reset}\n`, quiet);
      }
      return {
        status: "error",
        branch,
        cherryPicked: pickedShas,
        backupBranch,
        error: `cherry-pick conflict on ${sha.slice(0, 7)}`,
      };
    }

    pickedShas.push(sha);
    log(`    ${green}✓${reset} ${getCommitOneliner(sha, cwd)}\n`, quiet);
  }

  log(`  ${green}✓${reset} ${bold}${branch}${reset} synced with remote, cherry-picked ${pickedShas.length} commit${pickedShas.length !== 1 ? "s" : ""}\n`, quiet);
  return { status: "cherry-picked", branch, cherryPicked: pickedShas, backupBranch };
}

// ─── CLI handler ─────────────────────────────────────────────────────────────

// ─── CLI handlers ────────────────────────────────────────────────────────────

/** rt git reset origin — sync with remote branch */
export async function originCommand(
  _args: string[],
  ctx: CommandContext,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;
  const result = await resetToOrigin({ cwd });

  if (result.status === "error") {
    console.error(`\n  ${red}${result.error}${reset}\n`);
    process.exit(1);
  }
  console.log("");
}

/** rt git reset soft — soft reset to HEAD (unstage) */
export async function softResetCommand(
  _args: string[],
  ctx: CommandContext,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;
  git("reset --soft HEAD", cwd);
  console.log(`  ${green}✓${reset} soft reset to HEAD\n`);
}

/** rt git reset hard — hard reset to HEAD (discard all changes) */
export async function hardResetCommand(
  _args: string[],
  ctx: CommandContext,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;

  // Create backup before hard reset
  try {
    const backupBranch = createBackup("reset", cwd);
    console.log(`  ${dim}backup → ${backupBranch}${reset}`);
  } catch { /* best-effort */ }

  git("reset --hard HEAD", cwd);
  console.log(`  ${green}✓${reset} hard reset to HEAD\n`);
}
