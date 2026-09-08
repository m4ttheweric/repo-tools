/**
 * Herd registry: one row per shepherd run and one per worker job. Its own
 * SQLite file beside gates.db so it never takes part in state.db's
 * SCHEMA_VERSION claim; open idiom copied from gates-store.ts.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import type { Logger } from "pino";
import { isCorruptionError } from "../state/db.ts";

export type HerdStatus = "active" | "wrapped";
export type HerdJobStatus = "spawning" | "active" | "at-gate" | "at-milestone" | "done" | "closed" | "crashed";

export interface HerdRow {
  id: string; repo: string; room: string; workspace: string;
  shepherdSession: string; shepherdHandle: string;
  herdrSocket: string | null; hidden: boolean;
  status: HerdStatus; createdAt: number; wrappedAt: number | null;
}

export interface HerdJobRow {
  herd: string; name: string; worktree: string; branch: string | null;
  tree: string | null;
  pane: string | null; agentSession: string | null; agentId: string | null;
  handle: string; status: HerdJobStatus; disposable: boolean;
  lastGate: string | null; lastReport: number | null;
  createdAt: number; updatedAt: number;
}

export interface HerdStore {
  create(input: Omit<HerdRow, "status" | "createdAt" | "wrappedAt">): HerdRow;
  get(id: string): HerdRow | null;
  list(filter?: { status?: HerdStatus }): HerdRow[];
  setShepherd(id: string, s: { session: string; handle: string }): void;
  setHerdStatus(id: string, status: HerdStatus): void;
  upsertJob(input: { herd: string; name: string; worktree: string; branch?: string | null; tree?: string | null; pane?: string | null; agentSession?: string | null; agentId?: string | null; handle: string; status: HerdJobStatus; disposable?: boolean }): HerdJobRow;
  getJob(herd: string, name: string): HerdJobRow | null;
  jobs(herd: string): HerdJobRow[];
  jobsByPane(pane: string): HerdJobRow[];
  jobBySubject(subject: string): HerdJobRow | null;
  setJobStatus(herd: string, name: string, status: HerdJobStatus, extra?: { lastGate?: string | null; lastReport?: number | null }): void;
  close_(): void;
}

const JOB_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export function isValidJobName(name: string): boolean { return JOB_NAME_RE.test(name); }

export function herdSubject(herdId: string, job: string): string { return `herd:${herdId}/${job}`; }

const SUBJECT_RE = /^herd:([^/]+)\/([^/]+)$/;
export function parseHerdSubject(subject: string): { herd: string; job: string } | null {
  const m = SUBJECT_RE.exec(subject);
  return m ? { herd: m[1]!, job: m[2]! } : null;
}

export function mintHerdId(name: string, now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${name}-${stamp}`;
}

interface HerdColumns { id: string; repo: string; room: string; workspace: string; shepherdSession: string; shepherdHandle: string; herdrSocket: string | null; hidden: number; status: HerdStatus; createdAt: number; wrappedAt: number | null }
interface JobColumns { herd: string; name: string; worktree: string; branch: string | null; tree: string | null; pane: string | null; agentSession: string | null; agentId: string | null; handle: string; status: HerdJobStatus; disposable: number; lastGate: string | null; lastReport: number | null; createdAt: number; updatedAt: number }

const toHerd = (r: HerdColumns): HerdRow => ({ ...r, hidden: r.hidden === 1 });
const toJob = (r: JobColumns): HerdJobRow => ({ ...r, disposable: r.disposable === 1 });

function quarantine(path: string, log: Logger): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  log.warn({ path }, "herds db could not be opened (corrupt), quarantining and recreating empty");
  renameSync(path, `${path}.corrupt-${stamp}`);
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    try { renameSync(sidecar, `${sidecar}.corrupt-${stamp}`); } catch { /* sidecar absent */ }
  }
}

