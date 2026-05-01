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

import {
  DEFAULT_DENYLIST,
  matchesDenylist,
  enforceScopeCaps,
  type ScopeCapViolation,
} from "../auto-fix-denylist.ts";

// ─── Diff validation ─────────────────────────────────────────────────────────

export interface DiffSummary {
  files: string[];
  insertions: number;
  deletions: number;
}

/** Capture the agent's staged-or-working diff vs HEAD as a structured summary. */
export function captureWorktreeDiff(worktreePath: string): DiffSummary {
  const filesOut = execSync(`git -C "${worktreePath}" diff HEAD --name-only`, {
    encoding: "utf8", stdio: "pipe",
  });
  const files = filesOut.split("\n").map(s => s.trim()).filter(Boolean);

  const stat = execSync(`git -C "${worktreePath}" diff HEAD --shortstat`, {
    encoding: "utf8", stdio: "pipe",
  });
  const insertions = parseInt(stat.match(/(\d+) insertion/)?.[1] ?? "0", 10);
  const deletions  = parseInt(stat.match(/(\d+) deletion/)?.[1]  ?? "0", 10);
  return { files, insertions, deletions };
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "denylist"; offendingPath: string }
  | { ok: false; reason: "scope"; violation: ScopeCapViolation };

/** Validate diff against caps + denylist (default + repo additions). */
export function validateDiff(
  diff: DiffSummary,
  caps: { fileCap: number; lineCap: number },
  additionalDenylist: string[],
): ValidationResult {
  if (diff.files.length === 0) return { ok: false, reason: "empty" };

  const allDeny = [...DEFAULT_DENYLIST, ...additionalDenylist];
  for (const f of diff.files) {
    if (matchesDenylist(f, allDeny)) {
      return { ok: false, reason: "denylist", offendingPath: f };
    }
  }

  const violation = enforceScopeCaps({
    files:   diff.files.length,
    lines:   diff.insertions + diff.deletions,
    fileCap: caps.fileCap,
    lineCap: caps.lineCap,
  });
  if (violation) return { ok: false, reason: "scope", violation };

  return { ok: true };
}

// ─── Commit + push ───────────────────────────────────────────────────────────

export interface CommitInput {
  worktreePath: string;
  branch:       string;
  sha:          string;
  summary:      string;
}

export interface CommitResult {
  ok: true;
  newCommitSha: string;
}
export interface CommitError {
  ok: false;
  error: string;
}

/** Stage everything modified, commit with the structured trailer, push. */
export async function commitAndPush(
  input: CommitInput,
  log: (msg: string) => void,
): Promise<CommitResult | CommitError> {
  const { worktreePath, branch, sha, summary } = input;
  try {
    execSync(`git -C "${worktreePath}" add -A`, { stdio: "pipe" });

    const subject = `auto-fix: ${summary}`;
    const body = `\n\nAuto-Fixed-By: rt\nPipeline-Failure-SHA: ${sha}\n`;
    const message = subject + body;

    execSync(
      `git -C "${worktreePath}" -c user.email="auto-fix@rt" -c user.name="rt auto-fix" ` +
      `commit -m ${JSON.stringify(message)}`,
      { stdio: "pipe" },
    );

    const newSha = execSync(`git -C "${worktreePath}" rev-parse HEAD`, {
      encoding: "utf8", stdio: "pipe",
    }).trim();

    log(`auto-fix: pushing ${branch} (${newSha.slice(0, 8)})`);
    execSync(`git -C "${worktreePath}" push origin "${branch}"`, { stdio: "pipe" });

    return { ok: true, newCommitSha: newSha };
  } catch (err: any) {
    const msg = (err.stderr?.toString() ?? err.message ?? String(err)).slice(0, 300);
    return { ok: false, error: msg };
  }
}

/** Reset the worktree to HEAD and clean untracked files (used on rejected diff). */
export function resetWorktree(worktreePath: string, preAgentSha: string): void {
  try {
    execSync(`git -C "${worktreePath}" reset --hard "${preAgentSha}"`, { stdio: "pipe" });
    execSync(`git -C "${worktreePath}" clean -fd`, { stdio: "pipe" });
  } catch { /* best-effort */ }
}

import { runAgent, resolveAgentInvocation } from "../agent-runner.ts";
import { evaluateEligibility, type MrSnapshot } from "./auto-fix-eligibility.ts";
import {
  assembleAutoFixPrompt, parseAgentResult, type JobLog, type GitContext,
} from "./auto-fix-agent-protocol.ts";
import { acquireLock, releaseLock } from "../auto-fix-lock.ts";
import { appendLogEntry, writeNotes } from "../auto-fix-log.ts";

