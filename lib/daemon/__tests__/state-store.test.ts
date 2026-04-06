/**
 * StateStore unit tests (26 tests)
 *
 * All tests use mkdtempSync for isolation — they never touch real daemon state.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateStore, type ProcessState } from "../state-store.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "rt-state-store-test-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ── Initial state ────────────────────────────────────────────────────────────

describe("initial state", () => {
  test("unknown id returns stopped", () => {
    const store = new StateStore(dataDir);
    expect(store.getState("unknown")).toBe("stopped");
  });

  test("getAll returns empty object initially", () => {
    const store = new StateStore(dataDir);
    expect(store.getAll()).toEqual({});
  });
});

// ── Transitions ──────────────────────────────────────────────────────────────

describe("setState transitions", () => {
  test("stopped → running", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    expect(store.getState("p1")).toBe("running");
  });

  test("running → warm", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    store.setState("p1", "warm");
    expect(store.getState("p1")).toBe("warm");
  });

  test("running → crashed", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    store.setState("p1", "crashed");
    expect(store.getState("p1")).toBe("crashed");
  });

  test("running → stopped", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    store.setState("p1", "stopped");
    expect(store.getState("p1")).toBe("stopped");
  });

  test("warm → running (resume)", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    store.setState("p1", "warm");
    store.setState("p1", "running");
    expect(store.getState("p1")).toBe("running");
  });

  test("warm → stopped", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    store.setState("p1", "warm");
    store.setState("p1", "stopped");
    expect(store.getState("p1")).toBe("stopped");
  });

  test("crashed → running (respawn)", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    store.setState("p1", "crashed");
    store.setState("p1", "running");
    expect(store.getState("p1")).toBe("running");
  });

  test("no-op when setting same state", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    const calls: string[] = [];
    store.onStateChange((_id, _prev, next) => calls.push(next));
    store.setState("p1", "running"); // same state
    expect(calls).toHaveLength(0);
  });
});

// ── Listeners ────────────────────────────────────────────────────────────────

describe("onStateChange listener", () => {
  test("fires on transition", () => {
    const store = new StateStore(dataDir);
    const events: Array<{ id: string; prev: ProcessState; next: ProcessState }> = [];
    store.onStateChange((id, prev, next) => events.push({ id, prev, next }));
    store.setState("p1", "running");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ id: "p1", prev: "stopped", next: "running" });
  });

  test("fires for multiple processes independently", () => {
    const store = new StateStore(dataDir);
    const events: string[] = [];
    store.onStateChange((id) => events.push(id));
    store.setState("p1", "running");
    store.setState("p2", "running");
    expect(events).toEqual(["p1", "p2"]);
  });

  test("multiple listeners all receive the event", () => {
    const store = new StateStore(dataDir);
    let a = 0, b = 0;
    store.onStateChange(() => a++);
    store.onStateChange(() => b++);
    store.setState("p1", "running");
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  test("listener error does not prevent other listeners", () => {
    const store = new StateStore(dataDir);
    let called = false;
    store.onStateChange(() => { throw new Error("boom"); });
    store.onStateChange(() => { called = true; });
    store.setState("p1", "running"); // should not throw
    expect(called).toBe(true);
  });
});

// ── getAll / remove ──────────────────────────────────────────────────────────

describe("getAll and remove", () => {
  test("getAll returns all tracked states", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    store.setState("p2", "running");
    store.setState("p2", "warm");
    const all = store.getAll();
    expect(all["p1"]).toBe("running");
    expect(all["p2"]).toBe("warm");
  });

  test("remove deletes the entry", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    store.remove("p1");
    expect(store.getState("p1")).toBe("stopped");
    expect("p1" in store.getAll()).toBe(false);
  });

  test("remove is no-op for unknown id", () => {
    const store = new StateStore(dataDir);
    expect(() => store.remove("nonexistent")).not.toThrow();
  });
});

// ── reconcileAfterRestart ────────────────────────────────────────────────────

describe("reconcileAfterRestart", () => {
  test("resets running/warm/crashed to stopped", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    store.setState("p2", "running");
    store.setState("p2", "warm");
    store.setState("p3", "running");
    store.setState("p3", "crashed");
    store.reconcileAfterRestart();
    expect(store.getState("p1")).toBe("stopped");
    expect(store.getState("p2")).toBe("stopped");
    expect(store.getState("p3")).toBe("stopped");
  });

  test("does not affect already-stopped processes", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    store.setState("p1", "stopped");
    store.reconcileAfterRestart();
    expect(store.getState("p1")).toBe("stopped");
  });

  test("is idempotent", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    store.reconcileAfterRestart();
    store.reconcileAfterRestart();
    expect(store.getState("p1")).toBe("stopped");
  });
});

// ── Persistence ──────────────────────────────────────────────────────────────

describe("persistence", () => {
  test("state survives instantiation", () => {
    const store1 = new StateStore(dataDir);
    store1.setState("p1", "running");
    store1.setState("p1", "crashed");

    const store2 = new StateStore(dataDir);
    expect(store2.getState("p1")).toBe("crashed");
  });

  test("persist file is valid JSON", () => {
    const store = new StateStore(dataDir);
    store.setState("p1", "running");
    const content = readFileSync(join(dataDir, "process-states.json"), "utf8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  test("remove is persisted", () => {
    const store1 = new StateStore(dataDir);
    store1.setState("p1", "running");
    store1.remove("p1");

    const store2 = new StateStore(dataDir);
    expect(store2.getState("p1")).toBe("stopped");
  });

  test("handles missing file gracefully", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "rt-empty-"));
    try {
      const store = new StateStore(emptyDir);
      expect(store.getAll()).toEqual({});
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("handles corrupted file gracefully", () => {
    const { writeFileSync } = require("fs");
    writeFileSync(join(dataDir, "process-states.json"), "not json!!!");
    const store = new StateStore(dataDir);
    expect(store.getAll()).toEqual({});
  });
});
