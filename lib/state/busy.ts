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

/**
 * R052: busy.ts's warn/error lines defaulted unconditionally to
 * getDaemonLogger(), so a CLI process hitting a busy write (`rt run`
 * enrichment, `rt repos locate`) appended a line carrying the CLI's own pid
 * into the DAEMON's log surface — `rt daemon logs` then attributes it to the
 * daemon, and two processes apply the 14-file retention independently
 * against the same rolling set.
 */
export interface BusyLogSink {
  warn(module: string, context: Record<string, unknown>, message: string): void;
  error(module: string, context: Record<string, unknown>, message: string): void;
}

let sink: BusyLogSink | null = null;

/**
 * Lets whichever process this module runs in declare its own log surface
 * for busy-write warn/error lines, instead of this module ever importing a
 * concrete logger itself (daemon-logger.ts or cli-logger.ts) — the daemon
 * calls this once at boot with a childLogger("state")-backed sink; the CLI
 * calls it once at entry with one backed by its own cli.<date>.log surface.
 * Unset (the default, and every existing test) falls back to the original
 * getDaemonLogger() behavior, so nothing changes for a caller that never
 * configures a sink.
 */
export function setBusyLogSink(newSink: BusyLogSink | null): void {
  sink = newSink;
}

/**
 * True for the bun:sqlite error thrown when a write can't get the lock
 * inside busy_timeout, including the SNAPSHOT/RECOVERY variants a
 * deferred-BEGIN read-then-write transaction can throw, which busy_timeout
 * does not retry the way it retries a plain SQLITE_BUSY.
 */
export function isBusyError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return code === "SQLITE_BUSY" || (typeof code === "string" && code.startsWith("SQLITE_BUSY_"));
}

function warnBusy(module: string, context: Record<string, unknown>): void {
  const message = `${module} write skipped: db busy, converges next cycle`;
  if (sink) { sink.warn(module, context, message); return; }
  logHandle ??= import("../daemon-logger.ts").then((m) => m.getDaemonLogger());
  void logHandle.then((h) => h.childLogger(module).warn(context, message));
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
  const message = `${op} failed after ${CRITICAL_RETRY_ATTEMPTS} attempts: write may be lost`;
  const fullContext = { ...context, err };
  if (sink) { sink.error(op, fullContext, message); return; }
  logHandle ??= import("../daemon-logger.ts").then((m) => m.getDaemonLogger());
  void logHandle.then((h) => h.childLogger("state").error(fullContext, message));
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
