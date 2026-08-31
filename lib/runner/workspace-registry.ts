/**
 * Ownership record for the workspaces the runner creates, plus a pure
 * planner for pruning orphans left by a launch that never reached teardown
 * (a closed terminal sends SIGHUP, which a plain quit or SIGINT/SIGTERM
 * handler never sees). The two backends never cross-wire: herdr workspace
 * ids and tmux socket paths live in separate `kind` subdirectories.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { rtDir } from "../rt-paths.ts";

export function registryDir(kind: string = "workspaces"): string {
  return join(rtDir(), "runner", kind);
}

function safeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Best-effort: a failed write must never break launch. */
export function registerWorkspace(id: string, pid: number = process.pid, kind: string = "workspaces"): void {
  try {
    mkdirSync(registryDir(kind), { recursive: true });
    writeFileSync(join(registryDir(kind), safeFileName(id)), JSON.stringify({ id, pid }));
  } catch {
    // best-effort registry
  }
}

/** Best-effort: removing a record that is already gone is not an error. */
export function unregisterWorkspace(id: string, kind: string = "workspaces"): void {
  try {
    rmSync(join(registryDir(kind), safeFileName(id)), { force: true });
  } catch {
    // best-effort registry
  }
}

/** EPERM means the pid exists but belongs to another user: still alive. ESRCH (or any other error) means dead. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readRegistry(kind: string = "workspaces"): Map<string, number> {
  const map = new Map<string, number>();
  let names: string[];
  try {
    names = readdirSync(registryDir(kind));
  } catch {
    return map;
  }
  for (const name of names) {
    try {
      const raw = readFileSync(join(registryDir(kind), name), "utf8");
      const parsed = JSON.parse(raw) as { id?: string; pid?: number };
      if (typeof parsed.id === "string" && typeof parsed.pid === "number") map.set(parsed.id, parsed.pid);
    } catch {
      // skip unparseable record
    }
  }
  return map;
}

export interface ReconcilePlan {
  closeWorkspaceIds: string[];
  removeRegistryIds: string[];
}

/**
 * Pure planner: which rt-runner-* workspaces have no live owner, and which
 * registry records are stale. No I/O so the close/prune matrix is fully
 * unit-testable without a real herdr socket or filesystem.
 */
export function planReconcile(
  workspaces: { id: string; label: string }[],
  registry: Map<string, number>,
  alive: (pid: number) => boolean,
): ReconcilePlan {
  const closeWorkspaceIds: string[] = [];
  const removeRegistryIds = new Set<string>();
  const workspaceIds = new Set(workspaces.map((w) => w.id));

  for (const ws of workspaces) {
    if (!ws.label.startsWith("rt-runner-")) continue;
    const pid = registry.get(ws.id);
    if (pid === undefined || !alive(pid)) {
      closeWorkspaceIds.push(ws.id);
      removeRegistryIds.add(ws.id);
    }
  }

  for (const id of registry.keys()) {
    if (!workspaceIds.has(id)) removeRegistryIds.add(id);
  }

  return { closeWorkspaceIds, removeRegistryIds: [...removeRegistryIds] };
}

/**
 * Pure planner for the tmux side: there is no herdr `workspace.list` to
 * cross-check a tmux socket against, so a dead owner pid is the whole
 * signal. Every dead-owned socket is both killed and dropped from the
 * registry.
 */
export function planTmuxReconcile(
  registry: Map<string, number>,
  alive: (pid: number) => boolean,
): { killSocketIds: string[]; removeIds: string[] } {
  const dead: string[] = [];
  for (const [id, pid] of registry) if (!alive(pid)) dead.push(id);
  return { killSocketIds: dead, removeIds: dead };
}
