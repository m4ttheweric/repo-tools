/**
 * Canonical-endpoint boot wiring — restores forward proxies + bounce relays
 * after a daemon restart, and lazily (re)binds forward proxies when their
 * target process reaches "running".
 *
 * In-memory servers do not survive restarts; restoreEndpoints skips forward
 * mappings whose target process is not yet running, so wireForwardReconcile
 * picks those up when the process finally starts.
 */

import type { Logger } from "pino";
import { restoreEndpoints } from "./endpoint-restore.ts";
import { reconcileForwardForProcess } from "./forward-reconcile.ts";
import { loadEndpoints, loadEndpointState } from "../endpoints-config.ts";
import type { StateStore } from "./state-store.ts";
import type { ProxyManager } from "./proxy-manager.ts";
import type { BounceManager } from "./bounce-manager.ts";
import type { RepoIndex } from "./handlers/types.ts";

export interface EndpointWiringDeps {
  stateStore: StateStore;
  /** ProcessManager or HerdrProcessManager (structural: getSpawnConfig). */
  processManager: any;
  proxyManager: ProxyManager;
  bounceManager: BounceManager;
  repoIndex: () => RepoIndex;
  repoDataDirOf: (repo: string) => string;
  liveOriginsFor: (repo: string) => () => Set<string>;
  log: Logger;
}

/**
 * The live upstream port for a process: rt assigns a stable app port
 * (--app-port) reused on respawn, so the stored env.PORT is the upstream —
 * but only while the process is actually running.
 */
function upstreamPortOf(deps: EndpointWiringDeps, id: string): number | undefined {
  if (deps.stateStore.getState(id) !== "running") return undefined;
  const p = Number(deps.processManager.getSpawnConfig(id)?.env?.PORT);
  return Number.isFinite(p) ? p : undefined;
}

/** Restore endpoints that were active before this daemon restart. */
export function restoreEndpointsOnBoot(deps: EndpointWiringDeps): void {
  const { proxyManager, bounceManager, repoDataDirOf, log } = deps;
  try {
    const restored = restoreEndpoints({
      repos: Object.keys(deps.repoIndex()),
      loadEndpoints: (repo) => loadEndpoints(repoDataDirOf(repo)),
      loadState: (repo) => loadEndpointState(repoDataDirOf(repo)),
      upstreamPortOf: (id) => upstreamPortOf(deps, id),
      startForward: (proxyId, canonicalPort, upstreamPort) => {
        try { proxyManager.start(proxyId, canonicalPort, upstreamPort, "endpoint:restore"); } catch { /* already bound */ }
      },
      startBounce: (bounceId, canonicalPort, returnParam) => {
        // bounceId encodes the repo as the middle segment: "bounce:<repo>:<port>"
        const repo = bounceId.split(":")[1] ?? "";
        try {
          bounceManager.start(bounceId, canonicalPort, { returnParam, allowedOrigins: deps.liveOriginsFor(repo) });
        } catch { /* already bound */ }
      },
    });
    log.info({ restored }, "restored canonical endpoints");
  } catch (err) {
    log.error({ err }, "endpoint restore failed");
  }
}

/** Bind forward proxies as their target processes reach "running". */
export function wireForwardReconcile(deps: EndpointWiringDeps): void {
  const { stateStore, proxyManager, repoDataDirOf } = deps;
  stateStore.onStateChange((id, _prev, next) => {
    if (next !== "running") return;
    reconcileForwardForProcess(id, {
      repos: Object.keys(deps.repoIndex()),
      loadEndpoints: (repo) => loadEndpoints(repoDataDirOf(repo)),
      loadState: (repo) => loadEndpointState(repoDataDirOf(repo)),
      upstreamPortOf: (pid) => upstreamPortOf(deps, pid),
      startForward: (proxyId, canonicalPort, upstreamPort) => {
        try { proxyManager.start(proxyId, canonicalPort, upstreamPort, "endpoint:reconcile"); } catch { /* already bound */ }
      },
    });
  });
}
