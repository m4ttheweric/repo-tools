import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRunsHandlers } from "../handlers/runs.ts";

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-runs-handlers-"));
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
    INSERT INTO fields VALUES ('${id}', 'ticket', 'ACME-1', 'plan', ${startedAt});
    INSERT INTO decisions VALUES ('${id}', 'execution-strategy@1', 'run', '{"tier":"direct-tdd"}', 'stage-plan', ${startedAt});
  `);
  db.close();
}

const log = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} } as any;

describe("runs handlers", () => {
  test("runs:list scopes by repo; runs:get resolves with and without repo", async () => {
    const dir = root();
    seedRun(dir, "alpha", "20260821-010101-aaaa", 1000);
    const h = createRunsHandlers({ log } as any);
    const listHandler = h["runs:list"] as any;
    const getHandler = h["runs:get"] as any;
    const list = await listHandler({ repo: "alpha" });
    expect(list.ok).toBe(true);
    expect((list as any).data.runs).toHaveLength(1);
    const byBoth = await getHandler({ repo: "alpha", runId: "20260821-010101-aaaa" });
    expect((byBoth as any).data.run.repo).toBe("alpha");
    const byId = await getHandler({ runId: "20260821-010101-aaaa" });
    expect((byId as any).data.run.repo).toBe("alpha");
    const missing = await getHandler({ runId: "nope" });
    expect(missing.ok).toBe(false);
  });

  test("runs:get without runId is a validation error", async () => {
    const h = createRunsHandlers({ log } as any);
    const getHandler = h["runs:get"] as any;
    const r = await getHandler({} as any);
    expect(r.ok).toBe(false);
  });
});
