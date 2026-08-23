/**
 * lib/run-history.ts — thin domain wrapper over lib/state/run-history-store.ts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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

  test("a pre-existing run-history.jsonl is imported on first read, oldest-first so newest survives trimming", () => {
    const path = legacyHistoryPath("repo-c");
    mkdirSync(join(rtDir(), "repos", "repo-c"), { recursive: true });
    const lines = [entry({ cmd: "old" }), entry({ cmd: "newer" })].map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, lines);
    expect(existsSync(path)).toBe(true);

    expect(readRunHistory("repo-c").map((e) => e.cmd)).toEqual(["newer", "old"]); // newest-first read
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);

    // A later append still lands on top, and a re-read does not re-import.
    appendRunHistory("repo-c", entry({ cmd: "fresh" }));
    expect(readRunHistory("repo-c").map((e) => e.cmd)).toEqual(["fresh", "newer", "old"]);
  });

  test("a run-history.jsonl with an unparseable line skips just that line, keeps the rest, and still migrates", () => {
    const path = legacyHistoryPath("repo-d");
    mkdirSync(join(rtDir(), "repos", "repo-d"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(entry({ cmd: "good" }))}\nnot json at all\n`);

    expect(readRunHistory("repo-d").map((e) => e.cmd)).toEqual(["good"]);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);
  });

  test("a run-history.jsonl with no parseable entries at all warns and is left in place", () => {
    const path = legacyHistoryPath("repo-e");
    mkdirSync(join(rtDir(), "repos", "repo-e"), { recursive: true });
    writeFileSync(path, "not json\nalso not json\n");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect(readRunHistory("repo-e")).toEqual([]);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.migrated`)).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("appendRunHistory is best-effort: a persistence failure warns rather than throwing", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Force the store write to fail outright (not just SQLITE_BUSY, which
      // persistOrWarn already swallows) — closeStateDb() then a directory at
      // state.db's path makes the next getStateDb() call throw on open.
      closeStateDb();
      mkdirSync(join(rtDir(), "state.db"), { recursive: true });

      expect(() => appendRunHistory("repo-f", entry())).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
