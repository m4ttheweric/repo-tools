import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { rtDir } from "../../rt-paths.ts";
import { closeStateDb, getStateDb, hasKvValue, setKvValue } from "../../state/index.ts";
import {
  loadRegistry,
  registryEpoch,
  saveRegistry,
  findByBranch,
  registryPath,
  usedNames,
  type TreeRecord,
} from "../registry.ts";

const rec = (over: Partial<TreeRecord>): TreeRecord => ({
  name: "bellatrix",
  path: "/tmp/x",
  kind: "ephemeral",
  state: "on-deck",
  branch: "on-deck/bellatrix",
  createdAt: new Date(0).toISOString(),
  ...over,
});

describe("worktree registry", () => {
  beforeEach(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "rtreg-"));
    closeStateDb();
  });
  test("empty loads []", () => expect(loadRegistry("r")).toEqual([]));
  test("round-trip", () => {
    saveRegistry("r", [rec({})]);
    expect(loadRegistry("r")[0]!.name).toBe("bellatrix");
  });
  test("findByBranch returns all matches", () => {
    const trees = [
      rec({ path: "/a", branch: "x" }),
      rec({ name: "dobby", path: "/b", branch: "x" }),
    ];
    expect(findByBranch(trees, "x").length).toBe(2);
  });
  test("usedNames includes creating", () => {
    expect(usedNames([rec({ state: "creating" })]).has("bellatrix")).toBe(true);
  });
  test("registryEpoch bumps on every save, per repo", () => {
    const before = registryEpoch("r");
    const otherBefore = registryEpoch("other");

    saveRegistry("r", [rec({})]);
    expect(registryEpoch("r")).toBe(before + 1);

    saveRegistry("r", [rec({ name: "dobby" })]);
    expect(registryEpoch("r")).toBe(before + 2);

    // A write to one repo never disturbs another repo's epoch.
    expect(registryEpoch("other")).toBe(otherBefore);
  });
  test("a malformed stored value ({}) loads as []", () => {
    setKvValue("worktree-registry", "r", {});
    expect(loadRegistry("r")).toEqual([]);
  });
  test("a malformed stored value (null) loads as []", () => {
    setKvValue("worktree-registry", "r", null);
    expect(loadRegistry("r")).toEqual([]);
  });
  test("a pre-existing worktrees.json is imported on first read, including fields no git repo records", () => {
    const path = registryPath("r");
    mkdirSync(dirname(path), { recursive: true });
    const legacyTree = rec({
      name: "claimed-tree",
      kind: "ephemeral",
      state: "claimed",
      owner: "matt",
      disposal: "merge",
      claimedAt: "2026-08-20T00:00:00Z",
      readyStamp: "abc123",
      retryFailures: 2,
    });
    writeFileSync(path, JSON.stringify({ trees: [legacyTree] }));
    expect(existsSync(path)).toBe(true);

    expect(loadRegistry("r")).toEqual([legacyTree]);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);

    // A second read sees the store, not a re-import.
    expect(loadRegistry("r")).toEqual([legacyTree]);
  });

  test("a corrupt worktrees.json warns and is left in place; loadRegistry reads as empty", () => {
    const path = registryPath("corrupt-r");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not valid json");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect(loadRegistry("corrupt-r")).toEqual([]);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.migrated`)).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("saveRegistry renames (never deletes) a legacy worktrees.json it supersedes", () => {
    const path = registryPath("r");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ trees: [rec({ name: "stale-tree" })] }));

    saveRegistry("r", [rec({ name: "fresh-tree" })]);
    expect(loadRegistry("r").map((t) => t.name)).toEqual(["fresh-tree"]);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);
  });

  test("real contended write (reviewer's repro): a held write lock during loadRegistry's import must NOT rename worktrees.json — the next read must still see it and retry", () => {
    // Materialize AND KEEP OPEN state.db's singleton first (never
    // closeStateDb() here): loadRegistry's own getStateDb() call must reuse
    // this already-migrated connection during the lock window below, or its
    // own open+migrate BEGIN IMMEDIATE would contend with the lock too and
    // throw past MIGRATION_BUSY_TIMEOUT_MS instead of the plain write
    // hitting persistOrWarn's swallow — a different failure than the one
    // this test targets.
    getStateDb();
    const dbPath = join(rtDir(), "state.db");

    const path = registryPath("r");
    mkdirSync(dirname(path), { recursive: true });
    const legacyTree = rec({ name: "claimed-tree", kind: "ephemeral", state: "claimed", owner: "matt" });
    writeFileSync(path, JSON.stringify({ trees: [legacyTree] }));

    // A second, real connection holds the write lock past loadRegistry's
    // (cli-flavor, 5000ms) busy_timeout — a genuine SQLITE_BUSY, not a mock.
    const blocker = new Database(dbPath);
    blocker.exec("PRAGMA busy_timeout = 0;");
    blocker.exec("BEGIN IMMEDIATE;");

    let trees: TreeRecord[];
    try {
      trees = loadRegistry("r");
    } finally {
      blocker.exec("ROLLBACK;");
      blocker.close();
    }

    // This caller still gets the correctly-parsed trees (apply() did run)...
    expect(trees.map((t) => t.name)).toEqual(["claimed-tree"]);
    // ...but the write never landed, so nothing may be destroyed: the file
    // must survive, and the store must still be empty for this repo.
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.migrated`)).toBe(false);
    expect(hasKvValue("worktree-registry", "r")).toBe(false);

    // The next read (lock released) succeeds for real and renames.
    expect(loadRegistry("r").map((t) => t.name)).toEqual(["claimed-tree"]);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);
  }, 20_000);
});
