/**
 * Endpoint IPC handlers — dev-endpoint claim/lookup/release/status (RT-28).
 *
 *   endpoint:claim   — allocate (or reuse) a port for a role, plus every role
 *                       it `needs`, and return env-ready refs for all of them
 *   endpoint:lookup   — read-only: does this worktree hold a claim for a role
 *   endpoint:release  — free this worktree's claim(s) in a repo
 *   endpoint:status   — dump live claims (with liveness) for one or all repos
 *
 * `releaseEndpointsForWorktree` is exported standalone (not part of the
 * HandlerMap) so the daemon's worktree-disposal fan-out can call it directly
 * without routing a command through the socket. It loads/saves the claims
 * store itself — there is no shared handler instance state, the file on disk
 * IS the state.
 */

import type { EndpointRepoConfig, RoleConfig } from "../../endpoint/config.ts";
import { loadEndpointRepoConfig } from "../../endpoint/config.ts";
import type { EndpointClaim } from "../../endpoint/store.ts";
import { claimsEpoch, loadClaims, saveClaims } from "../../endpoint/store.ts";
import type { Probes } from "../../endpoint/allocator.ts";
import { defaultProbes, isLiveClaim, releaseWorktree, resolveClaim } from "../../endpoint/allocator.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

const url = (port: number): string => `http://localhost:${port}`;

export interface RoleRef {
  port: number;
  url: string;
  running: boolean;
}

/**
 * Resolves `role` plus every role it `needs` against an in-memory claims
 * array (no I/O), accumulating changes as it goes. Each needed role that
 * isn't declared in the repo config fails the whole claim rather than
 * silently omitting it from `refs` — a ref missing at env-render time is a
 * worse failure mode than a rejected claim. `refs` is built inline (rather
 * than a `Record<string, number>` ports map read back afterward) so every
 * port is a plain local, never an indexed lookup `noUncheckedIndexedAccess`
 * would otherwise force back through `| undefined`.
 */
function resolveRoleAndNeeds(
  claims: EndpointClaim[],
  repoCfg: EndpointRepoConfig,
  repo: string,
  worktree: string,
  role: string,
  roleCfg: RoleConfig,
  pid: number | undefined,
  probes: Probes,
): { claims: EndpointClaim[]; changed: boolean; port: number; refs: Record<string, RoleRef> } | { error: string } {
  const primary = resolveClaim(claims, role, roleCfg, worktree, pid, probes);
  if ("error" in primary) return { error: primary.error };
  let current = primary.claims;
  let changed = primary.changed;
  const port = primary.port;

  const refs: Record<string, RoleRef> = {};
  for (const neededRole of roleCfg.needs) {
    const neededCfg = repoCfg.roles[neededRole];
    if (!neededCfg) return { error: `role "${neededRole}" is not declared for repo "${repo}"` };
    const res = resolveClaim(current, neededRole, neededCfg, worktree, pid, probes);
    if ("error" in res) return { error: res.error };
    current = res.claims;
    changed = changed || res.changed;
    refs[neededRole] = { port: res.port, url: url(res.port), running: probes.listeners.has(res.port) };
  }

  return { claims: current, changed, port, refs };
}

