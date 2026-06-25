/**
 * buildProcessRecords — compose the enriched, external-facing process record
 * from the daemon's separate sources: ProcessManager's raw entry (cmd/cwd/env +
 * timing/exit), StateStore's state/pid, and the worktree a cwd resolves to.
 *
 * Pure: state/pid are passed as lookups and worktrees as data, so this is
 * unit-testable without git, the filesystem, or a live daemon.
 */

import type { ProcessState } from "./state-store.ts";
import { resolveWorktree, type WorktreeInfo } from "./resolve-worktree.ts";

export interface RawProcessEntry {
  id: string;
  config: { cmd: string; cwd: string; env?: Record<string, string>; kind?: "terminal" };
  startedAt?: number;
  exitCode?: number;
}

export interface ProcessRecord {
  id: string;
  cmd: string;
  cwd: string;
  env?: Record<string, string>;
  /** "terminal" = interactive shell session; the GUI renders it as a live terminal. */
  kind?: "terminal";
  state: ProcessState;
  pid?: number;
  startedAt?: number;
  exitCode?: number;
  repo?: string;
  worktree?: string;
  branch?: string;
  /** Portless proxy URL for this process (no port appended). Present when portless is active. */
  url?: string;
  /** App port portless forwards to (the port the dev server listens on). */
  port?: number;
  /** Agent running in a herdr pane (e.g. "claude"); used as the display label. */
  agent?: string;
}

export function buildProcessRecords(
  processes: RawProcessEntry[],
  stateOf: (id: string) => ProcessState,
  pidOf: (id: string) => number | undefined,
  worktrees: WorktreeInfo[],
): ProcessRecord[] {
  return processes.map((p) => {
    const wt = resolveWorktree(p.config.cwd, worktrees);
    const env = p.config.env;
    const portNum = env?.PORT ? Number(env.PORT) : undefined;
    return {
      id: p.id,
      cmd: p.config.cmd,
      cwd: p.config.cwd,
      env,
      kind: p.config.kind,
      state: stateOf(p.id),
      pid: pidOf(p.id),
      startedAt: p.startedAt,
      exitCode: p.exitCode,
      repo: wt?.repo,
      worktree: wt?.path,
      branch: wt?.branch,
      url: env?.PORTLESS_URL,
      port: Number.isFinite(portNum) ? portNum : undefined,
    };
  });
}
