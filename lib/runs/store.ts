/**
 * Read-only access to pipeline run DBs written by mattstack-skills'
 * pipeline-state.sh. rt never writes run state; every open here is readonly
 * and per-call — no held connections, so a run dir can be pruned under us.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, type Dirent } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Attention, RunDetail, RunFieldRow, RunStageRow, RunSummary } from "../../packages/rt-client/src/commands.ts";
import { computeAttention } from "./attention.ts";

export const KNOWN_SCHEMA_VERSION = 2;

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

// SELECT * plus an explicit map, not a named-column SELECT: a v1 db lacks
// pack_commits/pack_dirty entirely, and naming an absent column throws.
function runRow(db: Database): RunSummary | null {
  try {
    const r = db.query("SELECT * FROM runs LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id), repo: String(r.repo), work_type: String(r.work_type),
      pipeline: String(r.pipeline), status: String(r.status),
      current_stage: (r.current_stage as string | null) ?? null,
      spawned_by: (r.spawned_by as string | null) ?? null,
      started_at: Number(r.started_at),
      ended_at: (r.ended_at as number | null) ?? null,
      pack_commits: (r.pack_commits as string | undefined) ?? null,
      pack_dirty: Number(r.pack_dirty ?? 0),
      attention: { needs: false, reason: null, evidence: "" },
    };
  } catch {
    return null;
  }
}

function stageRows(db: Database): RunStageRow[] {
  const rows = db.query("SELECT * FROM stages ORDER BY started_at, attempt").all() as Record<string, unknown>[];
  return rows.map((r) => ({
    name: String(r.name), status: String(r.status), attempt: Number(r.attempt),
    started_at: (r.started_at as number | null) ?? null,
    ended_at: (r.ended_at as number | null) ?? null,
    reason: (r.reason as string | undefined) ?? null,
    detail_path: (r.detail_path as string | undefined) ?? null,
  }));
}

const NO_ATTENTION: Attention = { needs: false, reason: null, evidence: "" };

// A run whose tables are missing (interrupted run-start) is still worth
// listing — the store's contract is skip-the-broken-row, not throw, and
// listRuns has no catch around this call.
function withAttention(db: Database, row: RunSummary): RunSummary {
  try {
    const fields = db.query("SELECT key, value, produced_by, at FROM fields").all() as RunFieldRow[];
    const decisions = db.query("SELECT contract, scope, selection, decided_by, decided_at FROM decisions").all() as RunDetail["decisions"];
    return { ...row, attention: computeAttention(row, stageRows(db), fields, decisions, Date.now()) };
  } catch {
    return { ...row, attention: NO_ATTENTION };
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
        if (row) out.push(withAttention(opened.db, row));
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
    const stages = stageRows(db);
    const fields = db.query("SELECT key, value, produced_by, at FROM fields ORDER BY at").all() as RunDetail["fields"];
    const decisions = db.query("SELECT contract, scope, selection, decided_by, decided_at FROM decisions ORDER BY decided_at").all() as RunDetail["decisions"];
    return {
      run: { ...run, attention: computeAttention(run, stages, fields, decisions, Date.now()) },
      stages, fields, decisions,
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