const COOLDOWN_MS  = 5 * 60 * 1000;
const ATTEMPT_CAP  = 2;

// ─── In-memory inflight + queue ──────────────────────────────────────────────

const inflight = new Set<string>();
const queued = new Map<string, AutoFixContext>();

// ─── AutoFixContext + outcomes ───────────────────────────────────────────────

export interface AutoFixContext {
  repoName:       string;
  repoPath:       string;
  branch:         string;
  sha:            string;
  target:         string;
  mr:             MrSnapshot;
  jobLogs:        JobLog[];
  gitContext:     GitContext;
  log:            (msg: string) => void;
  notify?:        (kind: "auto_fix_pushed" | "auto_fix_skipped" | "auto_fix_rejected", details: string) => void;
}

export type AutoFixOutcome =
  | { kind: "ineligible";    reason: string }
  | { kind: "queued"                       }
  | { kind: "fixed";         commitSha: string; summary: string }
  | { kind: "skipped";       reason: string }
  | { kind: "error";         error: string }
  | { kind: "rejected_diff"; reason: string };

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Top-level entry. Fire-and-forget safe — caller does not need to await.
 * Per-repo serialization via in-memory inflight set + queue (most-recent-wins).
 */
export async function runAutoFix(ctx: AutoFixContext): Promise<AutoFixOutcome> {
  const { repoName, log } = ctx;

  if (inflight.has(repoName)) {
    queued.set(repoName, ctx);
    log(`auto-fix: ${repoName} in flight; queued ${ctx.branch}@${ctx.sha.slice(0, 8)}`);
    return { kind: "queued" };
  }
  inflight.add(repoName);

  try {
    return await runOnce(ctx);
  } finally {
    inflight.delete(repoName);
    const next = queued.get(repoName);
    if (next) {
      queued.delete(repoName);
      runAutoFix(next).catch(err => log(`auto-fix: queued retry failed: ${err}`));
    }
  }
}

