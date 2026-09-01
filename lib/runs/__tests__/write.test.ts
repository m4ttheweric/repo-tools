import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRunDb, KNOWN_SCHEMA_VERSION, migrate, openRunDb, runStart, runStatus, stageStart, stageEnd, fieldSet, fieldGet, decisionRecord, snapshot } from "../write.ts";
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

function started(): Database {
  const r = runStart(tmp(), { repo: "demo", workType: "feature", pipeline: "default", env: {} });
  if (!r.ok) throw new Error(r.error);
  return openRunDb(r.runDb);
}

describe("stage lifecycle", () => {
  test("stage-start inserts a running row, sets current_stage, and bumps attempt on re-entry", () => {
    const db = started();
    expect(stageStart(db, "plan", {}, 10)).toEqual({ ok: true });
    expect(stageEnd(db, "plan", "done", { now: 20 })).toEqual({ ok: true });
    expect(stageStart(db, "plan", {}, 30)).toEqual({ ok: true });
    const rows = db.query("SELECT attempt, status, started_at, ended_at FROM stages ORDER BY attempt").all();
    expect(rows).toEqual([{ attempt: 1, status: "done", started_at: 10, ended_at: 20 }, { attempt: 2, status: "running", started_at: 30, ended_at: null }]);
    expect(db.query("SELECT current_stage FROM runs").get()).toEqual({ current_stage: "plan" });
    db.close();
  });

  test("stage-start records identity from env", () => {
    const db = started();
    stageStart(db, "plan", { HERDR_PANE_ID: "w1:p4" }, 10);
    expect(db.query("SELECT value, produced_by FROM fields WHERE key='herdr-pane'").get()).toEqual({ value: "w1:p4", produced_by: "run" });
    db.close();
  });

  test("stage-fail records reason and detail path on the latest attempt", () => {
    const db = started();
    stageStart(db, "gates", {}, 10);
    expect(stageEnd(db, "gates", "failed", { reason: "cvi-islands assertion failed", detailPath: "/tmp/gates.log", now: 20 })).toEqual({ ok: true });
    expect(db.query("SELECT status, reason, detail_path FROM stages WHERE name='gates'").get()).toEqual({ status: "failed", reason: "cvi-islands assertion failed", detail_path: "/tmp/gates.log" });
    db.close();
  });

  test("a reason containing quotes is stored verbatim", () => {
    const db = started();
    stageStart(db, "gates", {}, 10);
    stageEnd(db, "gates", "failed", { reason: "expected '/c/1' got '/x'" });
    expect(db.query("SELECT reason FROM stages WHERE name='gates'").get()).toEqual({ reason: "expected '/c/1' got '/x'" });
    db.close();
  });

  test("stage-fail without a reason stores NULL", () => {
    const db = started();
    stageStart(db, "gates", {}, 10);
    stageEnd(db, "gates", "failed");
    expect(db.query("SELECT reason, detail_path FROM stages WHERE name='gates'").get()).toEqual({ reason: null, detail_path: null });
    db.close();
  });

  test("stage-done and stage-fail on a stage that was never started are exit 3 and write nothing", () => {
    const db = started();
    expect(stageEnd(db, "plan", "done")).toEqual({ ok: false, error: "stage never started: plan", code: 3 });
    expect(stageEnd(db, "gates", "failed", { reason: "boom" })).toEqual({ ok: false, error: "stage never started: gates", code: 3 });
    expect(db.query("SELECT COUNT(*) AS n FROM stages").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("fields", () => {
  test("field set/get round-trips a value with single quotes; a missing key is exit 3", () => {
    const db = started();
    expect(fieldSet(db, "mr-url", "https://x/1?a='b'", "ship", 10)).toEqual({ ok: true });
    expect(fieldGet(db, "mr-url")).toEqual({ ok: true, value: "https://x/1?a='b'" });
    expect(db.query("SELECT produced_by, at FROM fields WHERE key='mr-url'").get()).toEqual({ produced_by: "ship", at: 10 });
    expect(fieldGet(db, "nope")).toMatchObject({ ok: false, code: 3 });
    db.close();
  });

  test("field set replaces an existing key", () => {
    const db = started();
    fieldSet(db, "branch", "a", "provision", 10);
    fieldSet(db, "branch", "b", "provision", 20);
    expect(db.query("SELECT value, at FROM fields WHERE key='branch'").get()).toEqual({ value: "b", at: 20 });
    db.close();
  });
});

describe("decisions", () => {
  test("decision record upserts on (contract, scope) and refuses a selection that is not JSON", () => {
    const db = started();
    const rec = (selection: string) => decisionRecord(db, { contract: "execution-strategy@1", scope: "run", selection, decidedBy: "stage-plan" });
    expect(rec('{"tier":"direct-tdd"}')).toEqual({ ok: true });
    expect(rec('{"tier":"superpowers"}')).toEqual({ ok: true });
    const rows = db.query("SELECT selection FROM decisions").all() as { selection: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.selection).tier).toBe("superpowers");
    expect(rec("not json")).toMatchObject({ ok: false, code: 2 });
    db.close();
  });
});

describe("snapshot", () => {
  test("returns raw rows in the script's order", () => {
    const db = started();
    stageStart(db, "plan", {}, 10);
    stageEnd(db, "plan", "done", { now: 20 });
    stageStart(db, "gates", {}, 30);
    fieldSet(db, "b", "2", "plan", 50);
    fieldSet(db, "a", "1", "plan", 40);
    decisionRecord(db, { contract: "c@1", scope: "run", selection: "{}", decidedBy: "x", now: 60 });
    const s = snapshot(db);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.run).toMatchObject({ status: "running", current_stage: "gates" });
    expect(s.stages.map((r) => r.name)).toEqual(["plan", "gates"]);
    expect(s.fields.map((r) => r.key)).toEqual(["a", "b"]);
    expect(s.decisions).toHaveLength(1);
    expect(s.stages[0]).toHaveProperty("run_id");
    db.close();
  });
});
