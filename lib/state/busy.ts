/**
 * lib/state/busy.ts — shared SQLITE_BUSY policies for lib/state/ stores
 * (RT-48, orchestrator ruling on Task 5: extracted from Task 4's
 * project-mrs-store.ts so discussions writes, and any future daemon store,
 * share one implementation instead of re-deriving it).
 *
 * Spec: docs/superpowers/specs/2026-08-20-rt-statedb.md "The database"
 * ("cache writes stay defer-and-move-on") and "Store-by-store".
 *
 * Two independent write policies live here, deliberately not sharing code:
 *
 *  - `persistOrWarn`: a daemon-flavor connection's busy_timeout (250ms)
 *    already does the waiting; a thrown SQLITE_BUSY here means the lock was
 *    still held after that budget. The caller's in-memory model (where one
 *    exists) is already the source of truth by the time this runs, so the
 *    write is warned and swallowed rather than thrown — the row catches up
 *    on the next successful write. Any other error is not swallowed.
 *  - `runCriticalWrite`: for writes whose loss is permanent — no in-memory
 *    model will re-arm or resend them. A bounded retry (short sleep between
 *    attempts) that logs at ERROR (not warn) and gives up only after the
 *    budget is exhausted, returning `undefined` rather than throwing or
 *    blocking forever. Any other error is not swallowed.
 *
 * The logger handle and the dynamic import of daemon-logger.ts are only
 * ever instantiated on the (rare) warn/error paths, never at module load:
 * this module lives in lib/state/ and is loaded by the barrel
 * (lib/state/index.ts) for every consumer, so a top-level `import {
 * getDaemonLogger } from "../daemon-logger.ts"` would leak daemon-logger's
 * ~/Library side effect (pino-roll) into every barrel import — see
 * lib/state/__tests__/barrel.test.ts "touches no file" contract and
 * project-mrs-store.ts's original module doc for the empirical finding.
 */

import type { DaemonLoggerHandle } from "../daemon-logger.ts";

let logHandle: Promise<DaemonLoggerHandle> | null = null;

/** True for the bun:sqlite error thrown when a write can't get the lock inside busy_timeout. */
export function isBusyError(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === "SQLITE_BUSY";
}

function warnBusy(module: string, context: Record<string, unknown>): void {
  logHandle ??= import("../daemon-logger.ts").then((m) => m.getDaemonLogger());
  void logHandle.then((h) =>
    h.childLogger(module).warn(context, `${module} write skipped: db busy, converges next cycle`),
  );
}

/**
 * Runs `fn` (a db.transaction()-wrapped write, or a single prepared-statement
 * .run()); a thrown SQLITE_BUSY is caught, warned (under a `module`-named
 * child logger), and swallowed. Any other error is not swallowed.
 */
export function persistOrWarn(module: string, fn: () => void, context: Record<string, unknown>): void {
  try {
    fn();
  } catch (err) {
    if (isBusyError(err)) {
      warnBusy(module, context);
      return;
    }
    throw err;
  }
}

const CRITICAL_RETRY_ATTEMPTS = 3;
const CRITICAL_RETRY_SLEEP_MS = 20;

function logCriticalError(op: string, context: Record<string, unknown>, err: unknown): void {
  logHandle ??= import("../daemon-logger.ts").then((m) => m.getDaemonLogger());
  void logHandle.then((h) =>
    h.childLogger("state").error(
      { ...context, err },
      `${op} failed after ${CRITICAL_RETRY_ATTEMPTS} attempts: write may be lost`,
    ),
  );
}

/**
 * Bounded retry instead of warn-and-defer, for writes whose loss is
 * permanent (spec "The database" EXCEPTION). `fn` may return a value (a
 * SELECT+DELETE-shaped transaction needs its rows back); a still-busy `fn`
 * after the attempt budget logs at ERROR and returns `undefined` rather than
 * throwing or blocking forever.
 */
export function runCriticalWrite<T>(op: string, fn: () => T, context: Record<string, unknown>): T | undefined {
  for (let attempt = 1; attempt <= CRITICAL_RETRY_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err)) throw err;
      if (attempt === CRITICAL_RETRY_ATTEMPTS) {
        logCriticalError(op, context, err);
        return undefined;
      }
      Bun.sleepSync(CRITICAL_RETRY_SLEEP_MS);
    }
  }
  return undefined;
}
