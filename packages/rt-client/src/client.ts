/**
 * Typed reads against the rt daemon's command surface (see commands.ts).
 * Every function degrades to `{ ok: false, error }` instead of throwing,
 * inherited from rtCommand -- callers surface daemon-down verbatim.
 */
import { rtCommand } from "./transport.ts";
import type { RtResponse, RtClientOptions } from "./transport.ts";
import type { DemandDecl, ProjectMRsData, DiscussionsData, MrByBranchData, ForgeSlug, ForgeTokenData, RunSummary, RunDetail } from "./commands.ts";

/**
 * One repo's project open-MR store. A cold repo forces a full paginated sync
 * on the daemon side when maxAgeMs demands it, which can run tens of seconds
 * on a big project -- hence the long timeout.
 *
 * `demand` tells the daemon what this caller needs covered (client id, the
 * authors it cares about, when it declared that need), so the daemon can
 * size the sync to actually cover it rather than trusting the store's
 * self-reported source.
 */
export function readProjectMRs(
  repoName: string,
  maxAgeMs?: number,
  opts: RtClientOptions = {},
  demand?: DemandDecl,
): Promise<RtResponse<ProjectMRsData>> {
  const payload: Record<string, unknown> = { repoName };
  if (maxAgeMs !== undefined) payload.maxAgeMs = maxAgeMs;
  if (demand !== undefined) payload.demand = demand;
  return rtCommand<ProjectMRsData>("project-mrs:read", payload, { sockPath: opts.sockPath, timeoutMs: 90_000 });
}

export function readDiscussions(
  repoName: string,
  iid: number,
  opts: RtClientOptions = {},
): Promise<RtResponse<DiscussionsData>> {
  return rtCommand<DiscussionsData>(
    "discussions:read",
    { repoName, iid },
    { sockPath: opts.sockPath, timeoutMs: 30_000 },
  );
}

export function readMrsByBranch(
  repoName: string,
  branches: string[],
  opts: RtClientOptions = {},
): Promise<RtResponse<MrByBranchData>> {
  return rtCommand<MrByBranchData>(
    "mr:by-branch",
    { repoName, branches },
    { sockPath: opts.sockPath, timeoutMs: 60_000 },
  );
}

/**
 * The forge token for one tracked repo (MAT-33). Grant-gated on the daemon
 * side: an untracked repo comes back `ok: false` with the `rt daemon track`
 * command to run, which is the fail-closed shape callers should surface
 * verbatim. Callers keep env-var precedence on their own side; this is the
 * fallback that replaces reading ~/.mattstack/rt/secrets.json directly.
 */
export function resolveForgeToken(
  repoName: string,
  forge: ForgeSlug,
  opts: RtClientOptions = {},
): Promise<RtResponse<ForgeTokenData>> {
  return rtCommand<ForgeTokenData>(
    "secrets:forge-token",
    { repoName, forge },
    { sockPath: opts.sockPath, timeoutMs: 10_000 },
  );
}

export function listRuns(
  repo?: string,
  opts: RtClientOptions = {},
): Promise<RtResponse<{ runs: RunSummary[] }>> {
  const payload: Record<string, unknown> = {};
  if (repo !== undefined) payload.repo = repo;
  return rtCommand<{ runs: RunSummary[] }>("runs:list", payload, { sockPath: opts.sockPath, timeoutMs: 10_000 });
}

export function getRun(
  runId: string,
  repo?: string,
  opts: RtClientOptions = {},
): Promise<RtResponse<RunDetail>> {
  const payload: Record<string, unknown> = { runId };
  if (repo !== undefined) payload.repo = repo;
  return rtCommand<RunDetail>("runs:get", payload, { sockPath: opts.sockPath, timeoutMs: 10_000 });
}

/**
 * SKILLS-54. rt's only write path into run state, so a wedged run can be
 * resolved by a person instead of lying in the data forever. The write happens
 * in the daemon and is attributed there; consumers never touch the run DB.
 */
export function abandonRun(
  runId: string,
  repo?: string,
  reason?: string,
  opts: RtClientOptions = {},
): Promise<RtResponse<{ ok: boolean }>> {
  const payload: Record<string, unknown> = { runId };
  if (repo !== undefined) payload.repo = repo;
  if (reason !== undefined) payload.reason = reason;
  return rtCommand<{ ok: boolean }>("runs:abandon", payload, { sockPath: opts.sockPath, timeoutMs: 10_000 });
}
