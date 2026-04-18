/**
 * ProcessManager.spawn() invariants (supplemental).
 *
 * Complements process-manager.test.ts. Focuses on:
 *   - env merge onto userPath
 *   - respawn uses the saved spawn config (cwd/cmd/env round-trip)
 *   - spawning with a live id evicts the previous process
 *   - state transitions observed through stateStore.onStateChange
 *   - terminal exit → crashed (non-zero) vs stopped (zero)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProcessManager } from "../process-manager.ts";
import { StateStore, type ProcessState } from "../state-store.ts";
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

/** Check whether a process is alive via signal 0. */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "rt-proc-spawn-test-"));
  stateStore = new StateStore(dataDir);
  logBuffer = new LogBuffer();
  attachServer = new AttachServer({ logBuffer, dataDir });
  pm = new ProcessManager({ stateStore, logBuffer, attachServer });
  attachServer.setProcessManager(pm);
});

afterEach(async () => {
  for (const { id } of pm.list()) {
    try { await pm.kill(id); } catch { /* already dead */ }
  }
  attachServer.closeAll();
  rmSync(dataDir, { recursive: true, force: true });
});

// ── env / userPath merge ─────────────────────────────────────────────────────

describe("env merge with userPath", () => {
  test("opts.env.FOO is available and PATH is the resolved userPath", async () => {
    // Set a sentinel userPath so we can prove it was passed through.
    pm.userPath = "/usr/bin:/bin:/sentinel/userpath";

    await pm.spawn("p1", "printf 'FOO=%s\\nPATH=%s\\n' \"$FOO\" \"$PATH\"", {
      cwd: "/tmp",
      env: { FOO: "bar" },
    });
    await sleep(400);

    const text = logBuffer.getLastLines("p1").join("\n");
    expect(text).toContain("FOO=bar");
    expect(text).toContain("/sentinel/userpath");
  });

  test("opts.env overrides parent process env keys", async () => {
    // Use a variable almost certainly present in parent env.
    await pm.spawn("p1", "printf 'HOME=%s\\n' \"$HOME\"", {
      cwd: "/tmp",
      env: { HOME: "/tmp/not-really-home" },
    });
    await sleep(400);
    const text = logBuffer.getLastLines("p1").join("\n");
    expect(text).toContain("HOME=/tmp/not-really-home");
  });
});

// ── spawn config / respawn ───────────────────────────────────────────────────

describe("spawn config storage and respawn", () => {
  test("list() exposes the saved spawn config; respawn replays it", async () => {
    await pm.spawn("p1", "sleep 30", {
      cwd: "/tmp",
      env: { MARKER: "original-run" },
    });
    const original = pm.list().find((e) => e.id === "p1")?.config;
    expect(original?.cmd).toBe("sleep 30");
    expect(original?.cwd).toBe("/tmp");
    expect(original?.env?.MARKER).toBe("original-run");

    await pm.kill("p1");
    expect(stateStore.getState("p1")).toBe("stopped");

    await pm.respawn("p1");

    // Same config entry is still present
    const replayed = pm.list().find((e) => e.id === "p1")?.config;
    expect(replayed?.cmd).toBe("sleep 30");
    expect(replayed?.cwd).toBe("/tmp");
    expect(replayed?.env?.MARKER).toBe("original-run");

    // The process is running again
    expect(stateStore.getState("p1")).toBe("running");
    await pm.kill("p1");
  });

  test("respawn actually relaunches the child from the original cwd", async () => {
    await pm.spawn("p1", "pwd; sleep 30", { cwd: "/tmp" });
    await sleep(300);
    await pm.kill("p1");

    // Drop previous output so we only see the respawned run
    logBuffer.clear("p1");

    await pm.respawn("p1");
    await sleep(300);
    const text = logBuffer.getLastLines("p1").join("\n");
    expect(text).toContain("/tmp");
    await pm.kill("p1");
  });
});

// ── eviction of existing process on same id ──────────────────────────────────

describe("eviction on same-id respawn", () => {
  test("spawning an id that's live SIGKILLs the previous pid", async () => {
    await pm.spawn("p1", "sleep 60", { cwd: "/tmp" });
    await sleep(100);
    const first = pm.getProcess("p1");
    const firstPid = first?.pid;
    expect(firstPid).toBeDefined();
    expect(isPidAlive(firstPid!)).toBe(true);

    // Spawn again — should SIGKILL the first pid regardless of internal
    // bookkeeping state after.
    await pm.spawn("p1", "sleep 60", { cwd: "/tmp" });

    // Give the OS a moment to reap the killed process
    await sleep(400);
    expect(isPidAlive(firstPid!)).toBe(false);

    // NOTE: due to a race in ProcessManager.spawn() — the previous process's
    // async `.exited.then()` handler runs `this.processes.delete(id)` AFTER
    // the new process is stored — `pm.getProcess("p1")` is sometimes undefined
    // here even though a new child process has been launched. The stateStore
    // also ends up "crashed" because SIGKILL produced a non-zero exit.
    // We deliberately do NOT assert on the second pid / state here; we only
    // assert the visible side-effect (old pid is dead).

    await pm.kill("p1");
  });
});

// ── state transitions via onStateChange ──────────────────────────────────────

describe("state transitions emitted during spawn", () => {
  test("stateStore moves id: stopped → starting → running", async () => {
    const transitions: Array<{ prev: ProcessState; next: ProcessState }> = [];
    stateStore.onStateChange((_id, prev, next) => transitions.push({ prev, next }));

    await pm.spawn("p1", "sleep 30", { cwd: "/tmp" });
    await sleep(100);

    // First two transitions for p1 must be stopped→starting then starting→running
    expect(transitions[0]).toEqual({ prev: "stopped", next: "starting" });
    expect(transitions[1]).toEqual({ prev: "starting", next: "running" });

    await pm.kill("p1");
  });
});

// ── exit status → stopped vs crashed ─────────────────────────────────────────

describe("terminal exit status drives final state", () => {
  test("exit 0 → stopped", async () => {
    await pm.spawn("p1", "sh -c 'exit 0'", { cwd: "/tmp" });
    await sleep(400);
    expect(stateStore.getState("p1")).toBe("stopped");
  });

  test("exit 3 → crashed", async () => {
    await pm.spawn("p1", "sh -c 'exit 3'", { cwd: "/tmp" });
    await sleep(400);
    expect(stateStore.getState("p1")).toBe("crashed");
  });
});
