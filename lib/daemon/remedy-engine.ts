/**
 * RemedyEngine — auto-detect error patterns in process output and execute fixes.
 *
 * Subscribes to live PTY output via ProcessManager.subscribeToOutput() for any
 * process that has remedies configured. When a log line matches a remedy's
 * pattern (after ANSI stripping), the engine runs the fix commands in the
 * entry's working directory and optionally restarts the process.
 *
 * Lifecycle safety:
 *   1. Hook accumulation:  unsub() called in onSpawn() before re-subscribing.
 *   2. Orphan on removal:  cancelled flag checked after every await.
 *   3. Concurrent triggers: inFlight + cooldown set synchronously before await.
 *   4. Hung fix command:   60s timeout + SIGKILL per command.
 *   5. Double-respawn:     stateStore check before calling respawn().
 */

import type { ProcessManager } from "./process-manager.ts";
import type { StateStore } from "./state-store.ts";
import type { Remedy } from "../runner-store.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip all ANSI escape sequences from a string. */
function stripAnsi(s: string): string {
  // Covers CSI sequences (colors, cursor), OSC, and single-char escapes
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g, "");
}

/**
 * Split raw PTY text into complete lines, carrying any trailing partial line
 * in `state.pending`. Identical logic to LogBuffer — keeps the two in sync so
 * remedy patterns fire on the same line boundaries.
 */
function splitLines(state: RemedyState, chunk: Uint8Array): string[] {
  const text = new TextDecoder().decode(chunk);
  const combined = state.pending + text;
  const parts = combined.split("\n");
  state.pending = parts[parts.length - 1]!;
  return parts.slice(0, -1); // everything except the last is a complete line
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface RemedyState {
  remedies:   Remedy[];
  cwd:        string;
  unsub:      () => void;          // unsubscribe fn from processManager.subscribeToOutput()
  cooldowns:  Map<string, number>; // remedy.name → last-fired epoch ms
  inFlight:   boolean;             // true while a fix is executing
  cancelled:  boolean;             // set by unregister(); blocks post-await respawn
  pending:    string;              // partial line carry buffer
}

const FIX_TIMEOUT_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 30_000;

// ─── Engine ──────────────────────────────────────────────────────────────────

export class RemedyEngine {
  private states = new Map<string, RemedyState>();
  private processManager: ProcessManager;
  private stateStore: StateStore;
  private onFire: (id: string, remedy: Remedy, success: boolean) => void;

  constructor(deps: {
    processManager: ProcessManager;
    stateStore:     StateStore;
    onFire:         (id: string, remedy: Remedy, success: boolean) => void;
  }) {
    this.processManager = deps.processManager;
    this.stateStore     = deps.stateStore;
    this.onFire         = deps.onFire;
  }

  /**
   * Register remedies for a process. Replaces any existing set.
   * Does NOT subscribe to output yet — that happens in onSpawn().
   */
  register(id: string, remedies: Remedy[], cwd: string): void {
    // Clean up any previous registration for this id
    const prev = this.states.get(id);
    if (prev) {
      prev.cancelled = true;
      prev.unsub();
    }

    this.states.set(id, {
      remedies,
      cwd,
      unsub:     () => {},   // no-op until onSpawn subscribes
      cooldowns: new Map(),
      inFlight:  false,
      cancelled: false,
      pending:   "",
    });
  }

  /**
   * Remove all remedies and unsubscribe. Safe to call multiple times.
   * Sets cancelled = true so any in-flight fix won't respawn afterward.
   */
  unregister(id: string): void {
    const s = this.states.get(id);
    if (!s) return;
    s.cancelled = true;    // Fix 2: blocks in-flight fix from respawning
    s.unsub();             // stops new chunks arriving
    this.states.delete(id);
  }

  /**
   * MUST be called after every spawn/restart of a registered process.
   * Unsubscribes the old hook (Fix 1), subscribes a fresh one, and resets
   * in-flight state for the new process incarnation.
   *
   * No-op if no remedies are registered for this id.
   */
  onSpawn(id: string): void {
    const s = this.states.get(id);
    if (!s) return;

    // Fix 1: unsubscribe old hook BEFORE re-subscribing — prevents accumulation
    s.unsub();
    s.inFlight  = false;
    s.cancelled = false;
    s.pending   = "";

    s.unsub = this.processManager.subscribeToOutput(id, (chunk) => {
      void this.handleChunk(id, chunk);
    });
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async handleChunk(id: string, chunk: Uint8Array): Promise<void> {
    const s = this.states.get(id);
    if (!s || s.cancelled) return;

    const lines = splitLines(s, chunk);

    for (const line of lines) {
      if (s.cancelled) return;     // re-check between lines (entry might be removed mid-loop)

      const stripped = stripAnsi(line);

      for (const remedy of s.remedies) {
        // Fix 3: one fix at a time per process
        if (s.inFlight) continue;

        // Fix 3: cooldown check
        const now = Date.now();
        const last = s.cooldowns.get(remedy.name) ?? 0;
        if (now - last < (remedy.cooldownMs ?? DEFAULT_COOLDOWN_MS)) continue;

        // Pattern match
        let matched = false;
        try {
          matched = new RegExp(remedy.pattern).test(stripped);
        } catch {
          // invalid regex — skip silently (user error in config)
          continue;
        }
        if (!matched) continue;

        // ── All guards passed — commit SYNCHRONOUSLY before any await ──
        s.inFlight = true;
        s.cooldowns.set(remedy.name, now);  // Fix 3: set before first await

        const ok = await this.runFix(remedy.cmds, s.cwd);

        // Fix 2: entry might have been removed during runFix
        if (s.cancelled || !this.states.has(id)) {
          s.inFlight = false;
          return;
        }

        this.onFire(id, remedy, ok);

        if (ok && remedy.thenRestart !== false) {
          // Fix 5: don't respawn if user already initiated a lifecycle transition
          const state = this.stateStore.getState(id);
          if (state !== "stopping" && state !== "starting") {
            await this.processManager.respawn(id);
          }
        }

        s.inFlight = false;
        break; // only first matching remedy fires per chunk batch
      }
    }
  }

  /**
   * Run fix commands sequentially. Returns true if all succeeded.
   * Fix 4: each command gets a 60s timeout — SIGKILL on exceeded.
   */
  private async runFix(cmds: string[], cwd: string): Promise<boolean> {
    for (const cmd of cmds) {
      const proc = Bun.spawn(["bash", "-c", cmd], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timeout = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already exited */ }
      }, FIX_TIMEOUT_MS);

      const code = await proc.exited;
      clearTimeout(timeout);

      if (code !== 0) return false; // stop on first failure
    }
    return true;
  }
}
