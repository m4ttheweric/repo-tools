/**
 * lib/state/endpoint-claims-store.ts — dev-server port claims: one row per
 * (repo, worktree, role) in `endpoint_claims`.
 *
 * A dedicated table, not a `kv` blob: allocation and release act on point
 * lookups (find the claim for one worktree+role) and point deletes, and a
 * whole-array blob would force every such operation to decode, mutate, and
 * re-encode the full per-repo array. `PRIMARY KEY (repo, worktree, role)`
 * makes those point operations direct SQL instead.
 */

import { Database } from "bun:sqlite";
import { getStateDb } from "./db.ts";
import { persistOrWarn, runCriticalWrite } from "./busy.ts";

export interface EndpointClaim {
  worktree: string;
  role: string;
  port: number;
  pid?: number;
  ts: string;
}

interface ClaimRow {
  worktree: string;
  role: string;
  port: number;
  pid: number | null;
  ts: string;
}

function rowToClaim(row: ClaimRow): EndpointClaim {
  const claim: EndpointClaim = { worktree: row.worktree, role: row.role, port: row.port, ts: row.ts };
  if (row.pid !== null) claim.pid = row.pid;
  return claim;
}

const SELECT_REPO_SQL = `SELECT worktree, role, port, pid, ts FROM endpoint_claims WHERE repo = ? ORDER BY worktree, role;`;
const DELETE_REPO_SQL = `DELETE FROM endpoint_claims WHERE repo = ?;`;
const INSERT_SQL = `INSERT INTO endpoint_claims (repo, worktree, role, port, pid, ts) VALUES (?, ?, ?, ?, ?, ?);`;

export function listEndpointClaims(repo: string, db: Database = getStateDb()): EndpointClaim[] {
  const rows = db.query(SELECT_REPO_SQL).all(repo) as ClaimRow[];
  return rows.map(rowToClaim);
}

/** Whether this repo has any claim rows at all — the migrate-on-read gate for the legacy endpoints.json importer. */
export function hasEndpointClaims(repo: string, db: Database = getStateDb()): boolean {
  return db.query(`SELECT 1 FROM endpoint_claims WHERE repo = ? LIMIT 1;`).get(repo) != null;
}

/**
 * Whole-array replace for one repo, kept transactional so a concurrent
 * reader never observes a repo with its old claims deleted but the new set
 * not yet inserted.
 */
export function replaceEndpointClaims(repo: string, claims: EndpointClaim[], db: Database = getStateDb()): void {
  const run = db.transaction((entries: EndpointClaim[]) => {
    db.query(DELETE_REPO_SQL).run(repo);
    const insert = db.query(INSERT_SQL);
    for (const c of entries) insert.run(repo, c.worktree, c.role, c.port, c.pid ?? null, c.ts);
  });
  persistOrWarn("endpoint-claims", () => run(claims), { repo, op: "replace", count: claims.length });
}

/**
 * Critical variant: retries on busy and reports whether the replace landed,
 * for a caller that must not advance state on a dropped claim write.
 */
export function replaceEndpointClaimsCritical(repo: string, claims: EndpointClaim[], db: Database = getStateDb()): boolean {
  const run = db.transaction((entries: EndpointClaim[]) => {
    db.query(DELETE_REPO_SQL).run(repo);
    const insert = db.query(INSERT_SQL);
    for (const c of entries) insert.run(repo, c.worktree, c.role, c.port, c.pid ?? null, c.ts);
  });
  const done = runCriticalWrite(
    "endpoint-claims",
    () => { run(claims); return true; },
    { repo, op: "replace", count: claims.length },
  );
  return done === true;
}
