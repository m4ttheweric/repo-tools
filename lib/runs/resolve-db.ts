/**
 * Where a write verb's run DB comes from when RT_RUN_DB is unset. Every agent
 * Bash call is a fresh shell, so the export rarely survives; the run that
 * recorded this session, else the newest running run whose worktree holds
 * the cwd, is the one the caller meant. Scans every run DB under the runs
 * root on each call; prune keeps that set small.
 */
import { Database } from "bun:sqlite";
import { readdirSync, type Dirent } from "fs";
import { join, resolve as resolvePath, sep } from "path";
import { runsRoot } from "./paths.ts";

export type RunDbSource = "env" | "session" | "worktree";

export type RunDbResolution =
  | { ok: true; db: string; resolved: RunDbSource }
  | { ok: false; error: string };

type RunningRun = { runId: string; db: string; startedAt: number; session: string | null; worktree: string | null };

function dirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((d: Dirent) => d.isDirectory()).map((d: Dirent) => d.name);
  } catch {
    return [];
  }
}

function readRunning(dbPath: string, runId: string): RunningRun | null {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    const run = db.query("SELECT status, started_at FROM runs LIMIT 1").get() as { status: string; started_at: number } | undefined;
    if (!run || run.status !== "running") return null;
    const field = (key: string) => (db.query("SELECT value FROM fields WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null;
    return { runId, db: dbPath, startedAt: Number(run.started_at), session: field("claude-session"), worktree: field("worktree") };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function runningRuns(root: string): RunningRun[] {
  const out: RunningRun[] = [];
  for (const repo of dirs(root)) {
    for (const id of dirs(join(root, repo))) {
      const run = readRunning(join(root, repo, id, "state.db"), id);
      if (run) out.push(run);
    }
  }
  // Run ids sort by start time within a repo dir, so they break a same-millisecond tie the same way.
  return out.sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId));
}

function holds(worktree: string, cwd: string): boolean {
  const tree = resolvePath(worktree);
  const dir = resolvePath(cwd);
  return dir === tree || dir.startsWith(`${tree}${sep}`);
}

export function resolveRunDb(env: NodeJS.ProcessEnv, cwd: string): RunDbResolution {
  if (env.RT_RUN_DB) return { ok: true, db: env.RT_RUN_DB, resolved: "env" };
  const running = runningRuns(env.RT_RUNS_ROOT ?? runsRoot());
  const session = env.CLAUDE_CODE_SESSION_ID;
  const bySession = session ? running.filter((r) => r.session === session) : [];
  if (bySession.length === 1) return { ok: true, db: bySession[0]!.db, resolved: "session" };
  const byTree = running.filter((r) => r.worktree !== null && holds(r.worktree, cwd));
  const newest = byTree.at(-1);
  if (newest) return { ok: true, db: newest.db, resolved: "worktree" };
  const hint = bySession.length > 1 ? `; candidates: ${bySession.map((r) => r.runId).join(", ")}` : "";
  return { ok: false, error: `RT_RUN_DB is not set and no running run matches this session or directory${hint}` };
}
