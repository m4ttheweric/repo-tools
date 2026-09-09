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
import { loadEndpointConfig } from "../../endpoint/config.ts";
import { deriveRepoIdentity } from "../../settings/identity.ts";
import { decodeRepo } from "../identity-decoder.ts";
import { resolveIndexPathForIdentity } from "../../repo-index.ts";
import type { EndpointClaim } from "../../endpoint/store.ts";
import { loadClaims, saveClaims } from "../../endpoint/store.ts";
import type { Probes } from "../../endpoint/allocator.ts";
import { defaultProbes, isLiveClaim, releaseWorktree, resolveClaim } from "../../endpoint/allocator.ts";
import { canon } from "../../fs-canon.ts";
import { findTreeByPath } from "../../worktree/registry.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

const url = (port: number): string => `http://localhost:${port}`;

/**
 * repo NAME → repo IDENTITY, the key the settings stores' `repos.<identity>`
 * sections use (RT-47). The name→path hop is the daemon's repo index; the
 * path→identity hop is `deriveRepoIdentity`, which is ASYNC (a `git config`
 * capture, never a sync spawn — this runs on the daemon thread) and memoized
 * per path, so the git call happens once per repo per daemon lifetime rather
 * than once per claim.
 *
 * Degrades to null rather than failing a claim: an unregistered repo name, a
 * path git can't answer for, or a remote that doesn't normalize all just make
 * the store's repo sections unreachable, leaving global scopes and the legacy
 * per-repo config.json to answer — which is exactly the pre-RT-47 behaviour.
 * A real failure is logged (never silently swallowed) per the repo's catch
 * policy.
 */
async function repoIdentityFor(ctx: Pick<HandlerContext, "log" | "repoIndex">, repo: string): Promise<string | null> {
  try {
    // Legacy-tolerant on purpose: right after the identity cutover the index
    // rows still carry name keys until something re-keys them, and a claim
    // arriving through an intercept shim may be the first rt activity in that
    // repo — resolveIndexPathForIdentity migrates the row on this read.
    const repoPath = ctx.repoIndex()[repo] ?? await resolveIndexPathForIdentity(repo);
    if (!repoPath) return null;
    const identity = await deriveRepoIdentity(repoPath);
    return identity.kind === "remote" ? identity.id : null;
  } catch (err) {
    ctx.log.warn({ err, repo }, "repo identity derivation failed; resolving endpoint config without repo scopes");
    return null;
  }
}

export interface RoleRef {
  port: number;
  url: string;
  running: boolean;
}

/** Who actually holds the LISTEN on a looked-up port (RT-115): "a port is listening" is not "my server is listening". */
export interface ListenerReport {
  pid: number;
  command: string;
  cwd: string | null;
  /** true/false when attribution succeeded; null when the process's cwd could not be read (unknown, not foreign). */
  ownsClaim: boolean | null;
}

/** Registry name for a worktree path, or null for a tree rt doesn't manage. */
function treeNameFor(path: string): string | null {
  const hit = findTreeByPath(path) ?? findTreeByPath(canon(path));
  return hit?.tree ?? null;
}

/**
 * Attributes the LISTEN on `port` to the claiming worktree or not. Ownership
 * is the listener pid being the claim's own pid, or its cwd sitting inside
 * the claiming worktree — pid equality alone is not required because the
 * claiming shim usually spawns the real server as a child.
 */
