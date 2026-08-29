/**
 * Events bus — the daemon's optional pane-communication backend (RT-44).
 *
 * A SQLite journal (~/.mattstack/rt/events.db, WAL) plus an in-memory waiter registry.
 * Topics are plain strings the daemon never interprets; consumers match with
 * Bun.Glob patterns and hold their own cursors (rowids). See the spec:
 * docs/superpowers/specs/2026-08-18-rt-events-bus-design.md
 */

import { Database } from "bun:sqlite";
import { mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import type { Logger } from "pino";
import { isCorruptionError } from "../state/db.ts";

export interface BusEvent { id: number; topic: string; payload: unknown; emittedAt: number }
export interface WaitResult { events: BusEvent[]; cursor: number }

export interface EventsBus {
  emit(topic: string, payload?: unknown): number;
  /**
   * emit with an explicit timestamp. Same as emit() but allows callers to
   * pin the emittedAt time (normally Date.now()); performs the same waiter
   * wake-up scan. Used by the events:emit handler so the broadcast frame's
   * emittedAt agrees exactly with the journal row, and by retention tests
   * to plant old rows.
   */
  emitAt(topic: string, payload: unknown, emittedAt: number): number;
  /**
   * The single owner of "persist + broadcast" (R020): builds the frame,
   * persists it via emitAt, and fans out (topic, payload) to every
   * onBroadcast subscriber. Replaces the copies formerly duplicated in
   * command-router.ts and the inline reactions formerly living in
   * daemon.ts's `emit()`.
   */
  emitEvent(topic: string, payload: unknown): BusEvent;
  /**
   * Subscribe to every emitEvent call, in registration order. Subscribers
   * see the same (topic, payload) the caller passed to emitEvent -- not a
   * wrapped "event" frame -- so a subscriber can match on the real topic
   * (e.g. a cron trigger's `event`, or `type === "worktree:disposed"`).
   * Returns an unsubscribe.
   */
  onBroadcast(fn: (type: string, data: unknown) => void): () => void;
  list(opts: { pattern: string; after?: number; limit?: number }): WaitResult;
  head(): number;
  wait(opts: { pattern: string; after?: number; waitMs?: number; signal?: AbortSignal }): Promise<WaitResult>;
  sweep(): number;
  waiterCount(): number;
  close(): void;
  /** Test-only debug accessor for the underlying handle (e.g. pragma checks). Not for feature code. */
  __db?: Database;
}

// One matcher for wait AND list. Bun.Glob: `*` does not cross `/`, `**` does.
// Never use SQLite's GLOB operator — its `*` crosses slashes, which would make
// wait and list match different event sets for the same pattern.
// Patterns are client-supplied (one per shepherdr job name, etc.), so a
// long-lived daemon would otherwise accumulate compiled globs forever; the
// cap trades a rare recompile for a bounded map.
const GLOB_CACHE_MAX = 256;
const globCache = new Map<string, Bun.Glob>();
export function matchTopic(pattern: string, topic: string): boolean {
  let glob = globCache.get(pattern);
  if (!glob) {
    if (globCache.size >= GLOB_CACHE_MAX) globCache.clear();
    glob = new Bun.Glob(pattern);
    globCache.set(pattern, glob);
  }
  return glob.match(topic);
}

interface EventRow { id: number; topic: string; payload: string | null; emittedAt: number }

function rowToEvent(row: EventRow): BusEvent {
  let payload: unknown = null;
  if (row.payload != null) {
    try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
  }
  return { id: row.id, topic: row.topic, payload, emittedAt: row.emittedAt };
}

/**
 * Renames a corrupt events.db out of the way and warns loudly, mirroring
 * lib/state/db.ts's `quarantine`. events.db is a bounded-retention journal
 * (sweep() already discards old rows), so losing it entirely on corruption
 * is harmless: recreate empty rather than attempt any repair. WAL sidecars
 * are best-effort cleaned since they are meaningless without the main file.
 */
function quarantineEventsDb(path: string, log: Logger): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinedPath = `${path}.corrupt-${stamp}`;
  log.warn(
    { path, quarantinedPath },
    "events db could not be opened (corrupt), quarantining and recreating empty",
  );
  renameSync(path, quarantinedPath);
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    try {
      renameSync(sidecar, `${sidecar}.corrupt-${stamp}`);
    } catch {
      // sidecar absent, fine: WAL mode doesn't always leave one
    }
  }
}

