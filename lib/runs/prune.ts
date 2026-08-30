/**
 * Age-floor pruning of run dirs (spec: drop past the floor, keep anything
 * recent regardless of outcome). Deletes whole run DIRECTORIES under the
 * runs root and nothing else — assertPrunable is the last line of defence
 * and must stay in front of every rmSync.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync, type Dirent } from "fs";
import { join, sep } from "path";
import { canon } from "../fs-canon.ts";
import { getSetting } from "../settings/resolve.ts";
import { runsRoot } from "./store.ts";

const DAY = 24 * 60 * 60 * 1000;

// Both sides are canonicalized (not just resolve()'d) so a symlinked
// intermediate component — e.g. <root>/<repo> pointed outside the runs
// root — resolves to its real target before the prefix check, rather than
// passing on the pre-symlink spelling. `dir` always exists here (pruneRuns
// only calls this with a path returned by realDirNames), so the shared
// canon()'s realpath-or-unchanged fallback never has to compare a resolved
// root against an unresolved candidate.
export function assertPrunable(dir: string, root: string): void {
  const canonical = canon(dir);
  const canonicalRoot = canon(root);
  const rel = canonical.slice(canonicalRoot.length + 1);
  if (!canonical.startsWith(canonicalRoot + sep) || rel.split(sep).length !== 2) {
    throw new Error(`refusing to prune outside <runsRoot>/<repo>/<runId>: ${dir}`);
  }
}

// Real (non-symlink) directories only — readdirSync entries can be regular
// files or symlinks, and a stale one would otherwise reach rmSync via the
// mtime fallback below (assertPrunable checks position under the root, not
// that the target is actually a run directory).
function realDirNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d: Dirent) => d.isDirectory() && !d.isSymbolicLink())
      .map((d: Dirent) => d.name);
  } catch {
    return [];
  }
}

/**
 * Detached, unawaited `rm -rf` — mirrors lib/worktree/trash.ts's reap
 * pattern. A recursive unlink of a large run tree must never block the
 * daemon's single event-loop thread: a sync rmSync here froze every
 * concurrent tray poll and chat post for the sweep's full duration.
 */
function reapAsync(path: string): void {
  try {
    const proc = Bun.spawn(["rm", "-rf", "--", path], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    proc.unref();
  } catch {
    // Best-effort: a run tree that survives a failed spawn costs disk, never correctness.
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
      if (row.status === "running") return null; // never-finished: fall back to state.db mtime, not immortal
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
  for (const repo of realDirNames(root)) {
    const repoDir = join(root, repo);
    for (const id of realDirNames(repoDir)) {
      const runDir = join(repoDir, id);
      const dbPath = join(runDir, "state.db");
      let stamp = endedAtOf(dbPath);
      if (stamp == null) {
        try { stamp = statSync(existsSync(dbPath) ? dbPath : runDir).mtimeMs; } catch { continue; }
      }
      if (stamp < cutoff) {
        assertPrunable(runDir, root);
        reapAsync(runDir);
        removed.push(runDir);
      }
    }
  }
  return { removed };
}
