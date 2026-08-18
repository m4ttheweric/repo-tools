import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  loadRegistry,
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
  test("malformed registry file ({}) loads as []", () => {
    const path = registryPath("r");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}");
    expect(loadRegistry("r")).toEqual([]);
  });
  test("malformed registry file ({\"trees\": null}) loads as []", () => {
    const path = registryPath("r");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ trees: null }));
    expect(loadRegistry("r")).toEqual([]);
  });
});
