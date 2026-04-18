/**
 * RemedyEngine lifecycle-invariant tests.
 *
 * The engine's header comment claims five safety properties:
 *   1. Hook accumulation   — unsub() is called in onSpawn() before re-subscribing
 *   2. Orphan on removal   — cancelled blocks respawn after unregister()
 *   3. Concurrent triggers — inFlight + cooldown set synchronously before await
 *   4. Hung fix command    — 60s timeout + SIGKILL per command (not unit-tested here
 *                             because it would make the test suite slow; verified
 *                             by inspection)
 *   5. Double-respawn      — stateStore check before calling respawn()
 *
 * These tests use a fake ProcessManager that captures subscribe/respawn calls
 * and can emit chunks synchronously. No real PTY is spawned — unit-speed.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RemedyEngine } from "../remedy-engine.ts";
import { StateStore } from "../state-store.ts";
import type { Remedy, GlobalRemedy } from "../../runner-store.ts";

interface Sub { id: string; cb: (chunk: Uint8Array) => void; active: boolean }

/** Minimal ProcessManager stub — just enough for RemedyEngine to hook into. */
class FakeProcessManager {
  subs: Sub[] = [];
  respawned: string[] = [];
  subscribeToOutput(id: string, cb: (chunk: Uint8Array) => void): () => void {
    const entry: Sub = { id, cb, active: true };
    this.subs.push(entry);
    return () => { entry.active = false; };
  }
  async respawn(id: string): Promise<void> { this.respawned.push(id); }
  /** Count of currently-active subscriptions for a given id. */
  activeSubs(id: string): number {
    return this.subs.filter((s) => s.id === id && s.active).length;
  }
  /** Push a line (with trailing newline) to every active sub for id. */
  emitLine(id: string, line: string): void {
    const chunk = new TextEncoder().encode(line + "\n");
    for (const s of this.subs) if (s.id === id && s.active) s.cb(chunk);
  }
}

let dataDir: string;
let pm: FakeProcessManager;
let stateStore: StateStore;
let engine: RemedyEngine;
let fires: Array<{ id: string; name: string; ok: boolean }>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "rt-remedy-test-"));
  pm = new FakeProcessManager();
  stateStore = new StateStore(dataDir);
  fires = [];
  engine = new RemedyEngine({
    processManager: pm as any,
    stateStore,
    onFire: (id, remedy, ok) => fires.push({ id, name: remedy.name, ok }),
  });
});

function afterTest() {
  rmSync(dataDir, { recursive: true, force: true });
}

// ── Invariant 1: no hook accumulation across re-spawns ────────────────────────

describe("hook accumulation", () => {
  test("onSpawn called multiple times yields exactly one active subscription", () => {
    const remedy: Remedy = { name: "r", pattern: ["x"], cmds: ["true"] };
    engine.register("p1", [remedy], "/tmp", "cmd");
    engine.onSpawn("p1");
    engine.onSpawn("p1");
    engine.onSpawn("p1");
    expect(pm.activeSubs("p1")).toBe(1);
    afterTest();
  });

  test("unregister cancels the active subscription", () => {
    engine.register("p1", [{ name: "r", pattern: ["x"], cmds: ["true"] }], "/tmp", "cmd");
    engine.onSpawn("p1");
    expect(pm.activeSubs("p1")).toBe(1);
    engine.unregister("p1");
    expect(pm.activeSubs("p1")).toBe(0);
    afterTest();
  });
});

// ── Invariant 2: unregister blocks post-await respawn ─────────────────────────

describe("unregister mid-fix", () => {
  test("cancelled flag prevents respawn after unregister during fix", async () => {
    const remedy: Remedy = { name: "r", pattern: ["boom"], cmds: ["true"], thenRestart: true };
    engine.register("p1", [remedy], "/tmp", "cmd");
    engine.onSpawn("p1");
    stateStore.setState("p1", "running");

    pm.emitLine("p1", "boom");
    // Synchronously unregister before the fix's awaits resolve
    engine.unregister("p1");

    // Wait for the fix async chain to settle
    await new Promise((r) => setTimeout(r, 100));

    expect(pm.respawned).toEqual([]);
    afterTest();
  });
});

// ── Invariant 3: concurrent triggers — cooldown gates subsequent matches ──────

describe("cooldown gating", () => {
  test("second match within cooldown window does not fire", async () => {
    const remedy: Remedy = {
      name: "r",
      pattern: ["boom"],
      cmds: ["true"],
      thenRestart: false,
      cooldownMs: 10_000,
    };
    engine.register("p1", [remedy], "/tmp", "cmd");
    engine.onSpawn("p1");

    pm.emitLine("p1", "boom");
    await new Promise((r) => setTimeout(r, 80));
    pm.emitLine("p1", "boom");
    await new Promise((r) => setTimeout(r, 80));

    expect(fires.length).toBe(1);
    afterTest();
  });

  test("no double-fire while first fix is in flight", async () => {
    const remedy: Remedy = {
      name: "r",
      pattern: ["boom"],
      cmds: ["sleep 0.1"], // forces an await window
      thenRestart: false,
      cooldownMs: 0,
    };
    engine.register("p1", [remedy], "/tmp", "cmd");
    engine.onSpawn("p1");

    pm.emitLine("p1", "boom");
    pm.emitLine("p1", "boom");
    pm.emitLine("p1", "boom");
    await new Promise((r) => setTimeout(r, 300));

    expect(fires.length).toBe(1);
    afterTest();
  });
});

