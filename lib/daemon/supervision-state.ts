/**
 * lib/daemon/supervision-state.ts: daemon boot/crash history, so
 * `rt daemon status` can report boot-failed/crash-looping and a stuck-phase
 * breadcrumb for a live-but-silent daemon.
 *
 * Two tiers, deliberately not one:
 *  - The breadcrumb FILE (`writeBreadcrumb`/`readBreadcrumb`)
 *    opens no database, so it is safe to call at module scope, before
 *    state.db exists. It is the only tier a pre-db boot failure can reach.
 *  - The kv tier (`recordBootAttempt`, `recordDaemonReady`,
 *    `recordCleanExit`, and the kv half of `recordBootFailure`) goes through
 *    `getStateDb("daemon")`, so callers must not reach it until the daemon
 *    has opened its state.db (lib/daemon.ts's `openBranchCacheStore()`).
 *    `recordBootFailure` is safe to call at any point regardless: its kv
 *    write is try/catch'd and silently no-ops if the db isn't open yet.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { RT_DIR } from "../daemon-config.ts";
import { daemonFlavor } from "./park.ts";
import { getKvValue, setKvValue } from "../state/kv-blob.ts";
import { getStateDb } from "../state/db.ts";

export type BootPhase = "start" | "events-db" | "state-db" | "api" | "socket" | "ready";

const NS = "daemon-supervision";
const KEY_BOOT_ATTEMPTS = "boot-attempts";
const KEY_LAST_READY_AT = "last-ready-at";
const KEY_RECENT_FAILURES = "recent-failures";
const KEY_LAST_EXIT = "last-exit";

const RECENT_FAILURES_CAP = 10;

export interface BootFailure {
  at: number;
  phase: BootPhase;
  reason: string;
}

export type LastExit =
  | { at: number; kind: "boot-failed"; code: number; reason: string }
  | { at: number; kind: "shutdown" | "signal"; code: number };

export interface SupervisionState {
  bootAttempts: number;
  lastReadyAt: number;
  recentFailures: BootFailure[];
  lastExit: LastExit | null;
}

function db() {
  return getStateDb("daemon");
}

export function recordBootAttempt(): void {
  const n = getKvValue<number>(NS, KEY_BOOT_ATTEMPTS, 0, db());
  setKvValue(NS, KEY_BOOT_ATTEMPTS, n + 1, db());
}

export function recordDaemonReady(): void {
  setKvValue(NS, KEY_LAST_READY_AT, Date.now(), db());
}

/**
 * Always writes the breadcrumb file, which never needs state.db. The kv
 * append is best-effort: a failure this early in boot may predate state.db
 * being open at all, and that must not throw back into the caller's catch.
 */
export function recordBootFailure(phase: BootPhase, reason: string): void {
  writeBreadcrumb(phase);
  try {
    const at = Date.now();
    const existing = getKvValue<BootFailure[]>(NS, KEY_RECENT_FAILURES, [], db());
    const next = [...existing, { at, phase, reason }].slice(-RECENT_FAILURES_CAP);
    setKvValue(NS, KEY_RECENT_FAILURES, next, db());
    setKvValue<LastExit>(NS, KEY_LAST_EXIT, { at, kind: "boot-failed", code: 1, reason }, db());
  } catch {
    // Pre-db failure (or a busy/corrupt state.db): the breadcrumb file above
    // is the only record this failure gets, and that's fine.
  }
}

export function recordCleanExit(kind: "shutdown" | "signal", code: number): void {
  try {
    setKvValue<LastExit>(NS, KEY_LAST_EXIT, { at: Date.now(), kind, code }, db());
  } catch {
    // Best-effort, same as recordBootFailure's kv half.
  }
}

export function readSupervisionState(): SupervisionState {
  const store = db();
  return {
    bootAttempts: getKvValue<number>(NS, KEY_BOOT_ATTEMPTS, 0, store),
    lastReadyAt: getKvValue<number>(NS, KEY_LAST_READY_AT, 0, store),
    recentFailures: getKvValue<BootFailure[]>(NS, KEY_RECENT_FAILURES, [], store),
    lastExit: getKvValue<LastExit | null>(NS, KEY_LAST_EXIT, null, store),
  };
}

export function isCrashLooping(
  state: SupervisionState,
  now: number,
  n = 3,
  windowMs = 5 * 60_000,
): boolean {
  const floor = now - windowMs;
  return state.recentFailures.filter((f) => f.at > floor).length >= n;
}

// ─── Breadcrumb file (db-free) ────────────────────────────────────────────

interface Breadcrumb {
  at: number;
  pid: number;
  flavor: "dev" | "prod";
  phase: BootPhase;
}

function breadcrumbPath(): string {
  return join(RT_DIR, "daemon-boot.json");
}

/** Never fatal: a breadcrumb is a diagnostic aid, not something boot may fail over. */
export function writeBreadcrumb(phase: BootPhase): void {
  try {
    const breadcrumb: Breadcrumb = { at: Date.now(), pid: process.pid, flavor: daemonFlavor(), phase };
    writeFileSync(breadcrumbPath(), JSON.stringify(breadcrumb));
  } catch {
    // Best-effort.
  }
}

export function readBreadcrumb(): Breadcrumb | null {
  try {
    if (!existsSync(breadcrumbPath())) return null;
    return JSON.parse(readFileSync(breadcrumbPath(), "utf8")) as Breadcrumb;
  } catch {
    return null;
  }
}
