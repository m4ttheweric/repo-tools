/**
 * The one writable path rt has into run state (SKILLS-54). Everything else in
 * lib/runs is readonly: the agent's helper owns writes. Reconciliation is the
 * exception because only a person can decide a run is dead, and the record has
 * to stop claiming otherwise.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import { isPathComponent, runsRoot } from "./store.ts";

export type AbandonResult = { ok: true } | { ok: false; error: string };

export function abandonRun(repo: string, runId: string, reason: string): AbandonResult {
  if (!isPathComponent(repo) || !isPathComponent(runId)) return { ok: false, error: "invalid run path" };
  const path = join(runsRoot(), repo, runId, "state.db");
  if (!existsSync(path)) return { ok: false, error: `no run ${runId} in ${repo}` };

  const db = new Database(path);
  try {
    db.run("PRAGMA busy_timeout=5000");
    const row = db.query("SELECT status FROM runs LIMIT 1").get() as { status: string } | undefined;
    if (!row) return { ok: false, error: "run row missing" };
    if (row.status !== "running") return { ok: false, error: `run already ${row.status}` };

    const now = Date.now();
    db.run("UPDATE runs SET status='abandoned', ended_at=?", [now]);
    db.run(
      "INSERT OR REPLACE INTO fields (run_id, key, value, produced_by, at) SELECT id, 'reconciled', ?, 'rt runs abandon', ? FROM runs",
      [reason, now],
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    db.close();
  }
}
