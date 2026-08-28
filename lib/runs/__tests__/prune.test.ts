import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "fs";
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

/** Polls until the detached rm -rf a prune spawns has actually removed `path` (S100: the delete is no longer synchronous). */
async function waitGone(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path} to be reaped`);
    await new Promise((r) => setTimeout(r, 20));
  }
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
  test("removes runs ended past the floor, keeps recent and running ones", async () => {
    const dir = root();
    const now = Date.now();
    seedRunEnded(dir, "alpha", "old-done", now - 40 * DAY, now - 40 * DAY);   // ended 40d ago -> pruned
    seedRunEnded(dir, "alpha", "new-done", now - 2 * DAY, now - 2 * DAY);     // recent -> kept
    seedRun(dir, "alpha", "still-running", now - 40 * DAY);                    // running, old start,
    // never-finished: age by state.db mtime (fresh in this test) -> kept
    const { removed } = pruneRuns(now);
    expect(removed).toEqual([join(dir, "alpha", "old-done")]);
    await waitGone(join(dir, "alpha", "old-done")); // reaped by a detached rm -rf, not synchronously
    expect(existsSync(join(dir, "alpha", "new-done"))).toBe(true);
    expect(existsSync(join(dir, "alpha", "still-running"))).toBe(true);
  });

  test("a running run ages out once its state.db mtime crosses the floor", async () => {
    const dir = root();
    const now = Date.now();
    seedRun(dir, "alpha", "stale-running", now - 40 * DAY);
    const dbPath = join(dir, "alpha", "stale-running", "state.db");
    const oldTime = new Date(now - 40 * DAY);
    utimesSync(dbPath, oldTime, oldTime);
    const { removed } = pruneRuns(now);
    expect(removed).toEqual([join(dir, "alpha", "stale-running")]);
    await waitGone(join(dir, "alpha", "stale-running"));
  });

  test("a stale regular file inside a repo dir is not mistaken for a run and survives pruning", () => {
    const dir = root();
    const now = Date.now();
    seedRun(dir, "alpha", "kept-run", now);
    const strayFile = join(dir, "alpha", "stray-file");
    writeFileSync(strayFile, "not a run dir");
    const oldTime = new Date(now - 40 * DAY);
    utimesSync(strayFile, oldTime, oldTime);
    const { removed } = pruneRuns(now);
    expect(removed).toEqual([]);
    expect(existsSync(strayFile)).toBe(true);
  });

  test("the guard refuses anything that is not <runsRoot>/<repo>/<runId>", () => {
    const dir = root();
    expect(() => assertPrunable("/", dir)).toThrow();
    expect(() => assertPrunable(dir, dir)).toThrow();
    expect(() => assertPrunable(join(dir, "alpha"), dir)).toThrow();
    expect(() => assertPrunable(join(dir, "alpha", "run-1"), dir)).not.toThrow();
  });

  test("the guard refuses a symlinked intermediate component that escapes the root", () => {
    const dir = root();
    const outside = mkdtempSync(join(tmpdir(), "rt-runs-prune-outside-"));
    mkdirSync(join(outside, "victim-run"), { recursive: true });
    symlinkSync(outside, join(dir, "alpha"));
    expect(() => assertPrunable(join(dir, "alpha", "victim-run"), dir)).toThrow();
    expect(existsSync(join(outside, "victim-run"))).toBe(true);
  });

  // S100: the boot-time prune (60s after start) previously unlinked every
  // expired run tree synchronously, blocking the daemon's single thread for
  // the full duration of each recursive rm — a tray poll or chat post
  // arriving mid-sweep would time out. The delete must be off-thread.
  test("prune spawns the delete asynchronously — the run dir is not synchronously unlinked (S100)", () => {
    const dir = root();
    const now = Date.now();
    seedRunEnded(dir, "alpha", "old-done", now - 40 * DAY, now - 40 * DAY);
    const { removed } = pruneRuns(now);
    expect(removed).toEqual([join(dir, "alpha", "old-done")]);
    // Not gone yet: the unlink runs in a detached child process, off this
    // thread, so pruneRuns returning never means the disk is clean yet.
    expect(existsSync(join(dir, "alpha", "old-done"))).toBe(true);
  });

  test("prune's detached delete eventually removes the run dir", async () => {
    const dir = root();
    const now = Date.now();
    seedRunEnded(dir, "alpha", "old-done", now - 40 * DAY, now - 40 * DAY);
    pruneRuns(now);
    await waitGone(join(dir, "alpha", "old-done"));
  });
});
