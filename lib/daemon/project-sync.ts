/**
 * Full project-MR sync — fetches every open MR in a repo's project via the
 * SDK's paginated project mode and reconciles it into the project store.
 * Runs from the 5-min cycle (cache-refresh.ts), at watcher start
 * (freshness.ts), and on demand from project-mrs:read's maxAgeMs gate.
 *
 * Coalesced per repo: a caller arriving while a sync is in flight awaits
 * that run. This is what lets a forced read (maxAgeMs: 0) share work with
 * the cycle instead of stacking fetches — and it must NEVER fall back to
 * the full branch-enrichment refresh (spec §5.2: forced project reads may
 * not pay for unrelated repos).
 */

import type { PullRequest } from "@workforge/glance-sdk";
import { getRepoContext } from "./freshness.ts";
import { getProjectMRs, type ProjectMRs } from "./project-mrs-store.ts";
import { getDaemonLogger } from "../daemon-logger.ts";

const log = (await getDaemonLogger()).childLogger("project-sync");

export interface ProjectSyncDeps {
  repoIndex(): Record<string, string>;
  broadcast(type: string, data: unknown): void;
}

export interface ProjectSyncOverrides {
  fetchProject?: (repoName: string) => Promise<{ projectPath: string; prs: PullRequest[] }>;
  store?: ProjectMRs;
}

const syncInFlight = new Map<string, Promise<void>>();

export function syncProjectMRs(
  deps: ProjectSyncDeps,
  repoName: string,
  overrides: ProjectSyncOverrides = {},
): Promise<void> {
  const existing = syncInFlight.get(repoName);
  if (existing) return existing;
  const run = syncImpl(deps, repoName, overrides).finally(() => { syncInFlight.delete(repoName); });
  syncInFlight.set(repoName, run);
  return run;
}

async function syncImpl(
  deps: ProjectSyncDeps,
  repoName: string,
  overrides: ProjectSyncOverrides,
): Promise<void> {
  const store = overrides.store ?? getProjectMRs();
  const fetchProject = overrides.fetchProject ?? (async (repo: string) => {
    const { provider, projectPath } = await getRepoContext(repo, deps.repoIndex()[repo]);
    const prs = await provider.fetchPullRequests({ projectPath, state: "opened" });
    return { projectPath, prs };
  });

  const syncStartedAt = Date.now();
  const { projectPath, prs } = await fetchProject(repoName);
  const changed = store.fullSync(repoName, projectPath, prs, syncStartedAt);
  log.debug({ repo: repoName, open: prs.length, changed: changed.length }, "project sync");
  if (changed.length > 0) {
    deps.broadcast("project-mrs", { repoName, iids: changed });
  }
}