// ── Invariant 5: double-respawn guarded by stateStore ────────────────────────

describe("double-respawn guard", () => {
  test("respawn skipped when state is already 'starting'", async () => {
    const remedy: Remedy = {
      name: "r",
      pattern: ["boom"],
      cmds: ["true"],
      thenRestart: true,
      cooldownMs: 0,
    };
    engine.register("p1", [remedy], "/tmp", "cmd");
    engine.onSpawn("p1");

    stateStore.setState("p1", "running");
    stateStore.setState("p1", "starting"); // user-initiated transition
    pm.emitLine("p1", "boom");
    await new Promise((r) => setTimeout(r, 150));

    expect(pm.respawned).toEqual([]);
    afterTest();
  });

  test("respawn fires when state is 'running'", async () => {
    const remedy: Remedy = {
      name: "r",
      pattern: ["boom"],
      cmds: ["true"],
      thenRestart: true,
      cooldownMs: 0,
    };
    engine.register("p1", [remedy], "/tmp", "cmd");
    engine.onSpawn("p1");

    stateStore.setState("p1", "running");
    pm.emitLine("p1", "boom");
    await new Promise((r) => setTimeout(r, 150));

    expect(pm.respawned).toEqual(["p1"]);
    afterTest();
  });
});

// ── Pattern handling ──────────────────────────────────────────────────────────

describe("pattern matching", () => {
  test("array pattern — any entry fires (OR semantics)", async () => {
    const remedy: Remedy = {
      name: "r",
      pattern: ["nope", "boom"],
      cmds: ["true"],
      thenRestart: false,
      cooldownMs: 0,
    };
    engine.register("p1", [remedy], "/tmp", "cmd");
    engine.onSpawn("p1");

    pm.emitLine("p1", "nothing here");
    pm.emitLine("p1", "boom time");
    await new Promise((r) => setTimeout(r, 80));

    expect(fires.length).toBe(1);
    afterTest();
  });

  test("invalid regex in one pattern doesn't crash — other patterns still match", async () => {
    const remedy: Remedy = {
      name: "r",
      pattern: ["(unclosed", "boom"],
      cmds: ["true"],
      thenRestart: false,
      cooldownMs: 0,
    };
    engine.register("p1", [remedy], "/tmp", "cmd");
    engine.onSpawn("p1");

    pm.emitLine("p1", "boom!");
    await new Promise((r) => setTimeout(r, 80));

    expect(fires.length).toBe(1);
    afterTest();
  });

  test("ANSI escape codes are stripped before matching", async () => {
    const remedy: Remedy = {
      name: "r",
      pattern: ["^error: build failed$"],
      cmds: ["true"],
      thenRestart: false,
      cooldownMs: 0,
    };
    engine.register("p1", [remedy], "/tmp", "cmd");
    engine.onSpawn("p1");

    // red-wrapped "error: build failed"
    pm.emitLine("p1", "\x1B[31merror: build failed\x1B[0m");
    await new Promise((r) => setTimeout(r, 80));

    expect(fires.length).toBe(1);
    afterTest();
  });
});

// ── Global remedies ───────────────────────────────────────────────────────────

describe("global remedies", () => {
  test("global with cwdContains matches when substring present", async () => {
    const global: GlobalRemedy = {
      name: "g",
      pattern: ["boom"],
      cmds: ["true"],
      thenRestart: false,
      cooldownMs: 0,
      cwdContains: dataDir, // substring of a real path, guaranteed to match
    };
    engine.reloadGlobals([global]);
    engine.register("p1", [], dataDir, "pnpm start");
    engine.onSpawn("p1");
    pm.emitLine("p1", "boom");
    await new Promise((r) => setTimeout(r, 80));
    expect(fires.map((f) => f.name)).toEqual(["g"]);
    afterTest();
  });

  test("global with non-matching cwdContains does not fire", async () => {
    const global: GlobalRemedy = {
      name: "g",
      pattern: ["boom"],
      cmds: ["true"],
      thenRestart: false,
      cooldownMs: 0,
      cwdContains: "definitely-not-in-path",
    };
    engine.reloadGlobals([global]);
    engine.register("p1", [], dataDir, "pnpm start");
    engine.onSpawn("p1");
    pm.emitLine("p1", "boom");
    await new Promise((r) => setTimeout(r, 80));
    expect(fires).toEqual([]);
    afterTest();
  });

  test("reloadGlobals mid-flight re-merges active states", async () => {
    engine.register("p1", [], dataDir, "cmd");
    engine.onSpawn("p1");

    // No globals yet → no fire
    pm.emitLine("p1", "boom");
    await new Promise((r) => setTimeout(r, 50));
    expect(fires).toEqual([]);

    // Install a global, then emit again
    engine.reloadGlobals([{
      name: "g", pattern: ["boom"], cmds: ["true"],
      thenRestart: false, cooldownMs: 0,
    }]);
    pm.emitLine("p1", "boom");
    await new Promise((r) => setTimeout(r, 80));

    expect(fires.map((f) => f.name)).toEqual(["g"]);
    afterTest();
  });
});
