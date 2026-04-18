/**
 * StateStore — explicit, authoritative process state tracking.
 *
 * State is never inferred from external tools (tmux, ps). Every transition
 * is driven by a real event: spawn, exit, SIGSTOP, SIGCONT, kill.
 * Persisted to ~/.rt/process-states.json so the runner survives daemon restarts
 * (though reconcileAfterRestart() resets all non-stopped states on boot).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type ProcessState = "running" | "warm" | "crashed" | "stopped" | "starting" | "stopping";

type StateChangeListener = (id: string, prev: ProcessState, next: ProcessState) => void;

// Valid state transitions
const VALID_TRANSITIONS: Record<ProcessState, ProcessState[]> = {
  stopped:  ["running", "starting"],
  running:  ["warm", "crashed", "stopped", "stopping"],
  warm:     ["running", "stopped", "stopping"],
  crashed:  ["running", "stopped", "starting"],
  starting: ["running", "crashed", "stopped"],
  stopping: ["stopped", "crashed"],
};

/** Persisted record: current state + last-known child pid (pgroup leader when detached). */
interface Record_ { state: ProcessState; pid?: number }

type InvalidTransitionListener = (id: string, prev: ProcessState, next: ProcessState) => void;

export class StateStore {
  private states = new Map<string, Record_>();
  private listeners: StateChangeListener[] = [];
  private invalidTransitionListeners: InvalidTransitionListener[] = [];
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? join(homedir(), ".rt");
    this.load();
  }

  private get persistPath(): string {
    return join(this.dataDir, "process-states.json");
  }

  private load(): void {
    try {
      if (existsSync(this.persistPath)) {
        const raw = JSON.parse(readFileSync(this.persistPath, "utf8"));
        for (const [id, value] of Object.entries(raw)) {
          // Support both legacy `{id: state}` and current `{id: {state, pid?}}`.
          if (typeof value === "string") {
            this.states.set(id, { state: value as ProcessState });
          } else if (value && typeof value === "object" && "state" in value) {
            const v = value as { state: ProcessState; pid?: number };
            this.states.set(id, { state: v.state, pid: v.pid });
          }
        }
      }
    } catch {
      // start fresh
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, Record_> = {};
      for (const [id, rec] of this.states) obj[id] = rec;
      writeFileSync(this.persistPath, JSON.stringify(obj, null, 2));
    } catch {
      // best-effort
    }
  }

  /**
   * On daemon restart, most processes are gone — but SIGSTOP'd warm processes
   * survive as orphans reparented to init. Return `{id, pid}` for every entry
   * that was non-stopped with a known pid so the caller can signal them (SIGCONT
   * + SIGKILL to the pgroup). Then reset all non-stopped states to `stopped`
   * and clear pids.
   */
  reconcileAfterRestart(): Array<{ id: string; pid: number }> {
    const orphans: Array<{ id: string; pid: number }> = [];
    let changed = false;
    for (const [id, rec] of this.states) {
      if (rec.state !== "stopped") {
        if (rec.pid && rec.pid > 1) orphans.push({ id, pid: rec.pid });
        this.states.set(id, { state: "stopped" });
        changed = true;
      }
    }
    if (changed) this.persist();
    return orphans;
  }

  getState(id: string): ProcessState {
    return this.states.get(id)?.state ?? "stopped";
  }

  getPid(id: string): number | undefined {
    return this.states.get(id)?.pid;
  }

  /**
   * Record the child pid for `id`. Called by ProcessManager after spawn so
   * reconcileAfterRestart can reap orphans on the next daemon boot.
   * Passing `undefined` clears the pid (e.g. on exit).
   */
  setPid(id: string, pid: number | undefined): void {
    const rec = this.states.get(id) ?? { state: "stopped" as ProcessState };
    if (rec.pid === pid) return;
    this.states.set(id, { ...rec, pid });
    this.persist();
  }

  setState(id: string, next: ProcessState): void {
    const prev = this.getState(id);
    if (prev === next) return;

    const allowed = VALID_TRANSITIONS[prev];
    if (!allowed.includes(next)) {
      // Forced transitions are permitted (kill of warm, reconcileAfterRestart
      // from any state, etc.) but surface them so table drift doesn't hide.
      for (const l of this.invalidTransitionListeners) {
        try { l(id, prev, next); } catch { /* ignore */ }
      }
    }

    const rec = this.states.get(id) ?? { state: prev };
    // Terminal states imply the pid is stale — clear it.
    const pid = next === "stopped" || next === "crashed" ? undefined : rec.pid;
    this.states.set(id, { state: next, pid });
    this.persist();

    for (const listener of this.listeners) {
      try { listener(id, prev, next); } catch { /* ignore */ }
    }
  }

  getAll(): Record<string, ProcessState> {
    const result: Record<string, ProcessState> = {};
    for (const [id, rec] of this.states) result[id] = rec.state;
    return result;
  }

  remove(id: string): void {
    this.states.delete(id);
    this.persist();
  }

  onStateChange(cb: StateChangeListener): void {
    this.listeners.push(cb);
  }

  /**
   * Subscribe to transitions that violate VALID_TRANSITIONS. Transitions are
   * still applied (forced transitions are legitimate for reconcile and forced
   * kill); this hook exists so the daemon can surface drift in the table.
   */
  onInvalidTransition(cb: InvalidTransitionListener): void {
    this.invalidTransitionListeners.push(cb);
  }
}
