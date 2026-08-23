/**
 * lib/state/run-history-store.ts — run_history: per-repo append-with-
 * bounded-retention `rt run` invocation history.
 *
 * HOME isolation is handled by the repo-wide bun test preload
 * (test-setup.ts) — never removed here. Stores are constructed via
 * openStateDb(tempPath) per the house convention.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import { appendRunHistoryEntry, listRunHistory, type RunHistoryEntry } from "../run-history-store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-run-history-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openDb(): Database {
  return openStateDb(join(dir, "state.db"), "cli");
}

function entry(overrides: Partial<RunHistoryEntry> = {}): RunHistoryEntry {
  return {
    ts: "2026-08-22T00:00:00Z",
    cmd: "pnpm run test:user",
    cwd: "/repo/api",
    worktree: "/repo",
    branch: "main",
    pkg: "api",
    script: "test:user",
    exit: 0,
    ...overrides,
  };
}

describe("appendRunHistoryEntry / listRunHistory", () => {
  test("an untouched repo has no history", () => {
    const db = openDb();
    expect(listRunHistory("repo-a", 200, db)).toEqual([]);
  });

  test("append persists and list round-trips, including a null exit code", () => {
    const db = openDb();
    const e = entry({ exit: null });
    appendRunHistoryEntry("repo-a", e, db);
    expect(listRunHistory("repo-a", 200, db)).toEqual([e]);
  });

  test("list is newest-first", () => {
    const db = openDb();
    appendRunHistoryEntry("repo-a", entry({ cmd: "first" }), db);
    appendRunHistoryEntry("repo-a", entry({ cmd: "second" }), db);
    appendRunHistoryEntry("repo-a", entry({ cmd: "third" }), db);
    expect(listRunHistory("repo-a", 200, db).map((e) => e.cmd)).toEqual(["third", "second", "first"]);
  });

  test("history for one repo does not leak into another repo's list", () => {
    const db = openDb();
    appendRunHistoryEntry("repo-a", entry(), db);
    expect(listRunHistory("repo-b", 200, db)).toEqual([]);
  });

  test("limit caps the number of rows returned, newest first", () => {
    const db = openDb();
    for (let i = 0; i < 5; i++) appendRunHistoryEntry("repo-a", entry({ cmd: `run-${i}` }), db);
    expect(listRunHistory("repo-a", 2, db).map((e) => e.cmd)).toEqual(["run-4", "run-3"]);
  });

  test("bounded retention: appending past the max keeps only the newest entries for that repo", () => {
    const db = openDb();
    const MAX = 200;
    for (let i = 0; i < MAX + 10; i++) appendRunHistoryEntry("repo-a", entry({ cmd: `run-${i}` }), db);
    const all = listRunHistory("repo-a", MAX + 50, db);
    expect(all.length).toBe(MAX);
    expect(all[0]!.cmd).toBe(`run-${MAX + 9}`); // newest survives
    expect(all[all.length - 1]!.cmd).toBe("run-10"); // oldest 10 were trimmed
  });

  test("retention is scoped per repo: trimming repo-a never touches repo-b's rows", () => {
    const db = openDb();
    const MAX = 200;
    appendRunHistoryEntry("repo-b", entry({ cmd: "keep-me" }), db);
    for (let i = 0; i < MAX + 5; i++) appendRunHistoryEntry("repo-a", entry({ cmd: `run-${i}` }), db);
    expect(listRunHistory("repo-b", 200, db).map((e) => e.cmd)).toEqual(["keep-me"]);
  });

  test("a fresh handle on the same file sees the last write (daemon restart)", () => {
    const dbPath = join(dir, "state.db");
    const db1 = openStateDb(dbPath, "cli");
    appendRunHistoryEntry("repo-a", entry(), db1);
    db1.close();

    const db2 = openStateDb(dbPath, "cli");
    expect(listRunHistory("repo-a", 200, db2)).toEqual([entry()]);
    db2.close();
  });
});
