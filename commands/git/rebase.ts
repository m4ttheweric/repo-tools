/**
 * rt git rebase — Smart rebase with auto-resolve rules.
 *
 * Rebases the current branch onto origin/master (or origin/main) with:
 *   - Auto-backup before rebase (rt-backup/rebase/<branch>/<timestamp>)
 *   - Auto-resolve rules for known-trivial conflicts (lockfiles, generated files)
 *   - Per-rule postResolve steps (e.g. "pnpm install" after lockfile resolve)
 *   - Auto-abort if any conflict can't be resolved by rules
 *
 * Usage:
 *   rt git rebase                 rebase onto origin/default-branch
 *   rt git rebase --onto=main     explicit target
 *   rt git rebase --dry-run       show what would happen
 *
 * Programmatic API (used by rt sync):
 *   rebaseOnto(cwd, opts) → RebaseResult
 */

import { execSync, spawnSync } from "child_process";
import { bold, cyan, dim, green, yellow, red, reset } from "../../lib/tui.ts";
import { getRemoteDefaultBranch, getCurrentBranch, hasUncommittedChanges } from "../../lib/git-ops.ts";
import { createBackup } from "../../lib/git-backup.ts";
import { syncLog } from "../../lib/sync-log.ts";
import {
  loadSyncConfig,
  classifyConflicts,
  collectPostResolveSteps,
  ruleGlobs,
  type AutoResolveRule,
} from "../../lib/sync-config.ts";
import type { CommandContext } from "../../lib/command-tree.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RebaseResult {
  status: "ok" | "up-to-date" | "conflict" | "error";
  /** Branch that was rebased. */
  branch: string;
  /** Target that was rebased onto (e.g. "origin/master"). */
  target: string;
  /** Number of commits the branch was behind. */
  commitsBehind: number;
  /** Files that were auto-resolved by rules. */
  resolvedFiles: string[];
  /** Files that couldn't be resolved (caused abort). */
  unresolvedFiles: string[];
  /** Post-resolve steps that were executed. */
  postResolveSteps: string[];
  /** Backup branch created before rebase. */
  backupBranch: string | null;
  /** Error message if status is "error". */
  error?: string;
}

