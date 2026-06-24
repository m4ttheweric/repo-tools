import type { ProcessRecord } from "../process-records.ts";
import type { ProcessState } from "../state-store.ts";
import { resolveWorktree, type WorktreeInfo } from "../resolve-worktree.ts";
import type { PaneRef } from "./pane-map.ts";

export interface HerdrPane {
  paneId: string; terminalId: string; workspaceId: string;
  cwd: string; agentStatus: string; foregroundCmd?: string;
}

export function herdrAgentStatusToState(s: string): ProcessState {
  switch (s) {
    case "done":
    case "idle": return "stopped";
    case "blocked":
    case "working":
    default: return "running";
  }
}

export function paneToRecord(pane: HerdrPane, ref: PaneRef | undefined, worktrees: WorktreeInfo[]): ProcessRecord {
  const wt = resolveWorktree(pane.cwd, worktrees);
  return {
    id: ref?.id ?? pane.terminalId,
    cmd: ref?.cmd ?? pane.foregroundCmd ?? "",
    cwd: pane.cwd,
    env: ref?.env,
    state: herdrAgentStatusToState(pane.agentStatus),
    startedAt: ref?.startedAt,
    repo: wt?.repo,
    worktree: wt?.path,
    branch: wt?.branch,
    port: ref?.port,
    kind: ref?.kind,
  };
}
