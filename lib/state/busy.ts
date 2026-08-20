/**
 * lib/state/busy.ts — shared daemon-flavor SQLITE_BUSY warn-and-defer wrapper
 * (RT-48, orchestrator ruling on Task 5: extracted from Task 4's
 * project-mrs-store.ts so discussions writes, and any future daemon store,
 * share one implementation instead of re-deriving it).
 *
 * Spec: docs/superpowers/specs/2026-08-20-rt-statedb.md "The database"
 * ("cache writes stay defer-and-move-on") and "Store-by-store".
 *
 * A daemon-flavor connection's busy_timeout (250ms) already does the
 * waiting; a thrown SQLITE_BUSY here means the lock was still held after
 * that budget. The caller's in-memory model (where one exists) is already
 * the source of truth by the time this runs, so the write is warned and
 * swallowed rather than thrown — the row catches up on the next successful
 * write. Any other error is not swallowed.
 *
 * The logger handle and the dynamic import of daemon-logger.ts are only
 * ever instantiated on this (rare) warn path, never at module load: this
 * module lives in lib/state/ and is loaded by the barrel (lib/state/index.ts)
 * for every consumer, so a top-level `import { getDaemonLogger } from
 * "../daemon-logger.ts"` would leak daemon-logger's ~/Library side effect
 * (pino-roll) into every barrel import — see lib/state/__tests__/barrel.test.ts
 * "touches no file" contract and project-mrs-store.ts's original module doc
 * for the empirical finding.
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