export interface RebaseOptions {
  /** Target ref to rebase onto (default: auto-detect origin/master or origin/main). */
  target?: string;
  /** Auto-resolve rules (default: loaded from ~/.rt/<repo>/sync.json). */
  autoResolve?: AutoResolveRule[];
  /** If true, show what would happen without doing it. */
  dryRun?: boolean;
  /** Working directory. */
  cwd: string;
  /** Repo data dir for loading config (e.g. ~/.rt/<repo>). */
  dataDir?: string;
  /** If true, suppress output (used when called from rt sync --all). */
  quiet?: boolean;
  /** If true, skip git fetch (caller already fetched). */
  skipFetch?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function git(args: string, cwd: string): string {
  let stdout = "";
  try {
    stdout = execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    syncLog.cmd(args, cwd, 0, stdout, "");
    return stdout;
  } catch (err: any) {
    syncLog.cmd(args, cwd, err?.status ?? 1, err?.stdout ?? "", err?.stderr ?? "");
    throw err;
  }
}

function gitSafe(args: string, cwd: string): { ok: boolean; stdout: string } {
  const argArr = args.split(" ");
  const result = spawnSync("git", argArr, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  syncLog.cmd(argArr, cwd, result.status, result.stdout ?? "", result.stderr ?? "");
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

function log(msg: string, quiet?: boolean): void {
  if (!quiet) process.stderr.write(msg);
}

/**
 * Get the list of conflicted files during a rebase.
 */
function getConflictedFiles(cwd: string): string[] {
  try {
    const stdout = git("diff --name-only --diff-filter=U", cwd);
    return stdout.split("\n").filter((f) => f.trim());
  } catch {
    return [];
  }
}

/**
 * Count how many commits the current branch is behind a target.
 */
function commitsBehind(target: string, cwd: string): number {
  try {
    const count = git(`rev-list --count HEAD..${target}`, cwd);
    return parseInt(count, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Check if a rebase is currently in progress.
 */
function isRebaseInProgress(cwd: string): boolean {
  const { ok } = gitSafe("rebase --show-current-patch", cwd);
  return ok;
}

// ─── Core rebase logic ───────────────────────────────────────────────────────

/**
 * Programmatic rebase API. Used by both the CLI handler and rt sync.
 */
export async function rebaseOnto(opts: RebaseOptions): Promise<RebaseResult> {
  const { cwd, dryRun, quiet } = opts;
  const branch = getCurrentBranch(cwd);

  if (!branch) {
    return {
      status: "error",
      branch: "HEAD",
      target: "",
      commitsBehind: 0,
      resolvedFiles: [],
      unresolvedFiles: [],
      postResolveSteps: [],
      backupBranch: null,
      error: "not on a branch (detached HEAD)",
    };
  }

  // Guard: refuse to rebase with uncommitted changes (they'd be lost on conflict abort)
  if (hasUncommittedChanges(cwd)) {
    return {
      status: "error",
      branch,
      target: "",
      commitsBehind: 0,
      resolvedFiles: [],
      unresolvedFiles: [],
      postResolveSteps: [],
      backupBranch: null,
      error: "uncommitted changes — commit or stash before rebasing",
    };
  }

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
        target: "",
        commitsBehind: 0,
        resolvedFiles: [],
        unresolvedFiles: [],
        postResolveSteps: [],
        backupBranch: null,
        error: `fetch failed: ${err}`,
      };
    }
  }

  // 2. Detect target
  const target = opts.target ?? getRemoteDefaultBranch(cwd);
  if (!target) {
    return {
      status: "error",
      branch,
      target: "",
      commitsBehind: 0,
      resolvedFiles: [],
      unresolvedFiles: [],
      postResolveSteps: [],
      backupBranch: null,
      error: "could not detect default branch (no origin/main or origin/master)",
    };
  }

  // Guard: don't rebase the default branch onto itself
  const targetBranchName = target.replace(/^origin\//, "");
  if (branch === targetBranchName) {
    log(`  ${dim}${branch} is the default branch — nothing to rebase${reset}\n`, quiet);
    return {
      status: "up-to-date",
      branch,
      target,
      commitsBehind: 0,
      resolvedFiles: [],
      unresolvedFiles: [],
      postResolveSteps: [],
      backupBranch: null,
    };
  }

  // 3. Check if behind
  const behind = commitsBehind(target, cwd);
  if (behind === 0) {
    log(`  ${green}✓${reset} ${bold}${branch}${reset} ${dim}already up to date with ${target}${reset}\n`, quiet);
    return {
      status: "up-to-date",
      branch,
      target,
      commitsBehind: 0,
      resolvedFiles: [],
      unresolvedFiles: [],
      postResolveSteps: [],
      backupBranch: null,
    };
  }

  // 4. Load auto-resolve rules
  const rules = opts.autoResolve ?? (opts.dataDir ? loadSyncConfig(opts.dataDir).autoResolve : []);

  // 5. Dry run
  if (dryRun) {
    log(`  ${dim}would rebase${reset} ${bold}${branch}${reset} ${dim}onto ${target} (${behind} commit${behind !== 1 ? "s" : ""} behind)${reset}\n`, quiet);
    if (rules.length > 0) {
      log(`  ${dim}auto-resolve rules: ${rules.flatMap(ruleGlobs).join(", ")}${reset}\n`, quiet);
    }
    return {
      status: "ok",
      branch,
      target,
      commitsBehind: behind,
      resolvedFiles: [],
      unresolvedFiles: [],
      postResolveSteps: [],
      backupBranch: null,
    };
  }

  // 6. Create backup (mandatory — refuse to proceed without one)
  let backupBranch: string | null = null;
  try {
    backupBranch = createBackup("rebase", cwd);
    log(`  ${dim}backup → ${backupBranch}${reset}\n`, quiet);
  } catch (err) {
    return {
      status: "error",
      branch,
      target,
      commitsBehind: behind,
      resolvedFiles: [],
      unresolvedFiles: [],
      postResolveSteps: [],
      backupBranch: null,
      error: `could not create backup branch: ${err}`,
    };
  }

  // 7. Rebase
  log(`  ${dim}rebasing${reset} ${bold}${branch}${reset} ${dim}onto ${target} (${behind} behind)…${reset}\n`, quiet);

  const allResolvedFiles: string[] = [];
  const triggeredRules = new Set<AutoResolveRule>();
  let rebaseActive = true;

  // Start the rebase
  const startResult = spawnSync("git", ["rebase", target], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  syncLog.cmd(["rebase", target], cwd, startResult.status, startResult.stdout ?? "", startResult.stderr ?? "");

  if (startResult.status === 0) {
    // Clean rebase — no conflicts
    rebaseActive = false;
  }

  // Conflict resolution loop
  while (rebaseActive) {
    const conflicted = getConflictedFiles(cwd);
    if (conflicted.length === 0) {
      // No conflicts at this step — try to continue
      const contResult = spawnSync("git", ["rebase", "--continue"], {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, GIT_EDITOR: "true" },
      });
      syncLog.cmd(["rebase", "--continue"], cwd, contResult.status, contResult.stdout ?? "", contResult.stderr ?? "");
      if (contResult.status === 0) {
        rebaseActive = false;
        break;
      }
      // If continue failed but no conflicts, something else is wrong
      if (getConflictedFiles(cwd).length === 0) {
        git("rebase --abort", cwd);
        return {
          status: "error",
          branch,
          target,
          commitsBehind: behind,
          resolvedFiles: allResolvedFiles,
          unresolvedFiles: [],
          postResolveSteps: [],
          backupBranch,
          error: `rebase --continue failed unexpectedly`,
        };
      }
      // Otherwise fall through to handle the new conflicts
      continue;
    }

    // Classify conflicts against rules
    const { matched, unmatched } = classifyConflicts(conflicted, rules);

    if (unmatched.length > 0) {
      // Can't auto-resolve — abort
      log(`\n  ${red}✗${reset} ${unmatched.length} unresolvable conflict${unmatched.length !== 1 ? "s" : ""}:\n`, quiet);
      for (const f of unmatched) {
        log(`    ${red}•${reset} ${f}\n`, quiet);
      }
      git("rebase --abort", cwd);
      if (backupBranch) {
        log(`  ${dim}backup at ${backupBranch}${reset}\n`, quiet);
      }
      return {
        status: "conflict",
        branch,
        target,
        commitsBehind: behind,
        resolvedFiles: allResolvedFiles,
        unresolvedFiles: unmatched,
        postResolveSteps: [],
        backupBranch,
      };
    }

    // All conflicts matched rules — resolve them
    for (const { file, rule } of matched) {
      const flag = rule.strategy === "theirs" ? "--theirs" : "--ours";
      git(`checkout ${flag} -- "${file}"`, cwd);
      git(`add "${file}"`, cwd);
      allResolvedFiles.push(file);
      triggeredRules.add(rule);
      log(`    ${green}✓${reset} ${dim}auto-resolved${reset} ${file} ${dim}(${rule.strategy})${reset}\n`, quiet);
    }

    // Continue the rebase
    const contResult = spawnSync("git", ["rebase", "--continue"], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, GIT_EDITOR: "true" },
    });

    if (contResult.status === 0) {
      rebaseActive = false;
    }
    // else: more conflicts on the next commit — loop continues
  }

  // 8. Run triggered postResolve steps
  const postResolveSteps = collectPostResolveSteps(
    allResolvedFiles.map((file) => {
      const rule = [...triggeredRules].find((r) =>
        ruleGlobs(r).some((g) => {
          try { return new Bun.Glob(g).match(file); } catch { return false; }
        }),
      );
      return { file, rule: rule! };
    }).filter((m) => m.rule),
  );

  // Use the user's login shell so profile-sourced PATH additions (pnpm,
  // corepack, volta, nvm, etc.) are available. Plain `sh -c` inherits only
  // the parent env and misses shell-rc-managed bins.
  const userShell = process.env.SHELL || "/bin/zsh";
  let failedStep: { step: string; status: number | null; signal: NodeJS.Signals | null } | null = null;

  for (const step of postResolveSteps) {
    log(`  ${dim}running:${reset} ${step}\n`, quiet);
    const result = spawnSync(userShell, ["-lc", step], {
      cwd,
      stdio: quiet ? "pipe" : "inherit",
    });
    if (result.status !== 0) {
      log(`  ${red}✗ post-resolve step failed: ${step}${reset}\n`, quiet);
      failedStep = { step, status: result.status, signal: result.signal };
      break;
    }
  }

  if (failedStep) {
    const errMsg = `post-resolve step failed: ${failedStep.step}${failedStep.signal ? ` (signal ${failedStep.signal})` : ` (exit ${failedStep.status ?? "?"})`}`;
    log(`  ${red}halting — working tree left as-is; restore from ${backupBranch} if needed${reset}\n`, quiet);
    return {
      status: "error",
      branch,
      target,
      commitsBehind: behind,
      resolvedFiles: allResolvedFiles,
      unresolvedFiles: [],
      postResolveSteps,
      backupBranch,
      error: errMsg,
    };
  }

  // 9. Auto-commit regenerated files if any changed
  if (postResolveSteps.length > 0) {
    const { ok: hasDiff } = gitSafe("diff --quiet", cwd);
    if (!hasDiff) {
      // There are changes — stage and commit
      git("add -u", cwd); // only tracked files — don't stage untracked files
      const stepNames = postResolveSteps.join(", ");
      git(`commit -m "chore: regenerate files after rebase (${stepNames})"`, cwd);
      log(`  ${green}✓${reset} ${dim}committed regenerated files${reset}\n`, quiet);
    }
  }

  log(`  ${green}✓${reset} ${bold}${branch}${reset} rebased onto ${target}`, quiet);
  if (allResolvedFiles.length > 0) {
    log(` ${dim}(${allResolvedFiles.length} auto-resolved)${reset}`, quiet);
  }
  log("\n", quiet);

  return {
    status: "ok",
    branch,
    target,
    commitsBehind: behind,
    resolvedFiles: allResolvedFiles,
    unresolvedFiles: [],
    postResolveSteps,
    backupBranch,
  };
}

// ─── CLI handlers ────────────────────────────────────────────────────────────

/**
 * Default handler: rt git rebase (no subcommand)
 * Rebases onto auto-detected default branch.
 */
export async function rebaseCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;
  const dataDir = ctx.identity!.dataDir;
  const dryRun = args.includes("--dry-run");

  const result = await rebaseOnto({ cwd, dataDir, dryRun });

  if (result.status === "error") {
    console.error(`\n  ${red}${result.error}${reset}\n`);
    process.exit(1);
  }

  if (result.status === "conflict") {
    process.exit(1);
  }

  console.log("");
}

/**
 * Subcommand handler: rt git rebase onto <branch>
 * Rebases onto an explicit target branch.
 */
export async function ontoCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;
  const dataDir = ctx.identity!.dataDir;
  const dryRun = args.includes("--dry-run");
  const target = args.find((a) => !a.startsWith("-"));

  if (!target) {
    console.error(`\n  ${yellow}usage: rt git rebase onto <branch>${reset}\n`);
    process.exit(1);
  }

  const result = await rebaseOnto({ cwd, dataDir, target, dryRun });

  if (result.status === "error") {
    console.error(`\n  ${red}${result.error}${reset}\n`);
    process.exit(1);
  }

  if (result.status === "conflict") {
    process.exit(1);
  }

  console.log("");
}
