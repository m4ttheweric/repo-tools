/**
 * Age-floor pruning of run dirs (spec: drop past the floor, keep anything
 * recent regardless of outcome). Deletes whole run DIRECTORIES under the
 * runs root and nothing else — assertPrunable is the last line of defence
 * and must stay in front of every rmSync.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, realpathSync, rmSync, statSync, type Dirent } from "fs";
import { basename, dirname, join, sep } from "path";
import { getSetting } from "../settings/resolve.ts";
import { runsRoot } from "./store.ts";

const DAY = 24 * 60 * 60 * 1000;

// realpathSync resolves symlinks (worktree.ts's `canon` precedent), but a
// plain try/catch->resolve() fallback would compare a canonicalized root
// against a non-canonicalized candidate whenever the candidate (or a
// component of it) doesn't exist yet — e.g. macOS's /var -> /private/var,
// which breaks the prefix check even with no symlink attack involved. Walk
// up to the deepest existing ancestor, canonicalize THAT, and reattach the
// missing tail lexically, so both sides always go through the same scheme.
function canon(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(canon(parent), basename(path));
  }
}

// Both sides are canonicalized (not just resolve()'d) so a symlinked
// intermediate component — e.g. <root>/<repo> pointed outside the runs
// root — resolves to its real target before the prefix check, rather than
// passing on the pre-symlink spelling.
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
        rmSync(runDir, { recursive: true, force: true });
        removed.push(runDir);
      }
    }
  }
  return { removed };
}
