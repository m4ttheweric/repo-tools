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
import { persistOrWarn } from "./busy.ts";

const KV_SELECT_SQL = `SELECT v FROM kv WHERE ns = ? AND k = ?;`;
const KV_SELECT_NS_SQL = `SELECT k, v FROM kv WHERE ns = ?;`;
const KV_UPSERT_SQL = `
  INSERT INTO kv (ns, k, v, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
`;
const KV_DELETE_SQL = `DELETE FROM kv WHERE ns = ? AND k = ?;`;

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

/** Cache write: shared warn-and-defer (busy.ts) — a dropped write just means the next read starts from slightly stale state. */
export function setKvValue<T>(ns: string, key: string, value: T, db: Database = getStateDb()): void {
  persistOrWarn(
    `kv:${ns}`,
    () => { db.query(KV_UPSERT_SQL).run(ns, key, JSON.stringify(value), Date.now()); },
    { ns, k: key, op: "write" },
  );
}

export function deleteKvValue(ns: string, key: string, db: Database = getStateDb()): void {
  persistOrWarn(
    `kv:${ns}`,
    () => { db.query(KV_DELETE_SQL).run(ns, key); },
    { ns, k: key, op: "delete" },
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
