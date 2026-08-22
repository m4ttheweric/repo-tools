import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assertPrunable, pruneRuns } from "../prune.ts";

const DAY = 24 * 60 * 60 * 1000;

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-runs-prune-"));
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

function seedRunEnded(dir: string, repo: string, id: string, startedAt: number, endedAt: number, status = "done"): void {
  const runDir = join(dir, repo, id);
  mkdirSync(runDir, { recursive: true });
  const db = new Database(join(runDir, "state.db"));
  db.exec(`
    PRAGMA user_version=1;
    CREATE TABLE runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, work_type TEXT NOT NULL,
      pipeline TEXT NOT NULL, status TEXT NOT NULL, current_stage TEXT,
      spawned_by TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE TABLE stages (run_id TEXT, name TEXT, status TEXT, attempt INTEGER DEFAULT 1,
      started_at INTEGER, ended_at INTEGER, PRIMARY KEY (run_id, name, attempt));
    CREATE TABLE fields (run_id TEXT, key TEXT, value TEXT, produced_by TEXT, at INTEGER, PRIMARY KEY (run_id, key));
    CREATE TABLE decisions (run_id TEXT, contract TEXT, scope TEXT, selection TEXT, decided_by TEXT, decided_at INTEGER, PRIMARY KEY (run_id, contract, scope));
    INSERT INTO runs VALUES ('${id}', '${repo}', 'feature', 'default', '${status}', NULL, NULL, ${startedAt}, ${endedAt});
    INSERT INTO stages VALUES ('${id}', 'plan', '${status}', 1, ${startedAt}, ${endedAt});
  `);
  db.close();
}

describe("pruneRuns", () => {
  test("removes runs ended past the floor, keeps recent and running ones", () => {
    const dir = root();
    const now = Date.now();
    seedRunEnded(dir, "alpha", "old-done", now - 40 * DAY, now - 40 * DAY);   // ended 40d ago -> pruned
    seedRunEnded(dir, "alpha", "new-done", now - 2 * DAY, now - 2 * DAY);     // recent -> kept
    seedRun(dir, "alpha", "still-running", now - 40 * DAY);                    // running, old start,
    // never-finished: age by state.db mtime (fresh in this test) -> kept
    const { removed } = pruneRuns(now);
    expect(removed).toEqual([join(dir, "alpha", "old-done")]);
    expect(existsSync(join(dir, "alpha", "old-done"))).toBe(false);
    expect(existsSync(join(dir, "alpha", "new-done"))).toBe(true);
    expect(existsSync(join(dir, "alpha", "still-running"))).toBe(true);
  });

  test("the guard refuses anything that is not <runsRoot>/<repo>/<runId>", () => {
    const dir = root();
    expect(() => assertPrunable("/", dir)).toThrow();
    expect(() => assertPrunable(dir, dir)).toThrow();
    expect(() => assertPrunable(join(dir, "alpha"), dir)).toThrow();
    expect(() => assertPrunable(join(dir, "alpha", "run-1"), dir)).not.toThrow();
  });
});
