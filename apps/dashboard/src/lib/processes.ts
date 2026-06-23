import type { ProcessRecord, ProcessChangedEvent } from "./types.ts";

/**
 * Apply a `process:changed` event to the current process list. Patches the
 * matching record's state/pid/exitCode immutably. Unknown ids are left alone —
 * the caller should refetch the full list to learn about a brand-new process,
 * since the event lacks cmd/cwd/repo.
 */
export function applyProcessChanged(
  list: ProcessRecord[],
  ev: ProcessChangedEvent,
): ProcessRecord[] {
  if (!list.some((p) => p.id === ev.id)) return list;
  return list.map((p) =>
    p.id === ev.id ? { ...p, state: ev.to, pid: ev.pid, exitCode: ev.exitCode } : p,
  );
}

export interface WorktreeGroup {
  worktree: string;
  branch?: string;
  processes: ProcessRecord[];
}

export interface RepoGroup {
  repo: string;
  worktrees: WorktreeGroup[];
}

/** Group processes by repo, then worktree, both sorted alphabetically. */
export function groupByRepoWorktree(list: ProcessRecord[]): RepoGroup[] {
  const byRepo = new Map<string, Map<string, WorktreeGroup>>();

  for (const p of list) {
    const repo = p.repo ?? "ungrouped";
    const wt = p.worktree ?? "(unknown)";
    if (!byRepo.has(repo)) byRepo.set(repo, new Map());
    const worktrees = byRepo.get(repo)!;
    if (!worktrees.has(wt)) worktrees.set(wt, { worktree: wt, branch: p.branch, processes: [] });
    worktrees.get(wt)!.processes.push(p);
  }

  return [...byRepo.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, worktrees]) => ({
      repo,
      worktrees: [...worktrees.values()].sort((a, b) => a.worktree.localeCompare(b.worktree)),
    }));
}
