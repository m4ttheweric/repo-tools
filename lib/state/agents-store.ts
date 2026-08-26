/**
 * lib/state/agents-store.ts... handoff records for `rt agent`.
 * The only module that touches the agents table. Launch + record + resume
 * only: no liveness columns exist by design.
 */

import { Database } from "bun:sqlite";
import { getStateDb } from "./db.ts";
import { runCriticalWrite } from "./busy.ts";

export type AgentSurface = "herdr" | "headless";

export interface AgentRecord {
  id: string; repo: string; cwd: string; provider: string;
  surface: AgentSurface; sessionId: string;
  model?: string; effort?: string; account?: string;
  label?: string; caller?: string;
  paneId?: string; tabId?: string; workspaceId?: string;
  extraArgs?: string; exitCode?: number; resultPath?: string;
  createdAt: number; lastResumedAt?: number; finishedAt?: number;
}

const COLUMNS =
  "id, repo, cwd, provider, surface, session_id, model, effort, account, label, caller, " +
  "pane_id, tab_id, workspace_id, extra_args, exit_code, result_path, " +
  "created_at, last_resumed_at, finished_at";

const INSERT_SQL = `INSERT INTO agents (${COLUMNS}) VALUES (${COLUMNS.split(",").map(() => "?").join(", ")});`;
const SELECT_ONE_SQL = `SELECT ${COLUMNS} FROM agents WHERE id = ? OR session_id = ?;`;
const SELECT_ALL_SQL = `SELECT ${COLUMNS} FROM agents ORDER BY created_at DESC;`;
const SELECT_REPO_SQL = `SELECT ${COLUMNS} FROM agents WHERE repo = ? ORDER BY created_at DESC;`;
const UPDATE_PANE_SQL = `UPDATE agents SET pane_id = ?, tab_id = ?, workspace_id = ? WHERE id = ?;`;
const UPDATE_RESUMED_SQL = `UPDATE agents SET last_resumed_at = ? WHERE id = ?;`;
const UPDATE_FINISH_SQL = `UPDATE agents SET exit_code = ?, result_path = ?, finished_at = ? WHERE id = ?;`;
const DELETE_SQL = `DELETE FROM agents WHERE id = ?;`;

interface AgentRow {
  id: string; repo: string; cwd: string; provider: string; surface: string;
  session_id: string; model: string | null; effort: string | null;
  account: string | null; label: string | null; caller: string | null;
  pane_id: string | null; tab_id: string | null; workspace_id: string | null;
  extra_args: string | null; exit_code: number | null; result_path: string | null;
  created_at: number; last_resumed_at: number | null; finished_at: number | null;
}

function rowToRecord(r: AgentRow): AgentRecord {
  const rec: AgentRecord = {
    id: r.id, repo: r.repo, cwd: r.cwd, provider: r.provider,
    surface: r.surface as AgentSurface, sessionId: r.session_id,
    createdAt: r.created_at,
  };
  if (r.model !== null) rec.model = r.model;
  if (r.effort !== null) rec.effort = r.effort;
  if (r.account !== null) rec.account = r.account;
  if (r.label !== null) rec.label = r.label;
  if (r.caller !== null) rec.caller = r.caller;
  if (r.pane_id !== null) rec.paneId = r.pane_id;
  if (r.tab_id !== null) rec.tabId = r.tab_id;
  if (r.workspace_id !== null) rec.workspaceId = r.workspace_id;
  if (r.extra_args !== null) rec.extraArgs = r.extra_args;
  if (r.exit_code !== null) rec.exitCode = r.exit_code;
  if (r.result_path !== null) rec.resultPath = r.result_path;
  if (r.last_resumed_at !== null) rec.lastResumedAt = r.last_resumed_at;
  if (r.finished_at !== null) rec.finishedAt = r.finished_at;
  return rec;
}

export function newAgentId(): string {
  return `ag-${crypto.randomUUID().slice(0, 8)}`;
}

export function insertAgent(rec: AgentRecord, db: Database = getStateDb()): void {
  const run = () =>
    db.query(INSERT_SQL).run(
      rec.id, rec.repo, rec.cwd, rec.provider, rec.surface, rec.sessionId,
      rec.model ?? null, rec.effort ?? null, rec.account ?? null,
      rec.label ?? null, rec.caller ?? null,
      rec.paneId ?? null, rec.tabId ?? null, rec.workspaceId ?? null,
      rec.extraArgs ?? null, rec.exitCode ?? null, rec.resultPath ?? null,
      rec.createdAt, rec.lastResumedAt ?? null, rec.finishedAt ?? null,
    );
  runCriticalWrite("insertAgent", run, { id: rec.id });
}

export function getAgent(idOrSession: string, db: Database = getStateDb()): AgentRecord | undefined {
  const row = db.query(SELECT_ONE_SQL).get(idOrSession, idOrSession) as AgentRow | null;
  return row ? rowToRecord(row) : undefined;
}

export function listAgents(args: { repo?: string }, db: Database = getStateDb()): AgentRecord[] {
  const rows = (args.repo
    ? db.query(SELECT_REPO_SQL).all(args.repo)
    : db.query(SELECT_ALL_SQL).all()) as AgentRow[];
  return rows.map(rowToRecord);
}

export function updateAgentPane(
  id: string, ids: { paneId: string; tabId: string; workspaceId: string },
  db: Database = getStateDb(),
): void {
  runCriticalWrite("updateAgentPane", () => db.query(UPDATE_PANE_SQL).run(ids.paneId, ids.tabId, ids.workspaceId, id), { id });
}

export function markAgentResumed(id: string, at: number, db: Database = getStateDb()): void {
  runCriticalWrite("markAgentResumed", () => db.query(UPDATE_RESUMED_SQL).run(at, id), { id });
}

export function finishAgent(
  id: string, args: { exitCode: number; resultPath: string; finishedAt: number },
  db: Database = getStateDb(),
): void {
  runCriticalWrite("finishAgent", () => db.query(UPDATE_FINISH_SQL).run(args.exitCode, args.resultPath, args.finishedAt, id), { id });
}

export function deleteAgent(id: string, db: Database = getStateDb()): void {
  runCriticalWrite("deleteAgent", () => db.query(DELETE_SQL).run(id), { id });
}
