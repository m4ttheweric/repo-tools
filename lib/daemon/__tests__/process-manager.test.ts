/**
 * ProcessManager integration tests (20 tests)
 *
 * Spawns real processes via Bun.Terminal PTYs. Tests verify output capture,
 * kill semantics, respawn, and state transitions.
 *
 * Note: These tests start real child processes and require a working PTY.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProcessManager } from "../process-manager.ts";
import { StateStore } from "../state-store.ts";
import { LogBuffer } from "../log-buffer.ts";
import { AttachServer } from "../attach-server.ts";

let dataDir: string;
let stateStore: StateStore;
let logBuffer: LogBuffer;
let attachServer: AttachServer;
let pm: ProcessManager;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "rt-proc-mgr-test-"));
  stateStore = new StateStore(dataDir);
  logBuffer = new LogBuffer();
  attachServer = new AttachServer({ logBuffer, dataDir });
  pm = new ProcessManager({ stateStore, logBuffer, attachServer });
  attachServer.setProcessManager(pm);
});

afterEach(async () => {
  // Best-effort cleanup: kill any lingering test processes
  for (const { id } of pm.list()) {
    try { await pm.kill(id); } catch { /* already dead */ }
  }
  attachServer.closeAll();
  rmSync(dataDir, { recursive: true, force: true });
});

// ── spawn / state ─────────────────────────────────────────────────────────────

describe("spawn and state", () => {
  test("state is running after spawn", async () => {
    await pm.spawn("p1", "sleep 10", { cwd: "/tmp" });
    expect(stateStore.getState("p1")).toBe("running");
    await pm.kill("p1");
  });

  test("state becomes stopped on clean exit", async () => {
    await pm.spawn("p1", "exit 0", { cwd: "/tmp" });
    await sleep(300);
    expect(stateStore.getState("p1")).toBe("stopped");
  });

  test("state becomes crashed on non-zero exit", async () => {
    await pm.spawn("p1", "exit 1", { cwd: "/tmp" });
    await sleep(300);
    expect(stateStore.getState("p1")).toBe("crashed");
  });

  test("spawn appears in list()", async () => {
    await pm.spawn("p1", "sleep 10", { cwd: "/tmp" });
    expect(pm.list().some((e) => e.id === "p1")).toBe(true);
    await pm.kill("p1");
  });
});

// ── output capture ────────────────────────────────────────────────────────────

describe("output capture", () => {
  test("stdout is captured in log buffer", async () => {
    await pm.spawn("p1", "echo 'hello from process'", { cwd: "/tmp" });
    await sleep(500);
    const lines = logBuffer.getLastLines("p1");
    expect(lines.some((l) => l.includes("hello from process"))).toBe(true);
  });

  test("multiple lines of output are captured", async () => {
    await pm.spawn("p1", "printf 'line1\\nline2\\nline3\\n'", { cwd: "/tmp" });
    await sleep(500);
    const lines = logBuffer.getLastLines("p1");
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  test("log buffer is cleared on respawn", async () => {
    await pm.spawn("p1", "echo 'first run'", { cwd: "/tmp" });
    await sleep(300);
    const firstLines = logBuffer.getLastLines("p1");
    expect(firstLines.some((l) => l.includes("first run"))).toBe(true);

    await pm.respawn("p1");
    // Immediately after respawn, old lines should be gone
    const freshLines = logBuffer.getLastLines("p1");
    expect(freshLines.some((l) => l.includes("first run"))).toBe(false);
    await pm.kill("p1");
  });

  test("subscribeToOutput receives live output", async () => {
    const received: string[] = [];
    const unsub = pm.subscribeToOutput("p1", (chunk) => {
      received.push(new TextDecoder().decode(chunk));
    });

    await pm.spawn("p1", "echo 'live output'", { cwd: "/tmp" });
    await sleep(500);
    unsub();

    expect(received.join("").includes("live output")).toBe(true);
  });
});

// ── kill ─────────────────────────────────────────────────────────────────────

describe("kill", () => {
  test("state is stopped after kill", async () => {
    await pm.spawn("p1", "sleep 30", { cwd: "/tmp" });
    await pm.kill("p1");
    expect(stateStore.getState("p1")).toBe("stopped");
  });

  test("kill on unknown id sets state to stopped (no throw)", async () => {
    await expect(pm.kill("nonexistent")).resolves.toBeUndefined();
    expect(stateStore.getState("nonexistent")).toBe("stopped");
  });

  test("second kill is idempotent", async () => {
    await pm.spawn("p1", "sleep 30", { cwd: "/tmp" });
    await pm.kill("p1");
    await expect(pm.kill("p1")).resolves.toBeUndefined();
  });
});

// ── respawn ───────────────────────────────────────────────────────────────────

describe("respawn", () => {
  test("respawn restarts a stopped process", async () => {
    await pm.spawn("p1", "sleep 30", { cwd: "/tmp" });
    await pm.kill("p1");
    expect(stateStore.getState("p1")).toBe("stopped");

    await pm.respawn("p1");
    expect(stateStore.getState("p1")).toBe("running");
    await pm.kill("p1");
  });

  test("respawn uses same config as original spawn", async () => {
    await pm.spawn("p1", "sleep 30", { cwd: "/tmp", env: { MY_VAR: "hello" } });
    const originalConfig = pm.list().find((e) => e.id === "p1")?.config;
    await pm.kill("p1");

    await pm.respawn("p1");
    const respawnedConfig = pm.list().find((e) => e.id === "p1")?.config;
    expect(respawnedConfig?.cmd).toBe(originalConfig?.cmd);
    expect(respawnedConfig?.env?.MY_VAR).toBe("hello");
    await pm.kill("p1");
  });

  test("respawn throws for unknown id", async () => {
    await expect(pm.respawn("nonexistent")).rejects.toThrow();
  });
});

// ── env / cwd ─────────────────────────────────────────────────────────────────

describe("environment and cwd", () => {
  test("environment variables are available to process", async () => {
    await pm.spawn("p1", "echo $MY_TEST_VAR", { cwd: "/tmp", env: { MY_TEST_VAR: "xyzzy" } });
    await sleep(500);
    const lines = logBuffer.getLastLines("p1");
    expect(lines.some((l) => l.includes("xyzzy"))).toBe(true);
  });

  test("cwd is set correctly", async () => {
    await pm.spawn("p1", "pwd", { cwd: "/tmp" });
    await sleep(500);
    const lines = logBuffer.getLastLines("p1");
    expect(lines.some((l) => l.includes("/tmp"))).toBe(true);
  });
});

// ── getProcess / getTerminal ──────────────────────────────────────────────────

describe("getProcess and getTerminal", () => {
  test("getProcess returns process object while running", async () => {
    await pm.spawn("p1", "sleep 10", { cwd: "/tmp" });
    const proc = pm.getProcess("p1");
    expect(proc).toBeDefined();
    expect(proc?.pid).toBeGreaterThan(0);
    await pm.kill("p1");
  });

  test("getProcess returns undefined for unknown id", () => {
    expect(pm.getProcess("nonexistent")).toBeUndefined();
  });

  test("getTerminal returns terminal object while running", async () => {
    await pm.spawn("p1", "sleep 10", { cwd: "/tmp" });
    const term = pm.getTerminal("p1");
    expect(term).toBeDefined();
    await pm.kill("p1");
  });
});
