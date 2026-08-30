import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb } from "../../state/index.ts";
import { loadRegistry, registryEpoch, saveRegistry, type TreeRecord } from "../registry.ts";
import { patchTree } from "../patch.ts";

const rec = (over: Partial<TreeRecord>): TreeRecord => ({
  name: "bellatrix",
  path: "/tmp/x",
  kind: "ephemeral",
  state: "on-deck",
  branch: "on-deck/bellatrix",
  createdAt: new Date(0).toISOString(),
  ...over,
});

describe("patchTree", () => {
  beforeEach(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "rtpatch-"));
    closeStateDb();
  });

  test("mutates the matching row and persists it", () => {
    saveRegistry("r", [rec({})]);
    const ok = patchTree("r", "/tmp/x", (r) => {
      r.state = "claimed";
      r.owner = "matt";
    });
    expect(ok).toBe(true);
    expect(loadRegistry("r")[0]).toMatchObject({ state: "claimed", owner: "matt" });
  });

  test("landing the write bumps the shared registry epoch (the guard other callers rely on)", () => {
    saveRegistry("r", [rec({})]);
    const before = registryEpoch("r");
    patchTree("r", "/tmp/x", (r) => { r.state = "claimed"; });
    expect(registryEpoch("r")).toBe(before + 1);
  });

  test("no row at that path: returns false, writes nothing, epoch does not move", () => {
    saveRegistry("r", [rec({})]);
    const before = registryEpoch("r");
    const ok = patchTree("r", "/no/such/path", (r) => { r.state = "claimed"; });
    expect(ok).toBe(false);
    expect(loadRegistry("r")).toEqual([rec({})]);
    expect(registryEpoch("r")).toBe(before);
  });

  test("leaves sibling rows in the same repo untouched", () => {
    saveRegistry("r", [rec({}), rec({ name: "dobby", path: "/tmp/y" })]);
    patchTree("r", "/tmp/x", (r) => { r.state = "disposable"; });
    const trees = loadRegistry("r");
    expect(trees.find((t) => t.path === "/tmp/y")).toMatchObject({ state: "on-deck" });
  });
});