// Named-key return type (not a bare `HandlerMap`), same trick as
// `createEventsHandlers`: under `noUncheckedIndexedAccess`, a plain
// `Record<string, Handler>` makes `handlers["endpoint:claim"]` resolve to
// `Handler | undefined` for every caller, tests included. Declaring the four
// commands as named members keeps direct access typed while the `& HandlerMap`
// intersection still satisfies the router's spread.
export function createEndpointHandlers(
  ctx: HandlerContext,
  deps?: { probes?: () => Promise<Probes> },
): Record<"endpoint:claim" | "endpoint:lookup" | "endpoint:release" | "endpoint:status", (payload: any) => Promise<any>> & HandlerMap {
  const probesFn = deps?.probes ?? defaultProbes;

  return {
    "endpoint:claim": async (payload) => {
      const repo = payload?.repo;
      const worktree = payload?.worktree;
      const role = payload?.role;
      const pid: number | undefined = payload?.pid;
      if (!repo || !worktree || !role) return { ok: false, error: "missing repo, worktree, or role" };

      const repoCfg = loadEndpointRepoConfig(repo);
      const roleCfg = repoCfg.roles[role];
      if (!roleCfg) return { ok: false, error: `role "${role}" is not declared for repo "${repo}"` };

      const probes = await probesFn();

      // Epoch-guarded exactly like `patchTree`: the await above is the only
      // yield point, so a concurrent claim/release could have saved a newer
      // claims file while we were suspended there. Reload-and-redo once if
      // that happened; the second pass always saves (same event loop, no
      // further awaits, so a second collision cannot occur).
      let applied!: { claims: EndpointClaim[]; changed: boolean; port: number; refs: Record<string, RoleRef> };
      for (let attempt = 0; attempt < 2; attempt++) {
        const claims = loadClaims(repo);
        const epoch = claimsEpoch(repo);
        const res = resolveRoleAndNeeds(claims, repoCfg, repo, worktree, role, roleCfg, pid, probes);
        if ("error" in res) return { ok: false, error: res.error };
        applied = res;
        if (claimsEpoch(repo) === epoch || attempt === 1) {
          saveClaims(repo, res.claims);
          break;
        }
      }

      if (applied.changed) {
        ctx.log.debug({ repo, worktree, role, port: applied.port }, "endpoint claimed");
      }

      return {
        ok: true,
        data: { role, port: applied.port, url: url(applied.port), refs: applied.refs },
      };
    },

    "endpoint:lookup": async (payload) => {
      const repo = payload?.repo;
      const worktree = payload?.worktree;
      const role = payload?.role;
      if (!repo || !worktree || !role) return { ok: false, error: "missing repo, worktree, or role" };

      const repoCfg = loadEndpointRepoConfig(repo);
      const roleCfg = repoCfg.roles[role];
      if (!roleCfg) return { ok: false, error: `role "${role}" is not declared for repo "${repo}"` };

      const probes = await probesFn();

      if (roleCfg.fixedPort !== undefined) {
        const port = roleCfg.fixedPort;
        return { ok: true, data: { claimed: true, port, url: url(port), running: probes.listeners.has(port) } };
      }

      const claim = loadClaims(repo).find((c) => c.worktree === worktree && c.role === role);
      if (!claim) return { ok: true, data: { claimed: false, port: null, url: null, running: false } };

      return {
        ok: true,
        data: { claimed: true, port: claim.port, url: url(claim.port), running: isLiveClaim(claim, probes) },
      };
    },

    "endpoint:release": async (payload) => {
      const repo = payload?.repo;
      const worktree = payload?.worktree;
      const role = payload?.role;
      if (!repo || !worktree) return { ok: false, error: "missing repo or worktree" };

      const { claims: remaining, released } = releaseWorktree(loadClaims(repo), worktree, role);
      if (released.length > 0) saveClaims(repo, remaining);
      return { ok: true, data: { released: released.length } };
    },

    "endpoint:status": async (payload) => {
      const repoFilter = payload?.repo;
      const probes = await probesFn();
      const repoNames = repoFilter ? [repoFilter] : Object.keys(ctx.repoIndex());

      const repos: Record<string, Array<EndpointClaim & { running: boolean }>> = {};
      for (const repoName of repoNames) {
        repos[repoName] = loadClaims(repoName).map((c) => ({ ...c, running: isLiveClaim(c, probes) }));
      }
      return { ok: true, data: { repos } };
    },
  };
}

/**
 * Frees every claim a worktree holds in a repo. Called from the daemon's
 * `worktree:disposed` broadcast fan-out (fire-and-forget), not through the
 * command router, so it has no `HandlerMap` entry and takes only the slice
 * of `HandlerContext` it needs.
 *
 * Called synchronously from inside `emit`, so a throw here (e.g. `saveClaims`
 * hitting a write failure) would propagate out of `emit("worktree:disposed",
 * ...)` and make an otherwise-successful disposal report as failed — never
 * let that happen; log at `warn` and swallow instead, per the repo's catch
 * policy (this is exactly the "genuinely expected condition" carve-out: a
 * disposal's endpoint bookkeeping failing is not worth aborting the
 * reconciler pass over).
 */
export function releaseEndpointsForWorktree(
  ctx: Pick<HandlerContext, "log">,
  repo: string,
  worktreePath: string,
): void {
  try {
    const { claims: remaining, released } = releaseWorktree(loadClaims(repo), worktreePath);
    if (released.length === 0) return;
    saveClaims(repo, remaining);
    ctx.log.info(
      { repo, worktree: worktreePath, released: released.length },
      "endpoint claims released on disposal",
    );
  } catch (err) {
    ctx.log.warn({ err, repo, worktree: worktreePath }, "failed to release endpoint claims on disposal");
  }
}
