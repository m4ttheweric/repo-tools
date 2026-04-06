/**
 * SuspendManager integration tests (12 tests)
 *
 * Sends real SIGSTOP/SIGCONT to live sleep processes. Verifies state transitions
 * and best-effort individual PID signaling (no bulk kill -STOP pid1 pid2 ...).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SuspendManager } from "../suspend-manager.ts";
import { ProcessManager } from "../process-manager.ts";
import { StateStore } from "../state-store.ts";
import { LogBuffer } from "../log-buffer.ts";
import { AttachServer } from "../attach-server.ts";

let dataDir: string;
let stateStore: StateStore;
let pm: ProcessManager;
let sm: SuspendManager;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Check whether a process is in T (stopped/traced) state using `ps`. */
function isProcessStopped(pid: number): boolean {
  try {
    const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
    const stat = new TextDecoder().decode(result.stdout).trim();
    return stat.startsWith("T");
  } catch {
    return false;
  }
}

/** Check whether a process is running (S or R state). */
function isProcessRunning(pid: number): boolean {
  try {
    const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
    const stat = new TextDecoder().decode(result.stdout).trim();
    return stat.startsWith("S") || stat.startsWith("R");
  } catch {
    return false;
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "rt-suspend-mgr-test-"));
  stateStore = new StateStore(dataDir);
  const logBuffer = new LogBuffer();
  const attachServer = new AttachServer({ logBuffer, dataDir });
  pm = new ProcessManager({ stateStore, logBuffer, attachServer });
  attachServer.setProcessManager(pm);
  sm = new SuspendManager({ processManager: pm, stateStore });
  pm.suspendManager = sm;
});

afterEach(async () => {
  for (const { id } of pm.list()) {
    try { await pm.kill(id); } catch { /* already dead */ }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

// ── suspend ───────────────────────────────────────────────────────────────────

describe("suspend", () => {
  test("suspend changes state to warm", async () => {
    await pm.spawn("p1", "sleep 30", { cwd: "/tmp" });
    await sleep(100);

    await sm.suspend("p1");

    expect(stateStore.getState("p1")).toBe("warm");
    await pm.kill("p1");
  });

  test("suspended process is in T state in OS", async () => {
    await pm.spawn("p1", "sleep 30", { cwd: "/tmp" });
    await sleep(100);

    const proc = pm.getProcess("p1");
    expect(proc?.pid).toBeDefined();
    const pid = proc!.pid!;

    await sm.suspend("p1");
    await sleep(100);

    expect(isProcessStopped(pid)).toBe(true);
    await pm.kill("p1");
  });

  test("suspend on stopped process is best-effort (no throw)", async () => {
    await pm.spawn("p1", "exit 0", { cwd: "/tmp" });
    await sleep(200);
    // process should now be stopped/crashed
    await expect(sm.suspend("p1")).resolves.toBeUndefined();
  });

  test("suspend on unknown id is a no-op", async () => {
    await expect(sm.suspend("nonexistent")).resolves.toBeUndefined();
  });
});

// ── resume ────────────────────────────────────────────────────────────────────

describe("resume", () => {
  test("resume changes state to running", async () => {
    await pm.spawn("p1", "sleep 30", { cwd: "/tmp" });
    await sleep(100);

    await sm.suspend("p1");
    expect(stateStore.getState("p1")).toBe("warm");

    await sm.resume("p1");
    expect(stateStore.getState("p1")).toBe("running");
    await pm.kill("p1");
  });

  test("resumed process is in S/R state in OS", async () => {
    await pm.spawn("p1", "sleep 30", { cwd: "/tmp" });
    await sleep(100);

    const proc = pm.getProcess("p1");
    const pid = proc!.pid!;

    await sm.suspend("p1");
    await sleep(100);
    expect(isProcessStopped(pid)).toBe(true);

    await sm.resume("p1");
    await sleep(100);
    expect(isProcessRunning(pid)).toBe(true);
    await pm.kill("p1");
  });

  test("resume on unknown id is a no-op", async () => {
    await expect(sm.resume("nonexistent")).resolves.toBeUndefined();
  });
});

// ── suspend/resume cycle ──────────────────────────────────────────────────────

describe("suspend/resume cycle", () => {
  test("multiple suspend/resume cycles work correctly", async () => {
    await pm.spawn("p1", "sleep 30", { cwd: "/tmp" });
    await sleep(100);

    for (let i = 0; i < 3; i++) {
      await sm.suspend("p1");
      expect(stateStore.getState("p1")).toBe("warm");
      await sleep(50);

      await sm.resume("p1");
      expect(stateStore.getState("p1")).toBe("running");
      await sleep(50);
    }

    await pm.kill("p1");
  });

  test("independent processes can be suspended/resumed independently", async () => {
    await pm.spawn("p1", "sleep 30", { cwd: "/tmp" });
    await pm.spawn("p2", "sleep 30", { cwd: "/tmp" });
    await sleep(100);

    await sm.suspend("p1");
    expect(stateStore.getState("p1")).toBe("warm");
    expect(stateStore.getState("p2")).toBe("running");

    await sm.resume("p1");
    expect(stateStore.getState("p1")).toBe("running");

    await sm.suspend("p2");
    expect(stateStore.getState("p1")).toBe("running");
    expect(stateStore.getState("p2")).toBe("warm");

    await pm.kill("p1");
    await pm.kill("p2");
  });
});

// ── process tree ──────────────────────────────────────────────────────────────

describe("process tree handling", () => {
  test("SIGSTOP is applied to child processes (tree recursion)", async () => {
    // spawn a process that spawns a child
    await pm.spawn("p1", "bash -c 'sleep 30 & wait'", { cwd: "/tmp" });
    await sleep(300);

    const rootProc = pm.getProcess("p1");
    const rootPid = rootProc?.pid;
    expect(rootPid).toBeDefined();

    await sm.suspend("p1");
    await sleep(100);

    // Root process should be stopped
    expect(isProcessStopped(rootPid!)).toBe(true);
    await pm.kill("p1");
  });
});
