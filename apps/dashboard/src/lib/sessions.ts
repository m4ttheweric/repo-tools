import type { ProcessRecord, ProcessState } from "./types.ts";

export type SessionKind = "command" | "shell";

export interface Session {
  id: string;
  kind: SessionKind;
  label: string;
  state: ProcessState;
  cmd: string;
  startedAt?: number;
  exitCode?: number;
  url?: string;
}

const LIVE: ReadonlySet<ProcessState> = new Set(["running", "starting", "warm"]);

/** Live = currently runnable/attached (not stopped/crashed/stopping). */
export function isLive(state: ProcessState): boolean {
  return LIVE.has(state);
}

/** Short tab label: "dev" for commands, "shell 2" for shell sessions. */
export function sessionLabel(r: ProcessRecord): string {
  if (r.kind === "terminal") {
    const n = r.id.split(":").pop();
    return n ? `shell ${n}` : "shell";
  }
  const i = r.id.lastIndexOf(":");
  return i >= 0 ? r.id.slice(i + 1) : r.id;
}

/** Tailwind background class for the status dot. */
export function statusDotClass(state: ProcessState): string {
  switch (state) {
    case "running": return "bg-sel-green";
    case "crashed": return "bg-sel-red";
    case "starting":
    case "stopping":
    case "warm": return "bg-sel-yellow";
    default: return "bg-muted-foreground"; // stopped
  }
}

export function toSession(r: ProcessRecord): Session {
  return {
    id: r.id,
    kind: r.kind === "terminal" ? "shell" : "command",
    label: sessionLabel(r),
    state: r.state,
    cmd: r.cmd,
    startedAt: r.startedAt,
    exitCode: r.exitCode,
    url: r.url,
  };
}

/**
 * Tabs for one worktree: every command session (any state — a dead one can be
 * restarted) plus only the live shell sessions (a dead shell is useless).
 * Commands first, then shells, preserving input order within each group.
 */
export function sessionsForWorktree(records: ProcessRecord[]): Session[] {
  const commands = records.filter((r) => r.kind !== "terminal");
  const shells = records.filter((r) => r.kind === "terminal" && isLive(r.state));
  return [...commands, ...shells].map(toSession);
}