export function createEventsBus(opts: {
  dbPath: string;
  log: Logger;
  retentionFloor?: number;
  retentionMs?: number;
}): EventsBus {
  const log = opts.log.child({ module: "events" });
  const retentionFloor = opts.retentionFloor ?? 50_000;
  const retentionMs = opts.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
  // Self-sufficient about its parent dir — daemon.ts constructs the bus at
  // module scope, before startDaemon()'s mkdirSync(RT_DIR) runs.
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  // PRAGMA order matches lib/state/db.ts's applyPragmas: busy_timeout FIRST
  // so the WAL conversion itself respects it, then journal_mode, then
  // synchronous.
  let db: Database;
  try {
    db = new Database(opts.dbPath, { create: true });
    db.exec("PRAGMA busy_timeout = 250;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    // Pragmas alone don't always force sqlite to validate the file header;
    // touch it now so a corrupt file surfaces here, not mid-query later.
    db.query("PRAGMA user_version").get();
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    quarantineEventsDb(opts.dbPath, log);
    db = new Database(opts.dbPath, { create: true });
    db.exec("PRAGMA busy_timeout = 250;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      topic     TEXT NOT NULL,
      payload   TEXT,
      emittedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_topic_id ON events(topic, id);
  `);

  const insertStmt = db.prepare(
    "INSERT INTO events (topic, payload, emittedAt) VALUES (?, ?, ?) RETURNING id",
  );
  const afterStmt = db.prepare("SELECT id, topic, payload, emittedAt FROM events WHERE id > ? ORDER BY id");
  const maxIdStmt = db.prepare("SELECT COALESCE(MAX(id), 0) AS maxId FROM events");

  const maxId = (): number => (maxIdStmt.get() as { maxId: number }).maxId;

  /** Matching events with id > after (glob filtered in JS — see matchTopic). */
  const eventsAfter = (pattern: string, after: number, limit?: number): BusEvent[] => {
    const rows = afterStmt.all(after) as EventRow[];
    const matched = rows.filter(r => matchTopic(pattern, r.topic)).map(rowToEvent);
    return limit != null ? matched.slice(0, limit) : matched;
  };

  const MAX_WAIT_MS = 240_000; // under the 255s socket idle timeout; the daemon clamp, not the client's
  interface Waiter {
    pattern: string;
    afterId: number;
    resolve: (r: WaitResult) => void;
    timer: ReturnType<typeof setTimeout>;
    onAbort?: () => void;
    signal?: AbortSignal;
  }
  const waiters = new Set<Waiter>();
  const broadcastSubscribers = new Set<(type: string, data: unknown) => void>();

  const settle = (w: Waiter, result: WaitResult): void => {
    if (!waiters.has(w)) return;
    waiters.delete(w);
    clearTimeout(w.timer);
    if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
    w.resolve(result);
  };

  /**
   * Shared insert+wake code path for both emit and emitAt.
   * Inserts a row and wakes any matching waiters.
   */
  const insertAndWake = (topic: string, payload: unknown, emittedAt: number): number => {
    const row = insertStmt.get(
      topic,
      payload === undefined ? null : JSON.stringify(payload),
      emittedAt,
    ) as { id: number };
    log.debug({ topic, id: row.id }, "event emitted");
    for (const w of [...waiters]) {
      if (!matchTopic(w.pattern, topic)) continue;
      const events = eventsAfter(w.pattern, w.afterId);
      if (events.length) {
        log.debug({ pattern: w.pattern, delivered: events.length }, "waiter woken");
        settle(w, { events, cursor: events[events.length - 1]!.id });
      }
    }
    return row.id;
  };

  return {
    emit(topic, payload) {
      return insertAndWake(topic, payload, Date.now());
    },

    emitAt(topic, payload, emittedAt) {
      return insertAndWake(topic, payload, emittedAt);
    },

    emitEvent(topic, payload) {
      const emittedAt = Date.now();
      const id = insertAndWake(topic, payload, emittedAt);
      for (const fn of [...broadcastSubscribers]) fn(topic, payload);
      return { id, topic, payload, emittedAt };
    },

    onBroadcast(fn) {
      broadcastSubscribers.add(fn);
      return () => { broadcastSubscribers.delete(fn); };
    },

    list({ pattern, after, limit }) {
      const events = eventsAfter(pattern, after ?? 0, limit);
      // Truncated result: cursor points at the last DELIVERED event so the
      // caller's next `after` resumes exactly where this page ended.
      // Untruncated (or empty) result: cursor is the journal head.
      const cursor = events.length && limit != null && events.length === limit
        ? events[events.length - 1]!.id
        : maxId();
      return { events, cursor };
    },

    head() {
      return maxId();
    },

    wait({ pattern, after, waitMs, signal }) {
      const head = maxId();
      const effAfter = after == null ? head : Math.min(after, head);
      // Atomic check-then-register: NO await between this query and waiters.add.
      const ready = eventsAfter(pattern, effAfter);
      if (ready.length) {
        return Promise.resolve({ events: ready, cursor: ready[ready.length - 1]!.id });
      }
      const capMs = Math.min(Math.max(waitMs ?? MAX_WAIT_MS, 0), MAX_WAIT_MS);
      // Empty results return `head` (the registration-time journal head), NOT
      // effAfter: with a caller cursor below the head, effAfter would never
      // advance past non-matching traffic, so every empty re-poll would
      // rescan an ever-growing tail. Any matching event <= head would have
      // resolved the catch-up above, so advancing to head skips only
      // non-matching rows. (This is the spec's "snapshots the max rowid at
      // waiter registration".)
      return new Promise<WaitResult>((resolve) => {
        const w: Waiter = {
          pattern,
          afterId: effAfter,
          resolve,
          signal,
          timer: setTimeout(() => settle(w, { events: [], cursor: head }), capMs),
        };
        if (signal) {
          w.onAbort = () => {
            log.debug({ pattern }, "waiter aborted (connection closed)");
            settle(w, { events: [], cursor: head });
          };
          if (signal.aborted) { clearTimeout(w.timer); resolve({ events: [], cursor: head }); return; }
          signal.addEventListener("abort", w.onAbort, { once: true });
        }
        waiters.add(w);
      });
    },

    sweep() {
      const cutoff = Date.now() - retentionMs;
      const { changes } = db.run(
        `DELETE FROM events
         WHERE emittedAt < ?
           AND id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)`,
        [cutoff, retentionFloor],
      );
      if (changes > 0) log.debug({ deleted: changes }, "retention sweep");
      return changes;
    },

    waiterCount() { return waiters.size; },

    __db: db,

    close() {
      const head = maxId();
      for (const w of [...waiters]) settle(w, { events: [], cursor: head });
      db.close();
    },
  };
}
