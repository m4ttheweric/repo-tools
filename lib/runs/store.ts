/**
 * Read-only access to pipeline run DBs written by mattstack-skills'
 * pipeline-state.sh. rt never writes run state; every open here is readonly
 * and per-call — no held connections, so a run dir can be pruned under us.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync, type Dirent } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Attention, RunDetail, RunFieldRow, RunStageRow, RunSummary } from "../../packages/rt-client/src/commands.ts";
import { computeAttention, fieldValue, lastEventAt, type RunLiveness } from "./attention.ts";

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
export function isPathComponent(s: string): boolean {
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
      // Placeholders: withAttention/readRun overwrite these once they have
      // stages/fields/decisions in hand; this row is never returned as-is.
      last_event_at: Number(r.started_at),
      ticket: null,
      branch: null,
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

// The herdr mirror only means something while the run is live: a finished
// run's worktree often hosts whatever agent moved in next.
function agentMirror(run: RunSummary, fields: RunFieldRow[], liveness?: RunLiveness): RunSummary["agent"] {
  if (run.status !== "running" || !liveness) return null;
  return liveness.agentFor(fieldValue(fields, "claude-session"), fieldValue(fields, "worktree"));
}

// A run whose tables are missing (interrupted run-start) is still worth
// listing — the store's contract is skip-the-broken-row, not throw, and
// listRuns has no catch around this call.
function withAttention(db: Database, row: RunSummary, liveness?: RunLiveness): RunSummary {
  try {
    const stages = stageRows(db);
    const fields = db.query("SELECT key, value, produced_by, at FROM fields").all() as RunFieldRow[];
    const decisions = db.query("SELECT contract, scope, selection, decided_by, decided_at FROM decisions").all() as RunDetail["decisions"];
    return {
      ...row,
      attention: computeAttention(row, stages, fields, decisions, Date.now(), liveness),
      last_event_at: lastEventAt(row, stages, fields, decisions),
      ticket: fieldValue(fields, "ticket"),
      branch: fieldValue(fields, "branch"),
      agent: agentMirror(row, fields, liveness),
      stages: stages.map((s) => ({ name: s.name, status: s.status, started_at: s.started_at })),
    };
  } catch {
    return { ...row, attention: NO_ATTENTION };
  }
}

// Finished runs never change; skip the open+PRAGMA+4-reads when the db mtime
// is unchanged. Running runs are never cached: their db still mutates and
// their liveness overlay is recomputed per call.
const summaryCache = new Map<string, { mtimeMs: number; summary: RunSummary }>();

export function listRuns(repo?: string, liveness?: RunLiveness): RunSummary[] {
  if (repo != null && !isPathComponent(repo)) return [];
  const repos = repo ? [repo] : dirs(runsRoot());
  const out: RunSummary[] = [];
  for (const r of repos) {
    for (const id of dirs(join(runsRoot(), r))) {
      const dbPath = join(runsRoot(), r, id, "state.db");
      let mtimeMs: number;
      try { mtimeMs = statSync(dbPath).mtimeMs; } catch { continue; }
      const key = `${runsRoot()}/${r}/${id}`;
      const hit = summaryCache.get(key);
      if (hit && hit.mtimeMs === mtimeMs) { out.push(hit.summary); continue; }

      const opened = openRun(r, id);
      if (!opened) continue;
      try {
        const row = runRow(opened.db);
        if (row) {
          const summary = withAttention(opened.db, row, liveness);
          out.push(summary);
          if (summary.status !== "running") summaryCache.set(key, { mtimeMs, summary });
        }
      } finally {
        opened.db.close();
      }
    }
  }
  return out.sort((a, b) => b.started_at - a.started_at);
}

export function readRun(repo: string, runId: string, liveness?: RunLiveness): RunDetail | null {
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
      run: {
        ...run,
        attention: computeAttention(run, stages, fields, decisions, Date.now(), liveness),
        last_event_at: lastEventAt(run, stages, fields, decisions),
        ticket: fieldValue(fields, "ticket"),
        branch: fieldValue(fields, "branch"),
        agent: agentMirror(run, fields, liveness),
        stages: stages.map((s) => ({ name: s.name, status: s.status, started_at: s.started_at })),
      },
      stages, fields, decisions,
      schemaAhead,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function findRun(runId: string, liveness?: RunLiveness): RunDetail | null {
  if (!isPathComponent(runId)) return null;
  for (const repo of dirs(runsRoot())) {
    if (dirs(join(runsRoot(), repo)).includes(runId)) return readRun(repo, runId, liveness);
  }
  return null;
}