async function attributeListener(
  probes: Probes,
  port: number,
  claimWorktree: string,
  claimPid: number | undefined,
): Promise<ListenerReport | null> {
  if (!probes.listeners.has(port)) return null;
  const info = probes.listenerOf(port);
  if (!info) return null;
  const cwd = await probes.pidCwd(info.pid);
  let ownsClaim: boolean | null;
  if (claimPid !== undefined && info.pid === claimPid) {
    ownsClaim = true;
  } else if (cwd !== undefined) {
    const wt = canon(claimWorktree);
    const listenerCwd = canon(cwd);
    ownsClaim = listenerCwd === wt || listenerCwd.startsWith(wt + "/");
  } else {
    ownsClaim = null;
  }
  return { pid: info.pid, command: info.command, cwd: cwd ?? null, ownsClaim };
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
  ctx: Pick<HandlerContext, "log" | "repoIndex">,
  deps?: { probes?: () => Promise<Probes> },
): Record<"endpoint:claim" | "endpoint:lookup" | "endpoint:release" | "endpoint:status", (payload: any) => Promise<any>> & HandlerMap {
  const probesFn = deps?.probes ?? defaultProbes;

  return {
    "endpoint:claim": async (payload) => {
      const worktree = payload?.worktree;
      const role = payload?.role;
      const pid: number | undefined = payload?.pid;
      if (!payload?.repo || !worktree || !role) return { ok: false, error: "missing repo, worktree, or role" };
      // Hard cutover: endpoint_claims is identity-keyed now; a bare
      // legacy repo resolves nothing rather than claiming under a key the
      // store will never be read back under.
      const decoded = decodeRepo(payload);
      if (!decoded.ok) return decoded;
      const repo = decoded.repo;

      const repoCfg = loadEndpointConfig({ repoIdentity: await repoIdentityFor(ctx, repo), repoName: repo });
      const roleCfg = repoCfg.roles[role];
      if (!roleCfg) return { ok: false, error: `role "${role}" is not declared for repo "${repo}"` };

      const probes = await probesFn();

      // load → compute → save, all synchronous once `probes` resolves (no
      // further await between them): nothing else can interleave on this
      // event loop between the load and the save, so there is no lost-update
      // window here to guard against.
      const claims = loadClaims(repo);
      const res = resolveRoleAndNeeds(claims, repoCfg, repo, worktree, role, roleCfg, pid, probes);
      if ("error" in res) return { ok: false, error: res.error };
      const applied = res;
      saveClaims(repo, res.claims);

      if (applied.changed) {
        ctx.log.debug({ repo, worktree, role, port: applied.port }, "endpoint claimed");
      }

      return {
        ok: true,
        data: { role, port: applied.port, url: url(applied.port), refs: applied.refs },
      };
    },

    "endpoint:lookup": async (payload) => {
      const worktree = payload?.worktree;
      const role = payload?.role;
      if (!payload?.repo || !worktree || !role) return { ok: false, error: "missing repo, worktree, or role" };
      const resolvedWorktree = { path: worktree, name: treeNameFor(worktree) };
      const decoded = decodeRepo(payload);
      if (!decoded.ok) {
        return { ok: true, data: { claimed: false, port: null, url: null, running: false, worktree: resolvedWorktree, listener: null } };
      }
      const repo = decoded.repo;

      const repoCfg = loadEndpointConfig({ repoIdentity: await repoIdentityFor(ctx, repo), repoName: repo });
      const roleCfg = repoCfg.roles[role];
      if (!roleCfg) return { ok: false, error: `role "${role}" is not declared for repo "${repo}"` };

      const probes = await probesFn();

      if (roleCfg.fixedPort !== undefined) {
        const port = roleCfg.fixedPort;
        // No claim row for a fixed port — attribution runs against the
        // requesting worktree, which is what "mine" means to the caller.
        const listener = await attributeListener(probes, port, worktree, undefined);
        return {
          ok: true,
          data: { claimed: true, port, url: url(port), running: probes.listeners.has(port), worktree: resolvedWorktree, listener },
        };
      }

      const claim = loadClaims(repo).find((c) => c.worktree === worktree && c.role === role);
      if (!claim) return { ok: true, data: { claimed: false, port: null, url: null, running: false, worktree: resolvedWorktree, listener: null } };

      const listener = await attributeListener(probes, claim.port, claim.worktree, claim.pid);
      return {
        ok: true,
        data: {
          claimed: true,
          port: claim.port,
          url: url(claim.port),
          running: isLiveClaim(claim, probes),
          worktree: resolvedWorktree,
          listener,
        },
      };
    },

    "endpoint:release": async (payload) => {
      const worktree = payload?.worktree;
      const role = payload?.role;
      if (!payload?.repo || !worktree) return { ok: false, error: "missing repo or worktree" };
      const decoded = decodeRepo(payload);
      if (!decoded.ok) return { ok: true, data: { released: 0 } };
      const repo = decoded.repo;

      const { claims: remaining, released } = releaseWorktree(loadClaims(repo), worktree, role);
      if (released.length > 0) saveClaims(repo, remaining);
      return { ok: true, data: { released: released.length } };
    },

    "endpoint:status": async (payload) => {
      let repoFilter: string | undefined = payload?.repo;
      if (repoFilter) {
        const decoded = decodeRepo(payload);
        if (!decoded.ok) return { ok: true, data: { repos: {} } };
        repoFilter = decoded.repo;
      }
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
