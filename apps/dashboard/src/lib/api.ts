import type { CanonicalEndpoint, EndpointState, ProcessRecord, RepoInfo, WorktreePackage } from "./types.ts";

async function json(res: Response): Promise<any> {
  const d = await res.json();
  if (!d.ok) throw new Error(d.error || `request failed (${res.status})`);
  return d;
}

export async function fetchProcesses(): Promise<ProcessRecord[]> {
  const res = await fetch("/api/processes");
  return (await json(res)).data as ProcessRecord[];
}

export type ControlAction = "start" | "stop" | "restart";

export async function controlProcess(id: string, action: ControlAction): Promise<void> {
  const res = await fetch(`/api/processes/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  await json(res);
}

export async function fetchRepos(): Promise<RepoInfo[]> {
  const res = await fetch("/api/repos");
  const repos = (await json(res)).data.repos as Record<string, { path: string; worktrees: RepoInfo["worktrees"] }>;
  return Object.entries(repos)
    .map(([repo, v]) => ({ repo, path: v.path, worktrees: v.worktrees }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

export async function fetchWorktreeCommands(path: string): Promise<WorktreePackage[]> {
  const res = await fetch(`/api/worktrees/commands?path=${encodeURIComponent(path)}`);
  return (await json(res)).data.packages as WorktreePackage[];
}

export async function createProcess(input: { cwd: string; script?: string; cmd?: string; label?: string }): Promise<string> {
  const res = await fetch("/api/processes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await json(res)).data.id as string;
}

/** Open an interactive shell session in a worktree; returns the new process id. */
export async function createTerminal(cwd: string): Promise<string> {
  const res = await fetch("/api/terminals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  return (await json(res)).data.id as string;
}

export async function fetchEndpoints(repo: string): Promise<{ endpoints: CanonicalEndpoint[]; state: EndpointState }> {
  const res = await fetch(`/api/endpoints?repo=${encodeURIComponent(repo)}`);
  return (await json(res)).data;
}

export async function mapEndpoint(input: { repo: string; port: number; processId: string; upstreamPort: number }): Promise<void> {
  await json(await fetch("/api/endpoints/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }));
}

export async function unmapEndpoint(input: { repo: string; port: number }): Promise<void> {
  await json(await fetch("/api/endpoints/unmap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }));
}
