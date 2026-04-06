/**
 * ExclusiveGroup unit tests (22 tests)
 *
 * Uses mock SuspendManager and StateStore to test the group logic in isolation.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExclusiveGroup } from "../exclusive-group.ts";
import type { SuspendManager } from "../suspend-manager.ts";
import type { StateStore, ProcessState } from "../state-store.ts";

let dataDir: string;

const makeMockSuspendManager = () => ({
  suspend: mock(async (_id: string) => {}),
  resume: mock(async (_id: string) => {}),
});

const makeMockStateStore = (states: Record<string, ProcessState> = {}) => ({
  getState: mock((id: string): ProcessState => states[id] ?? "stopped"),
  setState: mock((_id: string, _state: ProcessState) => {}),
  getAll: mock(() => ({ ...states })),
  onStateChange: mock(() => {}),
  reconcileAfterRestart: mock(() => {}),
  remove: mock((_id: string) => {}),
});

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "rt-excl-group-test-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ── create / remove ──────────────────────────────────────────────────────────

describe("create and remove", () => {
  test("create adds an empty group", () => {
    const eg = new ExclusiveGroup({
      suspendManager: makeMockSuspendManager() as unknown as SuspendManager,
      stateStore: makeMockStateStore() as unknown as StateStore,
      dataDir,
    });
    eg.create("g1");
    const group = eg.get("g1");
    expect(group).not.toBeNull();
    expect(group?.members).toEqual([]);
    expect(group?.active).toBeNull();
  });

  test("create is idempotent", () => {
    const eg = new ExclusiveGroup({
      suspendManager: makeMockSuspendManager() as unknown as SuspendManager,
      stateStore: makeMockStateStore() as unknown as StateStore,
      dataDir,
    });
    eg.create("g1");
    eg.addMember("g1", "p1");
    eg.create("g1"); // should not reset existing group
    expect(eg.get("g1")?.members).toEqual(["p1"]);
  });

  test("remove deletes a group", () => {
    const eg = new ExclusiveGroup({
      suspendManager: makeMockSuspendManager() as unknown as SuspendManager,
      stateStore: makeMockStateStore() as unknown as StateStore,
      dataDir,
    });
    eg.create("g1");
    eg.remove("g1");
    expect(eg.get("g1")).toBeNull();
  });

  test("remove non-existent group is no-op", () => {
    const eg = new ExclusiveGroup({
      suspendManager: makeMockSuspendManager() as unknown as SuspendManager,
      stateStore: makeMockStateStore() as unknown as StateStore,
      dataDir,
    });
    expect(() => eg.remove("nonexistent")).not.toThrow();
  });
});

// ── addMember / removeMember ─────────────────────────────────────────────────

describe("addMember and removeMember", () => {
  test("addMember adds a process to the group", () => {
    const eg = new ExclusiveGroup({
      suspendManager: makeMockSuspendManager() as unknown as SuspendManager,
      stateStore: makeMockStateStore() as unknown as StateStore,
      dataDir,
    });
    eg.create("g1");
    eg.addMember("g1", "p1");
    eg.addMember("g1", "p2");
    expect(eg.get("g1")?.members).toEqual(["p1", "p2"]);
  });

  test("addMember is idempotent (no duplicate)", () => {
    const eg = new ExclusiveGroup({
      suspendManager: makeMockSuspendManager() as unknown as SuspendManager,
      stateStore: makeMockStateStore() as unknown as StateStore,
      dataDir,
    });
    eg.create("g1");
    eg.addMember("g1", "p1");
    eg.addMember("g1", "p1");
    expect(eg.get("g1")?.members).toEqual(["p1"]);
  });

  test("removeMember removes the process", () => {
    const eg = new ExclusiveGroup({
      suspendManager: makeMockSuspendManager() as unknown as SuspendManager,
      stateStore: makeMockStateStore() as unknown as StateStore,
      dataDir,
    });
    eg.create("g1");
    eg.addMember("g1", "p1");
    eg.addMember("g1", "p2");
    eg.removeMember("g1", "p1");
    expect(eg.get("g1")?.members).toEqual(["p2"]);
  });

  test("removeMember clears active if removed process was active", () => {
    const sm = makeMockSuspendManager();
    const ss = makeMockStateStore({ p1: "warm" });
    const eg = new ExclusiveGroup({
      suspendManager: sm as unknown as SuspendManager,
      stateStore: ss as unknown as StateStore,
      dataDir,
    });
    eg.create("g1");
    eg.addMember("g1", "p1");
    // Manually set active via persistence trick: activate sets it
    // We'll use a fresh group with p1 as only member and activate it
    void eg.activate("g1", "p1");
    eg.removeMember("g1", "p1");
    expect(eg.get("g1")?.active).toBeNull();
  });

  test("addMember throws for unknown group", () => {
    const eg = new ExclusiveGroup({
      suspendManager: makeMockSuspendManager() as unknown as SuspendManager,
      stateStore: makeMockStateStore() as unknown as StateStore,
      dataDir,
    });
    expect(() => eg.addMember("nonexistent", "p1")).toThrow();
  });
});

// ── activate ─────────────────────────────────────────────────────────────────

describe("activate", () => {
  test("suspends other running members", async () => {
    const sm = makeMockSuspendManager();
    const ss = makeMockStateStore({ p1: "running", p2: "running" });
    const eg = new ExclusiveGroup({
      suspendManager: sm as unknown as SuspendManager,
      stateStore: ss as unknown as StateStore,
      dataDir,
    });
    eg.create("g1");
    eg.addMember("g1", "p1");
    eg.addMember("g1", "p2");

    await eg.activate("g1", "p1");

    // p2 should have been suspended (p1 is the one being activated)
    expect(sm.suspend).toHaveBeenCalledWith("p2");
    expect(sm.suspend).not.toHaveBeenCalledWith("p1");
  });

  test("resumes target process if it was warm", async () => {
    const sm = makeMockSuspendManager();
    const ss = makeMockStateStore({ p1: "warm", p2: "running" });
    const eg = new ExclusiveGroup({
      suspendManager: sm as unknown as SuspendManager,
      stateStore: ss as unknown as StateStore,
      dataDir,
    });
    eg.create("g1");
    eg.addMember("g1", "p1");
    eg.addMember("g1", "p2");

    await eg.activate("g1", "p1");

    expect(sm.resume).toHaveBeenCalledWith("p1");
  });

  test("does not resume target if not warm", async () => {
    const sm = makeMockSuspendManager();
    const ss = makeMockStateStore({ p1: "stopped", p2: "running" });
    const eg = new ExclusiveGroup({
      suspendManager: sm as unknown as SuspendManager,
      stateStore: ss as unknown as StateStore,
      dataDir,
    });
    eg.create("g1");
    eg.addMember("g1", "p1");
    eg.addMember("g1", "p2");

    await eg.activate("g1", "p1");

    expect(sm.resume).not.toHaveBeenCalled();
  });

  test("sets active after activation", async () => {
    const sm = makeMockSuspendManager();
    const ss = makeMockStateStore({ p1: "running" });
    const eg = new ExclusiveGroup({
      suspendManager: sm as unknown as SuspendManager,
      stateStore: ss as unknown as StateStore,
      dataDir,
    });
    eg.create("g1");
    eg.addMember("g1", "p1");

    await eg.activate("g1", "p1");

    expect(eg.getActive("g1")).toBe("p1");
  });

  test("throws for unknown group", async () => {
    const eg = new ExclusiveGroup({
      suspendManager: makeMockSuspendManager() as unknown as SuspendManager,
      stateStore: makeMockStateStore() as unknown as StateStore,
      dataDir,
    });
    await expect(eg.activate("nonexistent", "p1")).rejects.toThrow();
  });
});

// ── list ─────────────────────────────────────────────────────────────────────

describe("list", () => {
  test("returns all groups", () => {
    const eg = new ExclusiveGroup({
      suspendManager: makeMockSuspendManager() as unknown as SuspendManager,
      stateStore: makeMockStateStore() as unknown as StateStore,
      dataDir,
    });
    eg.create("g1");
    eg.create("g2");
    const groups = eg.list();
    expect(groups.map((g) => g.groupId).sort()).toEqual(["g1", "g2"]);
  });
});

// ── Persistence ──────────────────────────────────────────────────────────────

describe("persistence", () => {
  test("groups survive reinstantiation", () => {
    const sm = makeMockSuspendManager();
    const ss = makeMockStateStore();

    const eg1 = new ExclusiveGroup({
      suspendManager: sm as unknown as SuspendManager,
      stateStore: ss as unknown as StateStore,
      dataDir,
    });
    eg1.create("g1");
    eg1.addMember("g1", "p1");

    const eg2 = new ExclusiveGroup({
      suspendManager: sm as unknown as SuspendManager,
      stateStore: ss as unknown as StateStore,
      dataDir,
    });
    expect(eg2.get("g1")?.members).toEqual(["p1"]);
  });

  test("persist file is valid JSON", () => {
    const eg = new ExclusiveGroup({
      suspendManager: makeMockSuspendManager() as unknown as SuspendManager,
      stateStore: makeMockStateStore() as unknown as StateStore,
      dataDir,
    });
    eg.create("g1");
    const content = readFileSync(join(dataDir, "exclusive-groups.json"), "utf8");
    expect(() => JSON.parse(content)).not.toThrow();
  });
});
