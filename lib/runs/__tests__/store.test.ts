import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findRun, listRuns, readRun } from "../store.ts";

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-runs-store-"));
  process.env.RT_RUNS_ROOT = dir;
  return dir;
}
afterEach(() => { delete process.env.RT_RUNS_ROOT; });

function seedRun(dir: string, repo: string, id: string, startedAt: number, userVersion = 1): void {
  const runDir = join(dir, repo, id);
  mkdirSync(runDir, { recursive: true });
  const db = new Database(join(runDir, "state.db"));
  db.exec(`
    PRAGMA user_version=${userVersion};
    CREATE TABLE runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, work_type TEXT NOT NULL,
      pipeline TEXT NOT NULL, status TEXT NOT NULL, current_stage TEXT,
      spawned_by TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE TABLE stages (run_id TEXT, name TEXT, status TEXT, attempt INTEGER DEFAULT 1,
      started_at INTEGER, ended_at INTEGER, PRIMARY KEY (run_id, name, attempt));
    CREATE TABLE fields (run_id TEXT, key TEXT, value TEXT, produced_by TEXT, at INTEGER, PRIMARY KEY (run_id, key));
    CREATE TABLE decisions (run_id TEXT, contract TEXT, scope TEXT, selection TEXT, decided_by TEXT, decided_at INTEGER, PRIMARY KEY (run_id, contract, scope));
    INSERT INTO runs VALUES ('${id}', '${repo}', 'feature', 'default', 'running', 'plan', NULL, ${startedAt}, NULL);
    INSERT INTO stages VALUES ('${id}', 'plan', 'running', 1, ${startedAt}, NULL);
    INSERT INTO fields VALUES ('${id}', 'ticket', 'CV-1', 'plan', ${startedAt});
    INSERT INTO decisions VALUES ('${id}', 'execution-strategy@1', 'run', '{"tier":"direct-tdd"}', 'stage-plan', ${startedAt});
  `);
  db.close();
}

describe("runs store", () => {
  test("listRuns returns newest first, scoped to a repo or across all", () => {
    const dir = root();
    seedRun(dir, "alpha", "20260821-010101-aaaa", 1000);
    seedRun(dir, "alpha", "20260821-020202-bbbb", 2000);
    seedRun(dir, "beta",  "20260821-030303-cccc", 3000);
    expect(listRuns("alpha").map(r => r.id)).toEqual(["20260821-020202-bbbb", "20260821-010101-aaaa"]);
    expect(listRuns().map(r => r.repo)).toEqual(["beta", "alpha", "alpha"]);
  });

  test("readRun returns the full document; unknown run is null", () => {
    const dir = root();
    seedRun(dir, "alpha", "20260821-010101-aaaa", 1000);
    const d = readRun("alpha", "20260821-010101-aaaa")!;
    expect(d.run.status).toBe("running");
    expect(d.stages).toHaveLength(1);
    expect(d.fields.length).toBeGreaterThan(0);
    expect(d.fields[0]!).toMatchObject({ key: "ticket", value: "CV-1" });
    expect(d.decisions.length).toBeGreaterThan(0);
    expect(d.decisions[0]!.contract).toBe("execution-strategy@1");
    expect(d.schemaAhead).toBe(false);
    expect(readRun("alpha", "nope")).toBeNull();
  });

  test("findRun resolves the repo by scanning; newer schema flags schemaAhead", () => {
    const dir = root();
    seedRun(dir, "beta", "20260821-030303-cccc", 3000, 99);
    const d = findRun("20260821-030303-cccc")!;
    expect(d.run.repo).toBe("beta");
    expect(d.schemaAhead).toBe(true);
  });

  test("a corrupt or missing state.db is skipped, not thrown", () => {
    const dir = root();
    mkdirSync(join(dir, "alpha", "broken"), { recursive: true });
    seedRun(dir, "alpha", "20260821-010101-aaaa", 1000);
    expect(listRuns("alpha")).toHaveLength(1);
  });

  test("corrupt state.db (garbage bytes) is skipped, not thrown", () => {
    const dir = root();
    mkdirSync(join(dir, "alpha", "corrupt"), { recursive: true });
    writeFileSync(join(dir, "alpha", "corrupt", "state.db"), "garbage data");
    seedRun(dir, "alpha", "20260821-010101-aaaa", 1000);
    expect(listRuns("alpha")).toHaveLength(1);
    expect(readRun("alpha", "corrupt")).toBeNull();
    expect(findRun("corrupt")).toBeNull();
  });

  test("path-traversal repo/runId components are rejected, not joined", () => {
    root();
    expect(readRun("..", "x")).toBeNull();
    expect(findRun("a/b")).toBeNull();
  });
});
