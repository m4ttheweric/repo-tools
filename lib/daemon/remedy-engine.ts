/**
 * RemedyEngine — auto-detect error patterns in process output and execute fixes.
 *
 * Two remedy sources:
 *   1. Per-entry:  registered via remedy:set IPC, stored in the runner config JSON.
 *   2. Global:     loaded from ~/.rt/remedies/_global.json, matched by cwdContains
 *                  and cmdContains substrings. Hot-reloaded when the file changes.
 *
 * When a log line matches a remedy's pattern (after ANSI stripping), the engine
 * runs the fix commands in the entry's working directory and optionally restarts.
 *
 * Lifecycle safety:
 *   1. Hook accumulation:  unsub() called in onSpawn() before re-subscribing.
 *   2. Orphan on removal:  cancelled flag checked after every await.
 *   3. Concurrent triggers: inFlight + cooldown set synchronously before await.
 *   4. Hung fix command:   60s timeout + SIGKILL per command.
 *   5. Double-respawn:     stateStore check before calling respawn().
 */

import type { ProcessManager } from "./process-manager.ts";
import type { StateStore }     from "./state-store.ts";
import type { Remedy }         from "../runner-store.ts";
import type { GlobalRemedy }   from "../runner-store.ts";

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

/**
 * Return true if `globalRemedy` matches the given process context.
 * Both `cwdContains` and `cmdContains` must match if specified (AND logic).
 * Matching is case-insensitive substring.
 */
