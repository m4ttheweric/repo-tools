/**
 * ProcessManager — spawns and manages processes via Bun.Terminal (PTY).
 *
 * Each process gets a PTY so interactive CLI tools work correctly.
 * Output is streamed to LogBuffer; state transitions go through StateStore.
 * AttachServer is notified so clients can connect to the PTY over a Unix socket.
 *
 * Stored spawn configs enable respawn (restart with identical args/env).
 *
 * Also exposes subscribeToOutput(id, cb) for AttachServer to receive live PTY
 * output chunks for broadcasting to attached socket clients.
 */

import type { StateStore } from "./state-store.ts";
import type { LogBuffer } from "./log-buffer.ts";
import type { AttachServer } from "./attach-server.ts";

export interface SpawnConfig {
  cmd: string;
  cwd: string;
  env?: Record<string, string>;
}

interface ManagedProcess {
  proc: ReturnType<typeof Bun.spawn>;
  terminal: ReturnType<typeof Bun.Terminal>;
  config: SpawnConfig;
}

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private spawnConfigs = new Map<string, SpawnConfig>();
  private stateStore: StateStore;
  private logBuffer: LogBuffer;
  private attachServer: AttachServer;
  /** Full user PATH resolved once at daemon startup from a login+interactive shell. */
  userPath: string | undefined;

  /** Per-process set of live output subscribers (registered by AttachServer). */
  private outputHooks = new Map<string, Set<(chunk: Uint8Array) => void>>();

  /** Injected after construction to break circular dep: SuspendManager → ProcessManager. */
  suspendManager?: { resume(id: string): Promise<void> };

  constructor(deps: { stateStore: StateStore; logBuffer: LogBuffer; attachServer: AttachServer }) {
    this.stateStore = deps.stateStore;
    this.logBuffer = deps.logBuffer;
    this.attachServer = deps.attachServer;
  }

  /**
   * Subscribe to live PTY output for a process.
   * Returns an unsubscribe function. Used by AttachServer per socket client.
   */
  subscribeToOutput(id: string, cb: (chunk: Uint8Array) => void): () => void {
    if (!this.outputHooks.has(id)) this.outputHooks.set(id, new Set());
    this.outputHooks.get(id)!.add(cb);
    return () => this.outputHooks.get(id)?.delete(cb);
  }

  async spawn(id: string, cmd: string, opts: { cwd: string; env?: Record<string, string> }): Promise<void> {
    // Signal to pollers that a spawn is in progress
    this.stateStore.setState(id, "starting");

    // Clear previous output so attach clients don't see stale log from last run
    this.logBuffer.clear(id);

    // Close any existing attach socket before opening a new one
    this.attachServer.close(id);

    // Kill the previous process for this ID if still running
    const existing = this.processes.get(id);
    if (existing) {
      try { existing.proc.kill("SIGKILL"); } catch { /* ignore */ }
      this.processes.delete(id);
    }

    // Evict any process currently holding PORT (handles TIME_WAIT / stuck processes)
    const portEnv = opts.env?.PORT;
    if (portEnv) {
      try {
        const lsof = Bun.spawnSync(["sh", "-c", `lsof -ti :${portEnv}`]);
        const pids = new TextDecoder().decode(lsof.stdout).trim().split("\n").filter(Boolean);
        for (const pid of pids) {
          try { process.kill(Number(pid), 9); } catch { /* already dead */ }
        }
        if (pids.length > 0) {
          await new Promise<void>((r) => setTimeout(r, 150));
        }
      } catch { /* best-effort */ }
    }

    // Save config for respawn before spawning
    const config: SpawnConfig = { cmd, cwd: opts.cwd, env: opts.env };
    this.spawnConfigs.set(id, config);

    // Capture references for the data closure
    const logBuffer = this.logBuffer;
    const outputHooks = this.outputHooks;

    const terminal = new Bun.Terminal({
      cols: 220,
      rows: 50,
      data(_term: ReturnType<typeof Bun.Terminal>, chunk: Uint8Array) {
        logBuffer.append(id, chunk);
        const hooks = outputHooks.get(id);
        if (hooks) {
          for (const hook of hooks) {
            try { hook(chunk); } catch { /* subscriber may have disconnected */ }
          }
        }
      },
    });

    const pathEnv = this.userPath ? { PATH: this.userPath } : {};
    const mergedEnv = { ...process.env, ...pathEnv, ...opts.env } as Record<string, string>;

    const proc = Bun.spawn(["bash", "-c", cmd], {
      terminal,
      cwd: opts.cwd,
      env: mergedEnv,
    });

    const managed: ManagedProcess = { proc, terminal, config };
    this.processes.set(id, managed);

    this.stateStore.setState(id, "running");

    // Open attach socket so `rt attach` clients can connect
    this.attachServer.open(id, terminal);

    // Handle process exit
    void proc.exited.then((exitCode) => {
      this.processes.delete(id);
      const state = exitCode === 0 ? "stopped" : "crashed";
      this.stateStore.setState(id, state);
      // Attach socket intentionally NOT closed on crash — user can still read error output.
      // It will be closed at the top of the next spawn() call for this id.
    });
  }

  async kill(id: string): Promise<void> {
    const managed = this.processes.get(id);
    if (!managed) {
      this.stateStore.setState(id, "stopped");
      return;
    }

    // Capture previous state before transitioning — needed for the warm-resume check below.
    const prevState = this.stateStore.getState(id);

    // Signal to pollers that a kill is in progress
    this.stateStore.setState(id, "stopping");

    // If warm (suspended), resume first so SIGTERM is delivered
    if (prevState === "warm" && this.suspendManager) {
      await this.suspendManager.resume(id);
    }

    try { managed.proc.kill("SIGTERM"); } catch { /* ignore */ }

    // Fallback SIGKILL after 5 seconds
    const killTimeout = setTimeout(() => {
      try { managed.proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, 5000);

    await managed.proc.exited;
    clearTimeout(killTimeout);

    this.processes.delete(id);
    this.stateStore.setState(id, "stopped");

    // Close attach socket on explicit kill (unlike crash, where we leave it open)
    this.attachServer.close(id);
  }

  async respawn(id: string): Promise<void> {
    const config = this.spawnConfigs.get(id);
    if (!config) throw new Error(`ProcessManager: no spawn config for id "${id}"`);
    await this.spawn(id, config.cmd, { cwd: config.cwd, env: config.env });
  }

  getTerminal(id: string): ReturnType<typeof Bun.Terminal> | undefined {
    return this.processes.get(id)?.terminal;
  }

  /** Return the underlying Bun process for a given id (needed by SuspendManager). */
  getProcess(id: string): ReturnType<typeof Bun.spawn> | undefined {
    return this.processes.get(id)?.proc;
  }

  list(): { id: string; config: SpawnConfig }[] {
    return Array.from(this.spawnConfigs.entries()).map(([id, config]) => ({ id, config }));
  }

  /** Remove all record of a process. Does not kill the running process. */
  remove(id: string): void {
    this.processes.delete(id);
    this.spawnConfigs.delete(id);
    this.outputHooks.delete(id);
  }
}
