/**
 * Auto-fix engine — orchestrates the full pipeline-failure → ephemeral
 * worktree → agent → validation → commit/push → teardown flow.
 *
 * Most of the logic lives in pure modules:
 *   - lib/auto-fix-config.ts          → caps, denylist, setup commands
 *   - lib/auto-fix-log.ts             → attempt log + notes
 *   - lib/auto-fix-lock.ts            → on-disk per-repo lock
 *   - lib/auto-fix-denylist.ts        → DEFAULT_DENYLIST + scope-cap helpers
 *   - lib/setup-commands.ts           → lockfile-driven install detection
 *   - lib/daemon/auto-fix-eligibility.ts   → gate evaluators
 *   - lib/daemon/auto-fix-agent-protocol.ts → prompt + RESULT parsing
 *
 * This file ties them together with the side-effect-heavy bits: git operations,
 * agent subprocess, file I/O, in-memory queue.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { reconcileForRepo } from "./doppler-sync.ts";
import { detectInstallCommand } from "../setup-commands.ts";
import { loadAutoFixConfig } from "../auto-fix-config.ts";

// ─── Paths ───────────────────────────────────────────────────────────────────

function rtDir(): string {
  return join(process.env.HOME ?? homedir(), ".rt");
}

function autoFixWorktreesDir(repoName: string): string {
  return join(rtDir(), repoName, "auto-fix-worktrees");
}

/** Compute the ephemeral worktree path for a given branch + sha. */
export function ephemeralWorktreePath(repoName: string, branch: string, sha: string): string {
  const safeBranch = branch.replace(/\//g, "-");
  const shortSha = sha.slice(0, 8);
  return join(autoFixWorktreesDir(repoName), `${safeBranch}-${shortSha}`);
}

// ─── Provisioning ────────────────────────────────────────────────────────────

export interface ProvisionInput {
  repoName:  string;
  repoPath:  string;
  branch:    string;
  sha:       string;
  log:       (msg: string) => void;
}

export interface ProvisionResult {
  ok:           true;
  worktreePath: string;
}
export interface ProvisionError {
  ok:    false;
  error: string;
}

/**
 * Create an ephemeral worktree, fetch the failing branch, switch to it,
 * verify HEAD matches `sha`, run Doppler sync + setup commands.
 *
 * On failure, attempts to teardown anything partially created.
 */
export async function provisionWorktree(
  input: ProvisionInput,
): Promise<ProvisionResult | ProvisionError> {
  const { repoName, repoPath, branch, sha, log } = input;
  const wtPath = ephemeralWorktreePath(repoName, branch, sha);

  try {
    mkdirSync(autoFixWorktreesDir(repoName), { recursive: true });

    // If a previous attempt left a stale dir behind, remove it first.
    if (existsSync(wtPath)) {
      try {
        execSync(`git -C "${repoPath}" worktree remove --force "${wtPath}"`, { stdio: "pipe" });
      } catch { /* not registered; just delete dir */ }
      try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* */ }
    }

    log(`auto-fix: git worktree add → ${wtPath} from origin/${branch}`);
    execSync(
      `git -C "${repoPath}" fetch origin "${branch}" && ` +
      `git -C "${repoPath}" worktree add "${wtPath}" "origin/${branch}"`,
      { stdio: "pipe" },
    );

    // Verify HEAD matches the failing pipeline SHA.
    const head = execSync(`git -C "${wtPath}" rev-parse HEAD`, {
      encoding: "utf8", stdio: "pipe",
    }).trim();
    if (head !== sha) {
      await teardownWorktree(repoPath, wtPath, log);
      return { ok: false, error: `HEAD drifted (worktree=${head.slice(0,8)} expected=${sha.slice(0,8)})` };
    }

    // Reconcile Doppler so the agent inherits the user's env.
    try {
      const summary = await reconcileForRepo({
        repoName,
        worktreeRoots: [wtPath],
      });
      log(`auto-fix: doppler:sync wrote=${summary.wrote} unchanged=${summary.unchanged}`);
    } catch (err) {
      log(`auto-fix: doppler:sync failed (continuing): ${err}`);
    }

    // Run setup commands.
    const cfg = loadAutoFixConfig(repoName);
    const commands = cfg.setupCommands ?? (() => {
      const detected = detectInstallCommand(wtPath);
      return detected ? [detected] : [];
    })();

    for (const cmd of commands) {
      const [bin, ...args] = cmd;
      log(`auto-fix: running setup: ${bin} ${args.join(" ")}`);
      try {
        execSync(`${bin} ${args.map(a => JSON.stringify(a)).join(" ")}`, {
          cwd: wtPath, stdio: "pipe", timeout: 5 * 60_000,
        });
      } catch (err: any) {
        await teardownWorktree(repoPath, wtPath, log);
        return { ok: false, error: `setup ${bin} failed: ${(err.stderr?.toString() ?? err.message ?? "").slice(0, 200)}` };
      }
    }

    return { ok: true, worktreePath: wtPath };
  } catch (err: any) {
    await teardownWorktree(repoPath, wtPath, log);
    return { ok: false, error: `provision: ${err.message ?? String(err)}` };
  }
}

/** Remove the ephemeral worktree. Tolerant of partial state. */
export async function teardownWorktree(
  repoPath: string,
  worktreePath: string,
  log: (msg: string) => void,
): Promise<void> {
  if (!existsSync(worktreePath)) return;
  try {
    execSync(`git -C "${repoPath}" worktree remove --force "${worktreePath}"`, { stdio: "pipe" });
    log(`auto-fix: removed worktree ${worktreePath}`);
  } catch (err: any) {
    log(`auto-fix: worktree remove failed (${err.message}); rm -rf instead`);
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ─── Stale sweep (called on daemon startup) ──────────────────────────────────

/**
 * On daemon startup, remove any ephemeral worktree directories left over
 * from a crashed previous daemon. Worktrees younger than 1h are kept since
 * they may still be in flight (multiple daemons should not exist; this is
 * defense in depth).
 */
export function sweepStaleArtifacts(
  repoIndex: () => Record<string, string>,
  log: (msg: string) => void,
): void {
  const STALE_AGE_MS = 60 * 60 * 1000;
  const now = Date.now();

  for (const [repoName, repoPath] of Object.entries(repoIndex())) {
    const dir = autoFixWorktreesDir(repoName);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const path = join(dir, entry);
      let age: number;
      try { age = now - statSync(path).mtimeMs; } catch { continue; }
      if (age < STALE_AGE_MS) continue;
      log(`auto-fix: sweeping stale worktree ${path} (age=${Math.round(age / 60_000)}m)`);
      try {
        execSync(`git -C "${repoPath}" worktree remove --force "${path}"`, { stdio: "pipe" });
      } catch { /* */ }
      try { rmSync(path, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}