async function runOnce(ctx: AutoFixContext): Promise<AutoFixOutcome> {
  const { repoName, repoPath, branch, sha, target, mr, log } = ctx;
  const startedAt = Date.now();

  // ── Eligibility ─────────────────────────────────────────────────────────
  const eligibility = evaluateEligibility({
    repoName, branch, headSha: sha, mr,
    now: startedAt, cooldownMs: COOLDOWN_MS, attemptCap: ATTEMPT_CAP,
  });
  if (!eligibility.eligible) {
    log(`auto-fix: ineligible — ${eligibility.reason}`);
    return { kind: "ineligible", reason: eligibility.reason };
  }

  // ── Lock ────────────────────────────────────────────────────────────────
  if (!acquireLock(repoName, { branch, sha })) {
    log(`auto-fix: lock held; skipping`);
    return { kind: "ineligible", reason: "lock held by another process" };
  }

  try {
    // ── Provision ───────────────────────────────────────────────────────
    const prov = await provisionWorktree({ repoName, repoPath, branch, sha, log });
    if (!prov.ok) {
      const out: AutoFixOutcome = { kind: "error", error: prov.error };
      finalize(ctx, startedAt, out);
      return out;
    }
    const wtPath = prov.worktreePath;

    try {
      // ── Run agent ───────────────────────────────────────────────────
      const cfg = loadAutoFixConfig(repoName);
      const denylistForPrompt = [...DEFAULT_DENYLIST, ...cfg.additionalDenylist];
      const prompt = assembleAutoFixPrompt({
        branch, target,
        jobLogs: ctx.jobLogs, gitContext: ctx.gitContext,
        fileCap: cfg.fileCap, lineCap: cfg.lineCap,
        denylist: denylistForPrompt,
        allowTestFixes: cfg.allowTestFixes,
      });

      log(`auto-fix: spawning agent in ${wtPath}`);
      const agentRes = await runAgent({
        ...resolveAgentInvocation({}),
        prompt, cwd: wtPath,
      });
      const result = parseAgentResult(agentRes.stdout);

      if (result.kind === "skipped") {
        writeNotes(repoName, branch, sha, `# Auto-fix skipped\n\nReason: ${result.reason}\n\n## Agent stdout (tail)\n\n\`\`\`\n${tail(agentRes.stdout, 4000)}\n\`\`\``);
        const out: AutoFixOutcome = { kind: "skipped", reason: result.reason };
        finalize(ctx, startedAt, out);
        return out;
      }
      if (result.kind === "error" || result.kind === "unrecognized") {
        const note = result.kind === "error" ? result.note : "agent exited without RESULT line";
        writeNotes(repoName, branch, sha, `# Auto-fix error\n\nReason: ${note}\n\n## Agent stdout (tail)\n\n\`\`\`\n${tail(agentRes.stdout, 4000)}\n\`\`\``);
        const out: AutoFixOutcome = { kind: "error", error: note };
        finalize(ctx, startedAt, out);
        return out;
      }

      // result.kind === "fixed" — validate the diff before committing.
      const diff = captureWorktreeDiff(wtPath);
      const validation = validateDiff(diff,
        { fileCap: cfg.fileCap, lineCap: cfg.lineCap },
        cfg.additionalDenylist,
      );
      if (!validation.ok) {
        const reason = validation.reason === "empty"      ? "agent reported fixed but produced no diff"
                     : validation.reason === "denylist"   ? `denied path ${validation.offendingPath}`
                     : /* scope */                           `${validation.violation.kind}=${validation.violation.actual}>${validation.violation.cap}`;
        resetWorktree(wtPath, sha);
        writeNotes(repoName, branch, sha, `# Auto-fix rejected\n\nReason: ${reason}\n\nFiles touched:\n${diff.files.map(f => `- ${f}`).join("\n")}\n\nDiff stats: ${diff.insertions} insertions, ${diff.deletions} deletions.\n`);
        const out: AutoFixOutcome = { kind: "rejected_diff", reason };
        finalize(ctx, startedAt, out);
        return out;
      }

      // Verify HEAD didn't drift mid-agent (third party push).
      const stillHead = execSync(`git -C "${wtPath}" rev-parse HEAD`, {
        encoding: "utf8", stdio: "pipe",
      }).trim();
      if (stillHead !== sha) {
        resetWorktree(wtPath, sha);
        const out: AutoFixOutcome = { kind: "error", error: "HEAD drifted during agent run" };
        finalize(ctx, startedAt, out);
        return out;
      }

      const commit = await commitAndPush(
        { worktreePath: wtPath, branch, sha, summary: result.summary || "auto-fix" },
        log,
      );
      if (!commit.ok) {
        const out: AutoFixOutcome = { kind: "error", error: `commit/push failed: ${commit.error}` };
        finalize(ctx, startedAt, out);
        return out;
      }

      const out: AutoFixOutcome = { kind: "fixed", commitSha: commit.newCommitSha, summary: result.summary };
      finalize(ctx, startedAt, out);
      return out;
    } finally {
      await teardownWorktree(repoPath, wtPath, log);
    }
  } finally {
    releaseLock(repoName);
  }
}

// ─── Finalize: log + notify ──────────────────────────────────────────────────

function finalize(ctx: AutoFixContext, startedAt: number, outcome: AutoFixOutcome): void {
  const { repoName, branch, sha, log, notify } = ctx;
  const durationMs = Date.now() - startedAt;

  if (outcome.kind === "fixed") {
    appendLogEntry(repoName, {
      branch, sha, attemptedAt: startedAt, outcome: "fixed", durationMs,
      commitSha: outcome.commitSha, reason: outcome.summary,
    });
    log(`auto-fix: fixed ${branch}@${sha.slice(0, 8)} → ${outcome.commitSha.slice(0, 8)} (${durationMs}ms)`);
    notify?.("auto_fix_pushed", outcome.summary);
  } else if (outcome.kind === "skipped") {
    appendLogEntry(repoName, { branch, sha, attemptedAt: startedAt, outcome: "skipped", durationMs, reason: outcome.reason });
    log(`auto-fix: skipped ${branch}@${sha.slice(0, 8)} (${outcome.reason})`);
    notify?.("auto_fix_skipped", outcome.reason);
  } else if (outcome.kind === "error") {
    appendLogEntry(repoName, { branch, sha, attemptedAt: startedAt, outcome: "error", durationMs, reason: outcome.error });
    log(`auto-fix: error ${branch}@${sha.slice(0, 8)} (${outcome.error})`);
    notify?.("auto_fix_skipped", outcome.error);
  } else if (outcome.kind === "rejected_diff") {
    appendLogEntry(repoName, { branch, sha, attemptedAt: startedAt, outcome: "rejected_diff", durationMs, reason: outcome.reason });
    log(`auto-fix: rejected ${branch}@${sha.slice(0, 8)} (${outcome.reason})`);
    notify?.("auto_fix_rejected", outcome.reason);
  }
}

function tail(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s;
}
