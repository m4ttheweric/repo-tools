import { describe, test, expect, beforeEach } from "bun:test";
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
  test("a stale on-disk worktrees.json is ignored once the store owns the value, and gets unlinked on write", () => {
    const path = registryPath("r");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ trees: [rec({ name: "stale-tree" })] }));
    expect(existsSync(path)).toBe(true);

    // The store, not the stale file, is authoritative — nothing written yet.
    expect(loadRegistry("r")).toEqual([]);

    saveRegistry("r", [rec({ name: "fresh-tree" })]);
    expect(loadRegistry("r").map((t) => t.name)).toEqual(["fresh-tree"]);
    expect(existsSync(path)).toBe(false);
  });
});
