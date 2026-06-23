/**
 * Lazily (re)bind forward-endpoint proxies. Within a running daemon a process
 * keeps a stable rt-assigned port across respawn, but after a daemon restart the
 * in-memory proxies are gone and processes are not running yet; when a mapped
 * process next reaches "running", bind its forward proxy. Pure: effects injected.
 */
import { endpointProxyId } from "./handlers/endpoints.ts";
import type { CanonicalEndpoint, EndpointState } from "../endpoints-config.ts";

export interface ForwardReconcileDeps {
  repos: string[];
  loadEndpoints: (repo: string) => CanonicalEndpoint[];
  loadState: (repo: string) => EndpointState;
  upstreamPortOf: (processId: string) => number | undefined;
  startForward: (proxyId: string, canonicalPort: number, upstreamPort: number) => void;
}

export function reconcileForwardForProcess(processId: string, deps: ForwardReconcileDeps): number {
  let n = 0;
  for (const repo of deps.repos) {
    const state = deps.loadState(repo);
    for (const [portStr, pid] of Object.entries(state.forward)) {
      if (pid !== processId) continue;
      const port = Number(portStr);
      const ep = deps.loadEndpoints(repo).find((e) => e.port === port && e.mode === "forward");
      if (!ep) continue;
      const up = deps.upstreamPortOf(processId);
      if (!up) continue;
      deps.startForward(endpointProxyId(repo, port), port, up);
      n++;
    }
  }
  return n;
}
