/**
 * lib/state/cursors-store.ts — events-cursor persistence: one `kv` row per
 * repo (ns='events-cursor', k=repoName) (RT-48).
 *
 * See docs/superpowers/specs/2026-08-20-rt-statedb.md — "Tables (v1)" (`kv`),
 * "Store-by-store" item 5 ("`createCursorStore` keeps `get`/`set` over `kv`
 * rows; missing row = cold-start that repo's watcher (today's corruption
 * philosophy)"), and spec test 13's cursors half (get/set round-trip per
 * repo, missing row = undefined = cold start, legacy import).
 *
 * `createCursorStore` keeps the `get(repoName)`/`set(repoName, cursor)` API
 * lib/daemon/freshness.ts already depends on — only the constructor seam
 * changes: a db handle (default via the barrel), replacing the JSON file
 * path. Writes go through the shared warn-and-defer wrapper (lib/state/busy.ts):
 * this is a cache, not a durable queue (unlike notify_queue) — a lost write
 * just means that repo's watcher cold-starts, the same "missing/corrupt
 * file = cold start" philosophy the old whole-map JSON store had.
 *
 * Lives in lib/state/ (not lib/daemon/freshness.ts) so the barrel
 * (lib/state/index.ts) can register this store's LEGACY_IMPORTS entry
 * without dragging freshness.ts's GitLab-provider/daemon-logger machinery
 * into every barrel import — freshness.ts imports the public API below
 * instead, one direction only, no cycle.
 */

import { Database } from "bun:sqlite";
import type { EventCursor } from "@mattstack/glance";
import { getStateDb, LEGACY_IMPORTS } from "./db.ts";
import { persistOrWarn } from "./busy.ts";
import { rekeyKvNamespace, type RekeyReport } from "./identity-migrate.ts";

export interface CursorStore {
  get(repoName: string): EventCursor | undefined;
  set(repoName: string, cursor: EventCursor): void;
}

const CURSOR_NS = "events-cursor";

/**
 * One-shot: re-key legacy NAME-keyed `events-cursor` kv rows onto serialized
 * identities. Included for uniformity with the other stores — this cache is
 * self-consistent even unmigrated (the daemon writes and reads it under the
 * same key), so a row left legacy-keyed costs that repo's watcher one
 * cold-start, not a correctness failure. Exported for the daemon-boot
 * migration runner; this module does not wire the boot call.
 */
export function rekeyEventsCursorNamespace(): Promise<RekeyReport> {
  return rekeyKvNamespace(CURSOR_NS);
}

const KV_SELECT_SQL = `SELECT v FROM kv WHERE ns = ? AND k = ?;`;
const KV_UPSERT_SQL = `
  INSERT INTO kv (ns, k, v, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
`;

/**
 * Missing row (never written, corrupt stored JSON, or a fresh db) =
 * undefined = cold start for that repo's watcher — the SDK handles a
 * missing cursor by establishing a fresh one without firing invalidations,
 * same as today's missing/corrupt JSON file did.
 */
export function createCursorStore(db: Database = getStateDb()): CursorStore {
  return {
    get: (repoName) => {
      const row = db.query(KV_SELECT_SQL).get(CURSOR_NS, repoName) as { v: string } | null;
      if (!row) return undefined;
      try {
        return JSON.parse(row.v) as EventCursor;
      } catch {
        return undefined;
      }
    },
    set: (repoName, cursor) => {
      persistOrWarn(
        "events-cursor",
        () => { db.query(KV_UPSERT_SQL).run(CURSOR_NS, repoName, JSON.stringify(cursor), Date.now()); },
        { ns: CURSOR_NS, k: repoName, op: "write" },
      );
    },
  };
}

// ─── Legacy import: events-cursors.json → kv rows (ns='events-cursor') ─────
//
// Root shape: Record<repoName, EventCursor> — the old whole-map JSON file's
// own on-disk shape, unchanged since introduction.

LEGACY_IMPORTS.push({
  file: "events-cursors.json",
  import: (db, json) => {
    if (!json || typeof json !== "object" || Array.isArray(json)) return;
    const stmt = db.query(KV_UPSERT_SQL);
    const now = Date.now();
    for (const [repoName, cursor] of Object.entries(json as Record<string, unknown>)) {
      if (cursor == null || typeof cursor !== "object") continue;
      stmt.run(CURSOR_NS, repoName, JSON.stringify(cursor), now);
    }
  },
});