function globalMatches(r: GlobalRemedy, cwd: string, cmd: string): boolean {
  if (r.cwdContains && !cwd.toLowerCase().includes(r.cwdContains.toLowerCase())) return false;
  if (r.cmdContains && !cmd.toLowerCase().includes(r.cmdContains.toLowerCase())) return false;
  return true;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProcessMeta {
  cwd: string;
  cmd: string; // the resolved command string (after port substitution)
}

interface RemedyState {
  remedies:  Remedy[];    // merged: per-entry + matching globals
  cwd:       string;
  cmd:       string;      // stored so we can re-merge on global reload
  unsub:     () => void;  // unsubscribe fn from processManager.subscribeToOutput()
  cooldowns: Map<string, number>; // remedy.name → last-fired epoch ms
  inFlight:  boolean;             // true while a fix is executing
  cancelled: boolean;             // set by unregister(); blocks post-await respawn
  pending:   string;              // partial line carry buffer
}

const FIX_TIMEOUT_MS     = 60_000;
const DEFAULT_COOLDOWN_MS = 30_000;

// ─── Engine ──────────────────────────────────────────────────────────────────

export class RemedyEngine {
  private states        = new Map<string, RemedyState>();
  /** Per-entry remedy lists, before global merge.  Keyed by processId. */
  private entryRemedies = new Map<string, Remedy[]>();
  private processMeta   = new Map<string, ProcessMeta>();
  private globalRemedies: GlobalRemedy[] = [];

  private processManager: ProcessManager;
  private stateStore:     StateStore;
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

  // ─── Global remedies ───────────────────────────────────────────────────────

  /**
   * Replace the loaded global remedies and re-merge into all active states.
   * Called by the daemon when ~/.rt/remedies/_global.json changes.
   */
  reloadGlobals(globals: GlobalRemedy[]): void {
    this.globalRemedies = globals;
    // Re-merge for every currently-registered process. If this flips a state
    // from empty→non-empty remedies, we also need to subscribe now (onSpawn
    // would have early-returned when globals didn't match yet).
    for (const [id, s] of this.states) {
      const entry = this.entryRemedies.get(id) ?? [];
      const meta  = this.processMeta.get(id);
      if (!meta) continue;
      const prevHad = s.remedies.length > 0;
      s.remedies = this.mergeRemedies(entry, meta.cwd, meta.cmd);
      const nowHas = s.remedies.length > 0;
      if (!prevHad && nowHas) {
        s.unsub();
        s.unsub = this.processManager.subscribeToOutput(id, (chunk) => {
          void this.handleChunk(id, chunk);
        });
      } else if (prevHad && !nowHas) {
        s.unsub();
        s.unsub = () => {};
      }
    }
  }

  /**
   * Merge per-entry remedies with any matching global remedies.
   * Global remedies are appended after per-entry ones so per-entry rules
   * fire first (higher priority).
   */
  private mergeRemedies(entryRemedies: Remedy[], cwd: string, cmd: string): Remedy[] {
    const matchingGlobals = this.globalRemedies.filter((r) => globalMatches(r, cwd, cmd));
    return [...entryRemedies, ...matchingGlobals];
  }

  // ─── Per-entry registration ───────────────────────────────────────────────

  /**
   * Register per-entry remedies for a process. Replaces any existing set.
   * Also stores the process metadata (cwd, cmd) for global matching.
   * Does NOT subscribe to output yet — that happens in onSpawn().
   */
  register(id: string, remedies: Remedy[], cwd: string, cmd = ""): void {
    this.entryRemedies.set(id, remedies);
    this.processMeta.set(id, { cwd, cmd });

    // Clean up any previous state
    const prev = this.states.get(id);
    if (prev) {
      prev.cancelled = true;
      prev.unsub();
    }

    const merged = this.mergeRemedies(remedies, cwd, cmd);
    this.states.set(id, {
      remedies:  merged,
      cwd,
      cmd,
      unsub:     () => {},  // no-op until onSpawn subscribes
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
    if (s) {
      s.cancelled = true;   // Fix 2: blocks in-flight fix from respawning
      s.unsub();            // stops new chunks arriving
    }
    this.states.delete(id);
    this.entryRemedies.delete(id);
    this.processMeta.delete(id);
  }

  /**
   * MUST be called after every spawn/restart of a registered process.
   * Unsubscribes the old hook (Fix 1), subscribes a fresh one, and resets
   * in-flight state for the new process incarnation.
   *
   * Also re-merges with current global remedies so a reload between spawns
   * is always reflected.
   *
   * No-op if no remedies are registered for this id AND no globals match.
   */
  onSpawn(id: string, cwd?: string, cmd?: string): void {
    // Update meta if caller provides fresh cwd/cmd (e.g. after a port substitution)
    if (cwd !== undefined || cmd !== undefined) {
      const prev = this.processMeta.get(id) ?? { cwd: "", cmd: "" };
      this.processMeta.set(id, {
        cwd: cwd ?? prev.cwd,
        cmd: cmd ?? prev.cmd,
      });
    }

    const meta         = this.processMeta.get(id);
    const entryRemedies = this.entryRemedies.get(id) ?? [];
    const merged       = meta ? this.mergeRemedies(entryRemedies, meta.cwd, meta.cmd) : entryRemedies;

    // Nothing to watch — skip
    if (merged.length === 0) return;

    let s = this.states.get(id);
    if (!s) {
      // No explicit register() call yet (e.g. globals-only match) — create state
      s = {
        remedies:  merged,
        cwd:       meta?.cwd ?? "",
        cmd:       meta?.cmd ?? "",
        unsub:     () => {},
        cooldowns: new Map(),
        inFlight:  false,
        cancelled: false,
        pending:   "",
      };
      this.states.set(id, s);
    } else {
      // Fix 1: unsubscribe old hook BEFORE re-subscribing — prevents accumulation
      s.unsub();
      s.remedies  = merged;
      s.cwd       = meta?.cwd ?? s.cwd;
      s.cmd       = meta?.cmd ?? s.cmd;
      s.inFlight  = false;
      s.cancelled = false;
      s.pending   = "";
    }

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
      if (s.cancelled) return;     // re-check between lines

      const stripped = stripAnsi(line);

      for (const remedy of s.remedies) {
        // Fix 3: one fix at a time per process
        if (s.inFlight) continue;

        // Fix 3: cooldown check
        const now  = Date.now();
        const last = s.cooldowns.get(remedy.name) ?? 0;
        if (now - last < (remedy.cooldownMs ?? DEFAULT_COOLDOWN_MS)) continue;

        // Pattern match — any pattern in the array is sufficient (OR logic)
        let matched = false;
        const patterns = Array.isArray(remedy.pattern) ? remedy.pattern : [remedy.pattern];
        for (const pat of patterns) {
          try {
            if (new RegExp(pat).test(stripped)) { matched = true; break; }
          } catch {
            // invalid regex — skip this pattern silently
          }
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
