/**
 * Read-only access to pipeline run DBs written by mattstack-skills'
 * pipeline-state.sh. rt never writes run state; every open here is readonly
 * and per-call — no held connections, so a run dir can be pruned under us.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, type Dirent } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { RunDetail, RunSummary } from "../../packages/rt-client/src/commands.ts";

export const KNOWN_SCHEMA_VERSION = 1;

export function runsRoot(): string {
  return process.env.RT_RUNS_ROOT ?? join(homedir(), ".mattstack", "runs");
}

function dirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((d: Dirent) => d.isDirectory()).map((d: Dirent) => d.name);
  } catch {
    return [];
  }
}

// repo/runId reach a path join straight from a network-reachable readonly
// seam (runs:get via REST decodes %2F) — reject anything that could step
// outside <runsRoot>/<repo>/<runId> before it ever hits the filesystem.
function isPathComponent(s: string): boolean {
  return s.length > 0 && s !== "." && s !== ".." && !s.includes("/") && !s.includes("\\");
}

function openRun(repo: string, runId: string): { db: Database; schemaAhead: boolean } | null {
  if (!isPathComponent(repo) || !isPathComponent(runId)) return null;
  const path = join(runsRoot(), repo, runId, "state.db");
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    const ver = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    return { db, schemaAhead: ver > KNOWN_SCHEMA_VERSION };
  } catch {
    db.close();
    return null;
  }
}

function runRow(db: Database): RunSummary | null {
  try {
    return (db.query("SELECT * FROM runs LIMIT 1").get() as RunSummary | undefined) ?? null;
  } catch {
    return null;
  }
}

export function listRuns(repo?: string): RunSummary[] {
  if (repo != null && !isPathComponent(repo)) return [];
  const repos = repo ? [repo] : dirs(runsRoot());
  const out: RunSummary[] = [];
  for (const r of repos) {
    for (const id of dirs(join(runsRoot(), r))) {
      const opened = openRun(r, id);
      if (!opened) continue;
      try {
        const row = runRow(opened.db);
        if (row) out.push(row);
      } finally {
        opened.db.close();
      }
    }
  }
  return out.sort((a, b) => b.started_at - a.started_at);
}

export function readRun(repo: string, runId: string): RunDetail | null {
  const opened = openRun(repo, runId);
  if (!opened) return null;
  const { db, schemaAhead } = opened;
  try {
    const run = runRow(db);
    if (!run) return null;
    return {
      run,
      stages: db.query("SELECT name, status, attempt, started_at, ended_at FROM stages ORDER BY started_at, attempt").all() as RunDetail["stages"],
      fields: db.query("SELECT key, value, produced_by, at FROM fields ORDER BY at").all() as RunDetail["fields"],
      decisions: db.query("SELECT contract, scope, selection, decided_by, decided_at FROM decisions ORDER BY decided_at").all() as RunDetail["decisions"],
      schemaAhead,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function findRun(runId: string): RunDetail | null {
  if (!isPathComponent(runId)) return null;
  for (const repo of dirs(runsRoot())) {
    if (dirs(join(runsRoot(), repo)).includes(runId)) return readRun(repo, runId);
  }
  return null;
}
