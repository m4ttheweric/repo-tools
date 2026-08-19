/**
 * Events bus — the daemon's optional pane-communication backend (RT-44).
 *
 * A SQLite journal (~/.rt/events.db, WAL) plus an in-memory waiter registry.
 * Topics are plain strings the daemon never interprets; consumers match with
 * Bun.Glob patterns and hold their own cursors (rowids). See the spec:
 * docs/superpowers/specs/2026-08-18-rt-events-bus-design.md
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { Logger } from "pino";

export interface BusEvent { id: number; topic: string; payload: unknown; emittedAt: number }
export interface WaitResult { events: BusEvent[]; cursor: number }

export interface EventsBus {
  emit(topic: string, payload?: unknown): number;
  list(opts: { pattern: string; after?: number; limit?: number }): WaitResult;
  wait(opts: { pattern: string; after?: number; waitMs?: number; signal?: AbortSignal }): Promise<WaitResult>;
  sweep(): number;
  waiterCount(): number;
  close(): void;
}

// One matcher for wait AND list. Bun.Glob: `*` does not cross `/`, `**` does.
// Never use SQLite's GLOB operator — its `*` crosses slashes, which would make
// wait and list match different event sets for the same pattern.
const globCache = new Map<string, Bun.Glob>();
export function matchTopic(pattern: string, topic: string): boolean {
  let glob = globCache.get(pattern);
  if (!glob) { glob = new Bun.Glob(pattern); globCache.set(pattern, glob); }
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

export function createEventsBus(opts: { dbPath: string; log: Logger }): EventsBus {
  const log = opts.log.child({ module: "events" });
  // Self-sufficient about its parent dir — daemon.ts constructs the bus at
  // module scope, before startDaemon()'s mkdirSync(RT_DIR) runs.
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = new Database(opts.dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
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

  return {
    emit(topic, payload) {
      const row = insertStmt.get(
        topic,
        payload === undefined ? null : JSON.stringify(payload),
        Date.now(),
      ) as { id: number };
      log.debug({ topic, id: row.id }, "event emitted");
      return row.id;
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

    wait() { throw new Error("implemented in Task 2"); },
    sweep() { throw new Error("implemented in Task 3"); },
    waiterCount() { return 0; },

    close() { db.close(); },
  };
}
