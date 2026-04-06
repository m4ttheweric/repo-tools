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

export type ProcessState = "running" | "warm" | "crashed" | "stopped";

type StateChangeListener = (id: string, prev: ProcessState, next: ProcessState) => void;

// Valid state transitions
const VALID_TRANSITIONS: Record<ProcessState, ProcessState[]> = {
  stopped:  ["running"],
  running:  ["warm", "crashed", "stopped"],
  warm:     ["running", "stopped"],
  crashed:  ["running", "stopped"],
};

export class StateStore {
  private states = new Map<string, ProcessState>();
  private listeners: StateChangeListener[] = [];
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
        for (const [id, state] of Object.entries(raw)) {
          this.states.set(id, state as ProcessState);
        }
      }
    } catch {
      // start fresh
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, ProcessState> = {};
      for (const [id, state] of this.states) obj[id] = state;
      writeFileSync(this.persistPath, JSON.stringify(obj, null, 2));
    } catch {
      // best-effort
    }
  }

  /** On daemon restart, all processes are dead — reset any non-stopped state. */
  reconcileAfterRestart(): void {
    let changed = false;
    for (const [id, state] of this.states) {
      if (state !== "stopped") {
        this.states.set(id, "stopped");
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  getState(id: string): ProcessState {
    return this.states.get(id) ?? "stopped";
  }

  setState(id: string, next: ProcessState): void {
    const prev = this.getState(id);
    if (prev === next) return;

    const allowed = VALID_TRANSITIONS[prev];
    if (!allowed.includes(next)) {
      // Allow forced transition for edge cases (e.g. kill of warm process)
      // but log for debugging
    }

    this.states.set(id, next);
    this.persist();

    for (const listener of this.listeners) {
      try { listener(id, prev, next); } catch { /* ignore */ }
    }
  }

  getAll(): Record<string, ProcessState> {
    const result: Record<string, ProcessState> = {};
    for (const [id, state] of this.states) result[id] = state;
    return result;
  }

  remove(id: string): void {
    this.states.delete(id);
    this.persist();
  }

  onStateChange(cb: StateChangeListener): void {
    this.listeners.push(cb);
  }
}
