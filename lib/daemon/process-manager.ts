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

/**
 * Evict any process currently bound to `port`. Covers the TIME_WAIT / stuck
 * process case where the previous tenant hasn't released the socket yet.
 * Runs lsof asynchronously so it doesn't block the daemon event loop, and
 * gives the kernel a 150ms grace window before returning so the next bind
 * has a better chance of succeeding.
 */
async function evictPort(port: string): Promise<void> {
  try {
    const proc = Bun.spawn(["sh", "-c", `lsof -ti :${port}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const pids = stdout.trim().split("\n").filter(Boolean);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try { process.kill(Number(pid), 9); } catch { /* already dead */ }
    }
    await new Promise<void>((r) => setTimeout(r, 150));
  } catch { /* best-effort */ }
}

/**
 * Signal an entire process group. Children are spawned with `detached: true`
 * so each spawn is its own pgroup leader (pgid == pid). Signalling `-pid`
 * delivers to every process in the group — the immediate child plus any
 * transitive descendants that haven't changed their pgid.
 *
 * Guards:
 *   - refuses pid 0/1 (would hit our own pgroup or init)
 *   - swallows ESRCH (group already empty — normal race with process exit)
 */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch (err: any) {
    if (err?.code !== "ESRCH") {
      // Any other error (EPERM, EINVAL) is unexpected — surface it via throw
      // so callers see it in the daemon log rather than silently swallowing.
      throw err;
    }
  }
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
    return () => {
      const set = this.outputHooks.get(id);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) this.outputHooks.delete(id);
    };
  }

  /**
   * Inject synthetic text into a process's output stream as if it had come
   * from the PTY. Appends to the log buffer (visible to future attach clients
   * on replay) and fans out to live outputHooks (visible to currently attached
   * clients). Used by the RemedyEngine to surface remedy activity in-band so
   * the user can see it in `rt attach`.
   *
   * Fanout is deferred via queueMicrotask so that if emitNotice is called from
   * inside an outputHook (RemedyEngine's handleChunk matches on a PTY chunk
   * and synthesizes a banner), the originating chunk still reaches
   * later-subscribed hooks (AttachServer) BEFORE the banner. Without the
   * defer, the banner overtakes the triggering line in the live socket
   * stream, so you see the match announcement appear before the error line
   * that actually triggered it.
   */
  emitNotice(id: string, text: string): void {
    const chunk = new TextEncoder().encode(text);
    this.logBuffer.append(id, chunk);
    queueMicrotask(() => {
      const hooks = this.outputHooks.get(id);
      if (!hooks) return;
      for (const hook of hooks) {
        try { hook(chunk); } catch { /* subscriber may have disconnected */ }
      }
    });
  }

  async spawn(id: string, cmd: string, opts: { cwd: string; env?: Record<string, string> }): Promise<void> {
    // Signal to pollers that a spawn is in progress
    this.stateStore.setState(id, "starting");

    // Clear previous output so attach clients don't see stale log from last run
    this.logBuffer.clear(id);

    // Close any existing attach socket before opening a new one
    this.attachServer.close(id);

    // Kill the previous process for this ID if still running.
    // Signal the whole pgroup so any grandchildren go with it.
    const existing = this.processes.get(id);
    if (existing) {
      killGroup(existing.proc.pid, "SIGKILL");
      this.processes.delete(id);
    }

    // Evict anything still holding the target PORT before we try to bind it.
    if (opts.env?.PORT) await evictPort(opts.env.PORT);

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
      // Put the child in its own session/pgroup so kill() can reap
      // grandchildren (vite → esbuild worker, etc.) via process.kill(-pid).
      // Without this, the child inherits the daemon's pgroup and signalling
      // -pid either errors (ESRCH) or targets the daemon itself.
      detached: true,
    });

    const managed: ManagedProcess = { proc, terminal, config };
    this.processes.set(id, managed);

    // Record pid BEFORE marking running so reconcileAfterRestart can find
    // orphaned warm processes if we crash between spawn and exit.
    this.stateStore.setPid(id, proc.pid);
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

    // Signal the whole pgroup, not just the immediate child — otherwise
    // grandchildren (webpack/vite workers spawned by the user's dev command)
    // survive as orphans reparented to pid 1 and keep holding their ports.
    killGroup(managed.proc.pid, "SIGTERM");

    // Fallback SIGKILL after 5 seconds — also pgroup-scoped.
    const killTimeout = setTimeout(() => {
      killGroup(managed.proc.pid, "SIGKILL");
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

  /** Return the stored spawn config for `id`, if any. */
  getSpawnConfig(id: string): SpawnConfig | undefined {
    return this.spawnConfigs.get(id);
  }

  /** Remove all record of a process. Does not kill the running process. */
  remove(id: string): void {
    this.processes.delete(id);
    this.spawnConfigs.delete(id);
    this.outputHooks.delete(id);
  }
}
