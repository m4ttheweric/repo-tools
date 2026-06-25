/** Mirrors the daemon's enriched process record (GET /api/processes). */
export type ProcessState =
  | "running" | "warm" | "crashed" | "stopped" | "starting" | "stopping";

export interface ProcessRecord {
  id: string;
  cmd: string;
  cwd: string;
  env?: Record<string, string>;
  /** "terminal" = interactive shell session, rendered as a live terminal. */
  kind?: "terminal";
  state: ProcessState;
  pid?: number;
  startedAt?: number;
  exitCode?: number;
  repo?: string;
  worktree?: string;
  branch?: string;
  /** Portless proxy URL (no port appended). Present when portless is active. */
  url?: string;
  /** App port portless forwards to. */
  port?: number;
  /** Agent running in a herdr pane (e.g. "claude"); preferred tab label. */
  agent?: string;
}

export interface RepoWorktree {
  path: string;
  branch: string;
}

export interface RepoInfo {
  repo: string;
  path: string;
  worktrees: RepoWorktree[];
}

export interface PackageScript {
  name: string;
  cmd: string;
}

export interface WorktreePackage {
  name: string;
  dir: string;
  scripts: PackageScript[];
}

/** Payload of the `process:changed` WebSocket event. */
export interface ProcessChangedEvent {
  id: string;
  from: ProcessState;
  to: ProcessState;
  pid?: number;
  exitCode?: number;
}

export interface CanonicalEndpoint {
  port: number;
  name: string;
  mode: "forward" | "bounce";
  returnParam?: string;
}

export interface EndpointState {
  forward: Record<string, string>;
  bounceEnabled: number[];
}
