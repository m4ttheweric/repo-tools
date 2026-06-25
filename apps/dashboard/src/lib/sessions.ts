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

/**
 * Short tab label. Prefers the herdr agent name ("claude") so panes don't show
 * as raw "term_…" ids; else "shell N" for rt shells, the id suffix for rt
 * commands, and a clean "terminal" for a bare herdr pane with no agent.
 * Duplicates within a worktree are numbered by sessionsForWorktree.
 */
export function sessionLabel(r: ProcessRecord): string {
  if (r.agent) return r.agent;
  if (r.kind === "terminal") {
    const n = r.id.split(":").pop();
    return n ? `shell ${n}` : "shell";
  }
  const i = r.id.lastIndexOf(":");
  if (i >= 0) return r.id.slice(i + 1);
  return r.id.startsWith("term_") ? "terminal" : r.id;
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
  const sessions = [...commands, ...shells].map(toSession);
  // Disambiguate duplicate labels within a worktree: claude, claude 2, claude 3.
  const total = new Map<string, number>();
  for (const s of sessions) total.set(s.label, (total.get(s.label) ?? 0) + 1);
  const nth = new Map<string, number>();
  for (const s of sessions) {
    if ((total.get(s.label) ?? 0) > 1) {
      const k = (nth.get(s.label) ?? 0) + 1;
      nth.set(s.label, k);
      s.label = `${s.label} ${k}`;
    }
  }
  return sessions;
}
