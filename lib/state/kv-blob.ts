/**
 * lib/state/kv-blob.ts — generic whole-value JSON accessor over the `kv`
 * table, for caches that are read and written as one opaque blob (never
 * queried by field).
 *
 * A missing or corrupt row is a cold start, not an error: every reader
 * falls back to the caller's `fallback` rather than throwing, matching the
 * "missing/corrupt file = cold start" behavior the JSON caches this backs
 * had. Payload shapes stay opaque JSON here — this module has no knowledge
 * of any particular cache's fields.
 */

import { Database } from "bun:sqlite";
import { getStateDb } from "./db.ts";
import { persistOrWarn, runCriticalWrite } from "./busy.ts";

const KV_SELECT_SQL = `SELECT v FROM kv WHERE ns = ? AND k = ?;`;
const KV_SELECT_NS_SQL = `SELECT k, v FROM kv WHERE ns = ?;`;
const KV_SELECT_NS_META_SQL = `SELECT k, v, updated_at FROM kv WHERE ns = ?;`;
const KV_UPSERT_SQL = `
  INSERT INTO kv (ns, k, v, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
`;
const KV_DELETE_SQL = `DELETE FROM kv WHERE ns = ? AND k = ?;`;
// updated_at is Date.now(), which ties for writes in the same millisecond;
// rowid breaks those ties by insertion order (a fresh key always takes a
// higher rowid than every existing one, and an upsert keeps its rowid), so
// "keep the newest N" stays deterministic instead of evicting an arbitrary
// tied row. ns is bound twice (outer filter and inner ranking), then keep.
const KV_CAP_NS_SQL = `
  DELETE FROM kv WHERE ns = ? AND k NOT IN (
    SELECT k FROM kv WHERE ns = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?
  );
`;

/**
 * `onCorrupt` fires only when a row EXISTS but its JSON fails to parse —
 * never for a missing row. Callers that must distinguish "cold start" from
 * "lost data" (a seam, per the catch policy) pass it to warn; callers that
 * genuinely don't care leave it out and get today's silent fallback.
 */
export function getKvValue<T>(
  ns: string,
  key: string,
  fallback: T,
  db: Database = getStateDb(),
  onCorrupt?: (err: unknown) => void,
): T {
  const row = db.query(KV_SELECT_SQL).get(ns, key) as { v: string } | null;
  if (!row) return fallback;
  try {
    return JSON.parse(row.v) as T;
  } catch (err) {
    onCorrupt?.(err);
    return fallback;
  }
}

/** Whether a row exists for `ns`+`key`, independent of whether its JSON parses — the migrate-on-read gate needs this distinction, `getKvValue`'s fallback-on-missing collapses it. */
export function hasKvValue(ns: string, key: string, db: Database = getStateDb()): boolean {
  return db.query(KV_SELECT_SQL).get(ns, key) != null;
}

/** Cache write: shared warn-and-defer (busy.ts) — a dropped write just means the next read starts from slightly stale state. */
export function setKvValue<T>(ns: string, key: string, value: T, db: Database = getStateDb()): void {
  persistOrWarn(
    `kv:${ns}`,
    () => { db.query(KV_UPSERT_SQL).run(ns, key, JSON.stringify(value), Date.now()); },
    { ns, k: key, op: "write" },
  );
}

/** Critical write: retries via runCriticalWrite (busy.ts) and reports whether the row actually landed, so a destructive caller can refuse to advance state on a dropped write. */
export function setKvValueCritical<T>(ns: string, key: string, value: T, db: Database = getStateDb()): boolean {
  const done = runCriticalWrite(
    `kv:${ns}`,
    () => { db.query(KV_UPSERT_SQL).run(ns, key, JSON.stringify(value), Date.now()); return true; },
    { ns, k: key, op: "write" },
  );
  return done === true;
}

export function deleteKvValue(ns: string, key: string, db: Database = getStateDb()): void {
  persistOrWarn(
    `kv:${ns}`,
    () => { db.query(KV_DELETE_SQL).run(ns, key); },
    { ns, k: key, op: "delete" },
  );
}

/**
 * Caps `ns` to its `keep` most-recently-written rows, deleting the rest.
 * Recency is (updated_at, rowid), so same-millisecond `Date.now()` writes
 * evict by insertion order rather than arbitrarily. Cache-class write: a
 * dropped delete just leaves the namespace briefly over its cap.
 */
export function capKvNamespace(ns: string, keep: number, db: Database = getStateDb()): void {
  persistOrWarn(
    `kv:${ns}`,
    () => { db.query(KV_CAP_NS_SQL).run(ns, ns, keep); },
    { ns, op: "cap" },
  );
}

/** Every row in `ns`, keyed by `k`. A row whose JSON is corrupt is skipped, not fatal to the rest of the namespace. */
export function listKvValues<T>(ns: string, db: Database = getStateDb()): Record<string, T> {
  const rows = db.query(KV_SELECT_NS_SQL).all(ns) as { k: string; v: string }[];
  const out: Record<string, T> = {};
  for (const row of rows) {
    try {
      out[row.k] = JSON.parse(row.v) as T;
    } catch {
      // corrupt row — skip, same as a missing one
    }
  }
  return out;
}

export interface KvEntry<T> {
  key: string;
  value: T;
  /** Epoch ms of the last write to this row (the `updated_at` column). */
  updatedAt: number;
}

/**
 * Every row in `ns` with its write timestamp, for the callers that need to
 * order rows by recency rather than just read them. `listKvValues` drops
 * `updated_at` on the floor, and the column is not otherwise reachable
 * through this module.
 *
 * Corrupt rows are skipped, same as `listKvValues`.
 */
export function listKvEntries<T>(ns: string, db: Database = getStateDb()): KvEntry<T>[] {
  const rows = db.query(KV_SELECT_NS_META_SQL).all(ns) as { k: string; v: string; updated_at: number }[];
  const out: KvEntry<T>[] = [];
  for (const row of rows) {
    try {
      out.push({ key: row.k, value: JSON.parse(row.v) as T, updatedAt: row.updated_at });
    } catch {
      // corrupt row — skip, same as a missing one
    }
  }
  return out;
}
