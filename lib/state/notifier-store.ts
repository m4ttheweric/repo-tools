/**
 * lib/state/notifier-store.ts — notifier persistence: the `kv` state blob
 * and the `notify_queue` table (RT-48).
 *
 * See docs/superpowers/specs/2026-08-20-rt-statedb.md — "Tables (v1)" (`kv`,
 * `notify_queue`), "Store-by-store" item 4, and "The database"'s notify_queue
 * EXCEPTION to warn-and-defer.
 *
 * Lives in lib/state/ (not lib/notifier.ts) so the barrel
 * (lib/state/index.ts) can register this store's LEGACY_IMPORTS entries
 * without dragging lib/notifier.ts's tray-socket/subprocess/daemon-logger
 * machinery into every barrel import — lib/notifier.ts imports the public
 * API below instead, one direction only, no cycle.
 *
 * Two independent write policies live here, deliberately not sharing code:
 *
 *  - The `kv` state blob (ns='notifier', k='state') is a once-per-cycle
 *    read-modify-write cache snapshot. A dropped write just means the next
 *    cycle's read-modify-write starts from slightly stale state — the same
 *    "cache writes stay defer-and-move-on" policy every other daemon store
 *    uses — so it goes through the shared warn-and-defer wrapper
 *    (lib/state/busy.ts).
 *  - `notify_queue` INSERT/DELETE is the one spec-named EXCEPTION: with the
 *    in-memory `notificationQueue` array retired, a dropped write loses a
 *    notification permanently (the fallback timer finds nothing queued, and
 *    the caller's `fired` ledger is already marked — nothing re-arms it).
 *    Every queue mutation goes through `runQueueWrite`: a bounded retry
 *    (~3 attempts, short sleep — the same shape as db.ts's
 *    `execRetryingBusy`, not shared with it because that helper is
 *    `db.exec`-only and pre-migration-transaction-scoped) that logs at ERROR
 *    (not warn) and gives up only after the budget is exhausted.
 *
 * The logger handle is a lazy dynamic import, same reasoning as busy.ts: this
 * module is loaded by the barrel for every consumer, so a top-level
 * `import { getDaemonLogger }` would leak daemon-logger's ~/Library side
 * effect into every barrel import (locked by
 * lib/state/__tests__/barrel.test.ts "touches no file").
 */

import { Database } from "bun:sqlite";
import type { DaemonLoggerHandle } from "../daemon-logger.ts";
import { getStateDb, LEGACY_IMPORTS } from "./db.ts";
import { isBusyError, persistOrWarn } from "./busy.ts";

export interface NotificationEvent {
  id: string;
  title: string;
  message: string;
  url?: string;
  category: string;
  timestamp: number;
  /** Offending process pids, when the notification is about processes —
   *  lets the tray offer a Kill action. */
  pids?: number[];
}

const NOTIFIER_NS = "notifier";
const STATE_KEY = "state";

// ─── kv: notifier state blob (ns='notifier', k='state') ────────────────────
//
// Payload shape stays opaque JSON here (spec "Tables (v1)": "Payload shapes
// stay opaque JSON — this ticket changes persistence, never payload
// schemas") — lib/notifier.ts's NotifierState type is not imported here.

const KV_SELECT_SQL = `SELECT v FROM kv WHERE ns = ? AND k = ?;`;
const KV_UPSERT_SQL = `
  INSERT INTO kv (ns, k, v, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
`;

/** Missing row (never written, or a fresh db) = cold-start: returns `fallback`, as today's missing-file behavior did. */
export function getNotifierStateBlob<T>(fallback: T, db: Database = getStateDb()): T {
  const row = db.query(KV_SELECT_SQL).get(NOTIFIER_NS, STATE_KEY) as { v: string } | null;
  if (!row) return fallback;
  try {
    return JSON.parse(row.v) as T;
  } catch {
    return fallback;
  }
}

/** Cache write: shared warn-and-defer (busy.ts), not the queue's bounded retry — see module doc. */
export function setNotifierStateBlob<T>(value: T, db: Database = getStateDb()): void {
  persistOrWarn(
    "notifier",
    () => { db.query(KV_UPSERT_SQL).run(NOTIFIER_NS, STATE_KEY, JSON.stringify(value), Date.now()); },
    { ns: NOTIFIER_NS, k: STATE_KEY, op: "write" },
  );
}

// ─── notify_queue: the durable queue itself ─────────────────────────────────

interface QueueEventRow { event: string }

const QUEUE_RETRY_ATTEMPTS = 3;
const QUEUE_RETRY_SLEEP_MS = 20;

let logHandle: Promise<DaemonLoggerHandle> | null = null;

