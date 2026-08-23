/**
 * lib/state/run-history-store.ts — per-repo `rt run` invocation history in
 * `run_history`.
 *
 * A dedicated table, not a `kv` blob: retention is "keep the newest N rows
 * for this repo," which a table answers with a DELETE ... ORDER BY id DESC
 * LIMIT query. A blob would need the whole array decoded, sliced, and
 * re-encoded on every append — the JSONL append-then-compact this replaces
 * did exactly that.
 */

import { Database } from "bun:sqlite";
import { getStateDb } from "./db.ts";
import { persistOrWarn } from "./busy.ts";

export interface RunHistoryEntry {
  ts: string;
  cmd: string;
  cwd: string;
  worktree: string;
  branch: string;
  pkg: string;
  script: string;
  exit: number | null;
}

/** Rows kept per repo after each append — the newest survive, oldest are trimmed. */
const MAX_ENTRIES = 200;

const INSERT_SQL = `
  INSERT INTO run_history (repo, ts, cmd, cwd, worktree, branch, pkg, script, exit)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
`;
const TRIM_SQL = `
  DELETE FROM run_history WHERE repo = ? AND id NOT IN (
    SELECT id FROM run_history WHERE repo = ? ORDER BY id DESC LIMIT ?
  );
`;
const SELECT_SQL = `
  SELECT ts, cmd, cwd, worktree, branch, pkg, script, exit
  FROM run_history WHERE repo = ? ORDER BY id DESC LIMIT ?;
`;

/** Insert then trim, one transaction — a reader never sees the repo briefly over its retention bound. */
export function appendRunHistoryEntry(repo: string, entry: RunHistoryEntry, db: Database = getStateDb()): void {
  const run = db.transaction(() => {
    db.query(INSERT_SQL).run(repo, entry.ts, entry.cmd, entry.cwd, entry.worktree, entry.branch, entry.pkg, entry.script, entry.exit);
    db.query(TRIM_SQL).run(repo, repo, MAX_ENTRIES);
  });
  persistOrWarn("run-history", () => run(), { repo, op: "append" });
}

/** Newest-first, matching the JSONL reader's order. */
export function listRunHistory(repo: string, limit = MAX_ENTRIES, db: Database = getStateDb()): RunHistoryEntry[] {
  return db.query(SELECT_SQL).all(repo, limit) as RunHistoryEntry[];
}
