import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRunDb, KNOWN_SCHEMA_VERSION, migrate, openRunDb, runStart, runStatus } from "../write.ts";
import { seedRun } from "./fixtures.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rt-runs-write-"));
}

function cols(db: Database, table: string): string[] {
  return (db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((r) => r.name);
}

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

afterEach(() => { delete process.env.RT_RUNS_ROOT; });

describe("createRunDb", () => {
  test("creates the four tables, WAL mode, and stamps the current schema version", () => {
    const path = join(tmp(), "r", "20260901-000000-abcd-1", "state.db");
    const db = createRunDb(path);
    try {
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      expect(tables).toEqual(["decisions", "fields", "runs", "stages"]);
      expect(userVersion(db)).toBe(KNOWN_SCHEMA_VERSION);
      expect(cols(db, "stages")).toContain("reason");
      expect(cols(db, "runs")).toContain("pack_dirty");
      const mode = (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
      expect(mode).toBe("wal");
    } finally {
      db.close();
    }
  });
});

describe("migrate", () => {
  test("brings a v1 DB to v2 in place and is idempotent", () => {
    const root = tmp();
    seedRun(root, "r", "20260901-000000-abcd-1", 1000, 1);
    const path = join(root, "r", "20260901-000000-abcd-1", "state.db");
    const db = openRunDb(path);
    try {
      expect(userVersion(db)).toBe(2);
      expect(cols(db, "stages")).toContain("detail_path");
      expect(cols(db, "runs")).toContain("pack_commits");
      migrate(db);
      expect(userVersion(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  test("openRunDb sets busy_timeout", () => {
    const path = join(tmp(), "r", "x", "state.db");
    createRunDb(path).close();
    const db = openRunDb(path);
    try {
      const t = (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
      expect(t).toBe(5000);
    } finally {
      db.close();
    }
  });
});

describe("runStart", () => {
  test("creates the DB under root/repo/runId, records ticket under producer work, stamps v2", () => {
    const root = tmp();
    const r = runStart(root, { repo: "demo", workType: "feature", pipeline: "default", spawnedBy: "test", ticket: "ABC-1", env: {}, now: 5000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.runDb).toBe(join(root, "demo", r.runId, "state.db"));
    const db = new Database(r.runDb, { readonly: true });
    const run = db.query("SELECT * FROM runs").get() as Record<string, unknown>;
    expect(run).toMatchObject({ id: r.runId, repo: "demo", work_type: "feature", pipeline: "default", status: "running", spawned_by: "test", started_at: 5000, pack_commits: null, pack_dirty: 0 });
    expect(db.query("SELECT value, produced_by FROM fields WHERE key='ticket'").get()).toEqual({ value: "ABC-1", produced_by: "work" });
    expect(userVersion(db)).toBe(2);
    db.close();
  });

  test("generates a run id of the form YYYYMMDD-HHMMSS-xxxx-pid when none is given", () => {
    const r = runStart(tmp(), { repo: "demo", workType: "fix", pipeline: "default", env: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.runId).toMatch(new RegExp(`^\\d{8}-\\d{6}-[0-9a-f]{4}-${process.pid}$`));
  });

  test("no ticket flag writes no ticket field", () => {
    const r = runStart(tmp(), { repo: "demo", workType: "fix", pipeline: "default", env: {} });
    if (!r.ok) throw new Error(r.error);
    const db = new Database(r.runDb, { readonly: true });
    expect(db.query("SELECT COUNT(*) AS n FROM fields WHERE key='ticket'").get()).toEqual({ n: 0 });
    db.close();
  });

  test("mattstack sha and dirty flag and raw pack sha land in pack_commits and pack_dirty in order", () => {
    const r = runStart(tmp(), { repo: "demo", workType: "fix", pipeline: "default", mattstackSha: "deadbee", mattstackDirty: true, packSha: "acme=abc1234", packDirs: [""], env: {} });
    if (!r.ok) throw new Error(r.error);
    const db = new Database(r.runDb, { readonly: true });
    expect(db.query("SELECT pack_commits, pack_dirty FROM runs").get()).toEqual({ pack_commits: "mattstack=deadbee,acme=abc1234", pack_dirty: 1 });
    db.close();
  });

  test("a duplicate run id is exit 1; a v1 directory is migrated first", () => {
    const root = tmp();
    seedRun(root, "demo", "20260901-000000-abcd-1", 1000, 1);
    const dup = runStart(root, { repo: "demo", workType: "fix", pipeline: "default", runId: "20260901-000000-abcd-1", env: {} });
    expect(dup).toMatchObject({ ok: false, code: 1 });
    const db = new Database(join(root, "demo", "20260901-000000-abcd-1", "state.db"), { readonly: true });
    expect(userVersion(db)).toBe(2);
    db.close();
  });

  test("a repo that is not a plain path component is exit 2", () => {
    expect(runStart(tmp(), { repo: "../x", workType: "fix", pipeline: "default", env: {} })).toMatchObject({ ok: false, code: 2 });
  });

  test("records identity from env", () => {
    const r = runStart(tmp(), { repo: "demo", workType: "fix", pipeline: "default", env: { CLAUDE_CODE_SESSION_ID: "s1", HERDR_PANE_ID: "w1:p1" } });
    if (!r.ok) throw new Error(r.error);
    const db = new Database(r.runDb, { readonly: true });
    expect(db.query("SELECT value FROM fields WHERE key='claude-session'").get()).toEqual({ value: "s1" });
    expect(db.query("SELECT produced_by FROM fields WHERE key='herdr-pane'").get()).toEqual({ produced_by: "run" });
    db.close();
  });
});

describe("runStatus", () => {
  test("closes the run with the given status; anything else is exit 2", () => {
    const r = runStart(tmp(), { repo: "demo", workType: "fix", pipeline: "default", env: {} });
    if (!r.ok) throw new Error(r.error);
    const db = openRunDb(r.runDb);
    expect(runStatus(db, "done", 9000)).toEqual({ ok: true });
    expect(db.query("SELECT status, ended_at FROM runs").get()).toEqual({ status: "done", ended_at: 9000 });
    expect(runStatus(db, "paused")).toMatchObject({ ok: false, code: 2 });
    db.close();
  });
});
