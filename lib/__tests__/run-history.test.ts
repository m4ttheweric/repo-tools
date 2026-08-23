/**
 * lib/run-history.ts — thin domain wrapper over lib/state/run-history-store.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repoDataDir, rtDir } from "../rt-paths.ts";
import { closeStateDb } from "../state/index.ts";
import { appendRunHistory, readRunHistory, type RunHistoryEntry } from "../run-history.ts";

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

function legacyHistoryPath(repoName: string): string {
  return join(repoDataDir(repoName), "run-history.jsonl");
}

describe("run history — state.db persistence", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-run-history-domain-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
  });

  test("an untouched repo has no history", () => {
    expect(readRunHistory("repo-a")).toEqual([]);
  });

  test("append persists and read round-trips, newest first", () => {
    appendRunHistory("repo-a", entry({ cmd: "first" }));
    appendRunHistory("repo-a", entry({ cmd: "second" }));
    expect(readRunHistory("repo-a").map((e) => e.cmd)).toEqual(["second", "first"]);
  });

  test("history for one repo does not leak into another repo's list", () => {
    appendRunHistory("repo-a", entry());
    expect(readRunHistory("repo-b")).toEqual([]);
  });

  test("a stale on-disk run-history.jsonl is ignored once the store owns the value, and gets unlinked on write", () => {
    const path = legacyHistoryPath("repo-c");
    mkdirSync(join(rtDir(), "repos", "repo-c"), { recursive: true });
    writeFileSync(path, JSON.stringify(entry({ cmd: "stale" })) + "\n");
    expect(existsSync(path)).toBe(true);

    // The store, not the stale file, is authoritative — nothing written yet.
    expect(readRunHistory("repo-c")).toEqual([]);

    appendRunHistory("repo-c", entry({ cmd: "fresh" }));
    expect(readRunHistory("repo-c").map((e) => e.cmd)).toEqual(["fresh"]);
    expect(existsSync(path)).toBe(false);
  });
});
