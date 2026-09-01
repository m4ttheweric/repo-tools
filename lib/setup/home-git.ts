/**
 * Setup-layer git helpers for the home repo's push state.
 *
 * A near-duplicate of lib/daemon/home-snapshot.ts's `hasRemote` /
 * `unpushedAgainstOrigin` — typed against Probes["exec"] (result field
 * `code`, not runCapture's `exitCode`) instead of the daemon's own exec
 * convention. A setup validator/step must not import from lib/daemon/, so
 * this is a deliberate second copy, not a shared cross-layer module.
 */

import type { Probes } from "./probes.ts";

const GIT_TIMEOUT_MS = 15_000;

// The /usr/bin/git stub pops Apple's "install the developer tools?" dialog
// when invoked from a GUI process — and the tray polls `setup status` (which
// reaches these helpers) from the moment it launches. So nothing here may
// exec git until xcode-select reports a developer dir. Only the positive is
// cached: CLT can arrive mid-session (the headless installer), and a cached
// negative would wedge status until the process restarts.
let cltSeen = false;
async function gitUsable(exec: Probes["exec"]): Promise<boolean> {
  if (cltSeen) return true;
  const res = await exec(["xcode-select", "-p"], { timeoutMs: GIT_TIMEOUT_MS });
  if (res.code === 0) cltSeen = true;
  return cltSeen;
}
export function resetCltCacheForTests(): void {
  cltSeen = false;
}

/** True only when `git rev-parse --is-inside-work-tree` succeeds and says so — distinct from "no remote configured", which presupposes a repo exists at all. */
export async function isGitRepo(exec: Probes["exec"], cwd: string): Promise<boolean> {
  if (!(await gitUsable(exec))) return false;
  const result = await exec(["git", "rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  return result.code === 0 && result.stdout.trim() === "true";
}

/** `origin` specifically, not any remote: every push and every ref comparison downstream is origin-only, so an `upstream`-only repo has nothing to push to. An exec failure (missing git, timeout) also reads as "no remote" — same end result as a healthy repo with none configured. */
export async function hasRemote(exec: Probes["exec"], cwd: string): Promise<boolean> {
  if (!(await gitUsable(exec))) return false;
  const result = await exec(["git", "remote"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  return result.code === 0 && result.stdout.split("\n").some((name) => name.trim() === "origin");
}

/** True only when HEAD resolves — false on an unborn branch, where nothing is versioned at all. */
export async function hasCommits(exec: Probes["exec"], cwd: string): Promise<boolean> {
  if (!(await gitUsable(exec))) return false;
  const result = await exec(["git", "rev-parse", "--verify", "-q", "HEAD"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  return result.code === 0;
}

export type OriginPushState = { kind: "no-ref" } | { kind: "ahead"; count: number } | { kind: "up-to-date"; committedAt: Date | null } | { kind: "unknown" };

/**
 * Compares against `refs/remotes/origin/<branch>` directly — never `@{u}`.
 * A repo `git init`-ed locally and given a remote later has no
 * `branch.<name>.remote` configured, so `@{u}` exits 128 even though the
 * remote-tracking ref itself exists. A missing ref means everything is
 * unpushed (an absent ref is FATAL to `rev-list`, not empty), so its
 * existence is checked before it is ever compared against.
 *
 * An unborn branch still prints a branch name via `symbolic-ref`, exit 0, so
 * HEAD is verified separately; it folds into "no-ref".
 */
export async function originPushState(exec: Probes["exec"], cwd: string): Promise<OriginPushState> {
  if (!(await gitUsable(exec))) return { kind: "unknown" };
  const branchResult = await exec(["git", "symbolic-ref", "--short", "HEAD"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (branchResult.code !== 0) return { kind: "no-ref" }; // detached HEAD

  const headResult = await exec(["git", "rev-parse", "--verify", "-q", "HEAD"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (headResult.code !== 0) return { kind: "no-ref" }; // unborn branch: no commits yet

  const branch = branchResult.stdout.trim();
  const ref = `refs/remotes/origin/${branch}`;
  const hasRef = await exec(["git", "rev-parse", "--verify", "-q", ref], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (hasRef.code !== 0) return { kind: "no-ref" }; // no remote-tracking ref yet: everything is unpushed

  // A non-zero exit (timeout, corrupt object store, permissions) must never
  // fall through to "up-to-date": that would render `ready` on evidence
  // that never arrived, the exact outcome this row exists to prevent.
  const ahead = await exec(["git", "rev-list", "--count", `${ref}..HEAD`], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (ahead.code !== 0) return { kind: "unknown" };
  const count = Number(ahead.stdout.trim());
  if (!Number.isFinite(count)) return { kind: "unknown" };
  if (count > 0) return { kind: "ahead", count };

  const log = await exec(["git", "log", "-1", "--format=%cI", ref], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  const committedAt = log.code === 0 && log.stdout.trim() ? new Date(log.stdout.trim()) : null;
  return { kind: "up-to-date", committedAt };
}
