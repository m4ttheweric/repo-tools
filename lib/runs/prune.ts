/**
 * Age-floor pruning of run dirs (spec: drop past the floor, keep anything
 * recent regardless of outcome). Deletes whole run DIRECTORIES under the
 * runs root and nothing else — assertPrunable is the last line of defence
 * and must stay in front of every rmSync.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmSync, statSync } from "fs";
import { join, resolve, sep } from "path";
import { getSetting } from "../settings/resolve.ts";
import { runsRoot } from "./store.ts";

const DAY = 24 * 60 * 60 * 1000;

export function assertPrunable(dir: string, root: string): void {
  const canonical = resolve(dir);
  const canonicalRoot = resolve(root);
  const rel = canonical.slice(canonicalRoot.length + 1);
  if (!canonical.startsWith(canonicalRoot + sep) || rel.split(sep).length !== 2) {
    throw new Error(`refusing to prune outside <runsRoot>/<repo>/<runId>: ${dir}`);
  }
}

function floorDays(): number {
  try {
    const v = getSetting<unknown>("rt.runsPruneDays").value;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 30;
  } catch {
    return 30;
  }
}

function endedAtOf(dbPath: string): number | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query("SELECT status, ended_at FROM runs LIMIT 1").get() as { status: string; ended_at: number | null } | undefined;
      if (!row) return null;
      if (row.status === "running") return Number.POSITIVE_INFINITY; // never age-prune by start time
      return row.ended_at;
    } finally {
      db.close();
    }
  } catch {
    return null; // unreadable -> fall back to mtime
  }
}

export function pruneRuns(now: number = Date.now()): { removed: string[] } {
  const root = runsRoot();
  const cutoff = now - floorDays() * DAY;
  const removed: string[] = [];
  if (!existsSync(root)) return { removed };
  for (const repo of readdirSync(root)) {
    const repoDir = join(root, repo);
    let ids: string[];
    try { ids = readdirSync(repoDir); } catch { continue; }
    for (const id of ids) {
      const runDir = join(repoDir, id);
      const dbPath = join(runDir, "state.db");
      let stamp = endedAtOf(dbPath);
      if (stamp === Number.POSITIVE_INFINITY) continue;
      if (stamp == null) {
        try { stamp = statSync(existsSync(dbPath) ? dbPath : runDir).mtimeMs; } catch { continue; }
      }
      if (stamp < cutoff) {
        assertPrunable(runDir, root);
        rmSync(runDir, { recursive: true, force: true });
        removed.push(runDir);
      }
    }
  }
  return { removed };
}