function logQueueError(op: string, context: Record<string, unknown>, err: unknown): void {
  logHandle ??= import("../daemon-logger.ts").then((m) => m.getDaemonLogger());
  void logHandle.then((h) =>
    h.childLogger("notifier-store").error(
      { ...context, err },
      `notify_queue ${op} failed after ${QUEUE_RETRY_ATTEMPTS} attempts: notification may be lost`,
    ),
  );
}

/**
 * The notify_queue EXCEPTION (spec "The database"): bounded retry instead of
 * warn-and-defer. `fn` may return a value (drain's SELECT+DELETE transaction
 * needs its rows back); a still-busy `fn` after the attempt budget logs at
 * ERROR and returns `undefined` rather than throwing or blocking forever.
 */
function runQueueWrite<T>(op: string, fn: () => T, context: Record<string, unknown>): T | undefined {
  for (let attempt = 1; attempt <= QUEUE_RETRY_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err)) throw err;
      if (attempt === QUEUE_RETRY_ATTEMPTS) {
        logQueueError(op, context, err);
        return undefined;
      }
      Bun.sleepSync(QUEUE_RETRY_SLEEP_MS);
    }
  }
  return undefined;
}

function rowToEvent(row: QueueEventRow): NotificationEvent {
  return JSON.parse(row.event) as NotificationEvent;
}

/** Enqueue = INSERT. The one mutation that would otherwise lose a notification permanently if dropped. */
export function enqueueNotification(event: NotificationEvent, db: Database = getStateDb()): void {
  runQueueWrite(
    "enqueue",
    () => { db.query(`INSERT INTO notify_queue (event_id, event) VALUES (?, ?);`).run(event.id, JSON.stringify(event)); },
    { event_id: event.id },
  );
}

/**
 * Drain = one transaction, SELECT-all then DELETE-all. A still-busy retry
 * budget returns `[]` and leaves the rows in place (the transaction rolled
 * back) — deferred to the next drain, never lost, unlike a dropped enqueue.
 */
export function drainNotificationQueue(db: Database = getStateDb()): NotificationEvent[] {
  const run = db.transaction((): NotificationEvent[] => {
    const rows = db.query(`SELECT event FROM notify_queue ORDER BY id;`).all() as QueueEventRow[];
    db.exec(`DELETE FROM notify_queue;`);
    return rows.map(rowToEvent);
  });
  return runQueueWrite("drain", () => run(), {}) ?? [];
}

/** Peek reads without deleting — diagnostics, no mutation, no retry needed. */
export function peekNotificationQueue(db: Database = getStateDb()): NotificationEvent[] {
  const rows = db.query(`SELECT event FROM notify_queue ORDER BY id;`).all() as QueueEventRow[];
  return rows.map(rowToEvent);
}

/** True if `eventId` is still queued. Used by the fallback timer to decide whether pushToTray already won the race. */
export function isNotificationQueued(eventId: string, db: Database = getStateDb()): boolean {
  return db.query(`SELECT 1 FROM notify_queue WHERE event_id = ? LIMIT 1;`).get(eventId) !== null;
}

/** Remove-by-event_id — both the pushToTray-success path and the 10s tray-fallback timer's path use this. */
export function removeQueuedNotification(eventId: string, db: Database = getStateDb()): void {
  runQueueWrite(
    "remove",
    () => { db.query(`DELETE FROM notify_queue WHERE event_id = ?;`).run(eventId); },
    { event_id: eventId },
  );
}

// ─── Legacy import: notifier-state.json → kv (ns='notifier', k='state') ────

LEGACY_IMPORTS.push({
  file: "notifier-state.json",
  import: (db, json) => {
    const value = json ?? { branches: {}, ports: {}, fired: [] };
    db.query(KV_UPSERT_SQL).run(NOTIFIER_NS, STATE_KEY, JSON.stringify(value), Date.now());
  },
});

// ─── Legacy import: notify-queue.json → notify_queue rows (array root) ─────
//
// Root shape: NotificationEvent[] — the file queue's own on-disk shape,
// unchanged since introduction (lib/notifier.ts's old flushQueue()). Row
// insertion order preserves the array's FIFO order (notify_queue.id is
// AUTOINCREMENT).

LEGACY_IMPORTS.push({
  file: "notify-queue.json",
  import: (db, json) => {
    if (!Array.isArray(json)) return;
    const stmt = db.query(`INSERT INTO notify_queue (event_id, event) VALUES (?, ?);`);
    for (const event of json as unknown[]) {
      const e = event as Partial<NotificationEvent> | null;
      if (!e || typeof e.id !== "string") continue;
      stmt.run(e.id, JSON.stringify(e));
    }
  },
});