export function createHerdStore(opts: { dbPath: string; log: Logger }): HerdStore {
  const log = opts.log.child({ module: "herds" });
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const openDb = () => {
    const db = new Database(opts.dbPath, { create: true });
    db.exec("PRAGMA busy_timeout = 250;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    return db;
  };
  let db: Database;
  try {
    db = openDb();
    db.query("PRAGMA user_version").get();
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    quarantine(opts.dbPath, log);
    db = openDb();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS herds (
      id              TEXT PRIMARY KEY,
      repo            TEXT NOT NULL,
      room            TEXT NOT NULL,
      workspace       TEXT NOT NULL,
      shepherdSession TEXT NOT NULL,
      shepherdHandle  TEXT NOT NULL,
      herdrSocket     TEXT,
      hidden          INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL,
      createdAt       INTEGER NOT NULL,
      wrappedAt       INTEGER
    );
    CREATE TABLE IF NOT EXISTS herd_jobs (
      herd         TEXT NOT NULL,
      name         TEXT NOT NULL,
      worktree     TEXT NOT NULL,
      branch       TEXT,
      tree         TEXT,
      pane         TEXT,
      agentSession TEXT,
      agentId      TEXT,
      handle       TEXT NOT NULL,
      status       TEXT NOT NULL,
      disposable   INTEGER NOT NULL DEFAULT 0,
      lastGate     TEXT,
      lastReport   INTEGER,
      createdAt    INTEGER NOT NULL,
      updatedAt    INTEGER NOT NULL,
      PRIMARY KEY (herd, name)
    );
    CREATE INDEX IF NOT EXISTS idx_herd_jobs_pane ON herd_jobs(pane);
  `);

  const getHerd = db.prepare("SELECT * FROM herds WHERE id = ?");
  const insertHerd = db.prepare("INSERT INTO herds (id, repo, room, workspace, shepherdSession, shepherdHandle, herdrSocket, hidden, status, createdAt, wrappedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)");
  const getJobStmt = db.prepare("SELECT * FROM herd_jobs WHERE herd = ? AND name = ?");
  const jobsStmt = db.prepare("SELECT * FROM herd_jobs WHERE herd = ? ORDER BY createdAt");
  const jobsByPaneStmt = db.prepare("SELECT * FROM herd_jobs WHERE pane = ?");

  return {
    create(input) {
      if (getHerd.get(input.id)) throw new Error(`herd ${input.id} already exists`);
      const now = Date.now();
      insertHerd.run(input.id, input.repo, input.room, input.workspace, input.shepherdSession, input.shepherdHandle, input.herdrSocket, input.hidden ? 1 : 0, now);
      return toHerd(getHerd.get(input.id) as HerdColumns);
    },
    get(id) {
      const r = getHerd.get(id) as HerdColumns | null;
      return r ? toHerd(r) : null;
    },
    list(filter = {}) {
      const rows = filter.status
        ? db.query("SELECT * FROM herds WHERE status = ? ORDER BY createdAt").all(filter.status)
        : db.query("SELECT * FROM herds ORDER BY createdAt").all();
      return (rows as HerdColumns[]).map(toHerd);
    },
    setShepherd(id, s) {
      db.run("UPDATE herds SET shepherdSession = ?, shepherdHandle = ? WHERE id = ?", [s.session, s.handle, id]);
    },
    setHerdStatus(id, status) {
      db.run("UPDATE herds SET status = ?, wrappedAt = ? WHERE id = ?", [status, status === "wrapped" ? Date.now() : null, id]);
    },
    upsertJob(input) {
      if (!isValidJobName(input.name)) throw new Error(`invalid job name "${input.name}" (must match ${JOB_NAME_RE})`);
      const now = Date.now();
      const existing = getJobStmt.get(input.herd, input.name) as JobColumns | null;
      if (!existing) {
        db.run(
          "INSERT INTO herd_jobs (herd, name, worktree, branch, tree, pane, agentSession, agentId, handle, status, disposable, lastGate, lastReport, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
          [input.herd, input.name, input.worktree, input.branch ?? null, input.tree ?? null, input.pane ?? null, input.agentSession ?? null, input.agentId ?? null, input.handle, input.status, input.disposable ? 1 : 0, now, now],
        );
      } else {
        db.run(
          "UPDATE herd_jobs SET worktree = ?, branch = ?, tree = ?, pane = ?, agentSession = ?, agentId = ?, handle = ?, status = ?, disposable = ?, updatedAt = ? WHERE herd = ? AND name = ?",
          [input.worktree, input.branch ?? existing.branch, input.tree ?? existing.tree, input.pane ?? existing.pane, input.agentSession ?? existing.agentSession, input.agentId ?? existing.agentId, input.handle, input.status, input.disposable === undefined ? existing.disposable : (input.disposable ? 1 : 0), now, input.herd, input.name],
        );
      }
      return toJob(getJobStmt.get(input.herd, input.name) as JobColumns);
    },
    getJob(herd, name) {
      const r = getJobStmt.get(herd, name) as JobColumns | null;
      return r ? toJob(r) : null;
    },
    jobs(herd) { return (jobsStmt.all(herd) as JobColumns[]).map(toJob); },
    jobsByPane(pane) { return (jobsByPaneStmt.all(pane) as JobColumns[]).map(toJob); },
    jobBySubject(subject) {
      const parsed = parseHerdSubject(subject);
      if (!parsed) return null;
      const r = getJobStmt.get(parsed.herd, parsed.job) as JobColumns | null;
      return r ? toJob(r) : null;
    },
    setJobStatus(herd, name, status, extra = {}) {
      const sets = ["status = ?", "updatedAt = ?"];
      const vals: unknown[] = [status, Date.now()];
      if (extra.lastGate !== undefined) { sets.push("lastGate = ?"); vals.push(extra.lastGate); }
      if (extra.lastReport !== undefined) { sets.push("lastReport = ?"); vals.push(extra.lastReport); }
      vals.push(herd, name);
      db.run(`UPDATE herd_jobs SET ${sets.join(", ")} WHERE herd = ? AND name = ?`, vals as never[]);
    },
    close_() { db.close(); },
  };
}
