/**
 * lib/run-history.ts — thin domain wrapper over lib/state/run-history-store.ts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repoDataDir, rtDir } from "../rt-paths.ts";
import { closeStateDb, getStateDb } from "../state/index.ts";
import { appendRunHistory, readRunHistory, rekeyRunHistoryTable, type RunHistoryEntry } from "../run-history.ts";

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

  test("run history is written and read under the repo identity", () => {
    const identity = "remote:gitlab.com%2Fg%2Fr";
    appendRunHistory(identity, entry({ cmd: "bun test" }));
    expect(readRunHistory(identity).map((e) => e.cmd)).toContain("bun test");
  });

  test("rekeyRunHistoryTable targets run_history.repo — an already-identity row is left alone, an unindexed legacy name is retained (never dropped)", async () => {
    appendRunHistory("legacy-repo", entry({ cmd: "legacy" }));
    appendRunHistory("remote:gitlab.com%2Fg%2Fr", entry({ cmd: "already-keyed" }));

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let report: Awaited<ReturnType<typeof rekeyRunHistoryTable>>;
    try {
      report = await rekeyRunHistoryTable();
    } finally {
      warnSpy.mockRestore();
    }

    // "legacy-repo" has no repo-index entry in this test HOME, so the
    // real resolver can't derive an identity for it — retained, not lost.
    expect(report.retained).toEqual(["legacy-repo"]);
    expect(readRunHistory("legacy-repo").map((e) => e.cmd)).toEqual(["legacy"]);
    expect(readRunHistory("remote:gitlab.com%2Fg%2Fr").map((e) => e.cmd)).toEqual(["already-keyed"]);
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

  test("appendRunHistory reached WITHOUT a prior read (the single-script rt run early-return path) still imports pre-existing history instead of stranding it", () => {
    const path = legacyHistoryPath("repo-g");
    mkdirSync(join(rtDir(), "repos", "repo-g"), { recursive: true });
    const lines = [entry({ cmd: "pre-upgrade-1" }), entry({ cmd: "pre-upgrade-2" })].map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, lines);

    // No readRunHistory("repo-g") call before this — commands/run.ts's
    // single-script early return hits appendRunHistory directly.
    appendRunHistory("repo-g", entry({ cmd: "fresh" }));

    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);
    expect(readRunHistory("repo-g").map((e) => e.cmd)).toEqual(["fresh", "pre-upgrade-2", "pre-upgrade-1"]);
  });

  test("real contended write: a held write lock during appendRunHistory's legacy import must NOT rename run-history.jsonl", () => {
    // Materialize AND KEEP OPEN state.db's singleton (see the equivalent
    // worktree registry test for why closeStateDb() here would make the
    // wrong thing fail — the migration's own BEGIN IMMEDIATE, not the
    // plain insert this test targets).
    getStateDb();
    const dbPath = join(rtDir(), "state.db");

    const path = legacyHistoryPath("repo-h");
    mkdirSync(join(rtDir(), "repos", "repo-h"), { recursive: true });
    writeFileSync(path, JSON.stringify(entry({ cmd: "held-back" })) + "\n");

    const blocker = new Database(dbPath);
    blocker.exec("PRAGMA busy_timeout = 0;");
    blocker.exec("BEGIN IMMEDIATE;");

    try {
      expect(() => appendRunHistory("repo-h", entry({ cmd: "new-during-contention" }))).not.toThrow();
    } finally {
      blocker.exec("ROLLBACK;");
      blocker.close();
    }

    // Both the legacy import's insert AND this call's own append were
    // swallowed by the same held lock — nothing may be destroyed.
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.migrated`)).toBe(false);

    // A retry once the lock is released recovers everything.
    appendRunHistory("repo-h", entry({ cmd: "new-after-release" }));
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);
    expect(readRunHistory("repo-h").map((e) => e.cmd)).toEqual(["new-after-release", "held-back"]);
  }, 20_000);

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
