import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { closeStateDb, setKvValue } from "../../state/index.ts";
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
});
