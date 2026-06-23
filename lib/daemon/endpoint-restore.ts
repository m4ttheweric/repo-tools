/**
 * Re-establish canonical endpoints after a daemon restart (the in-memory proxy
 * and bounce servers do not survive a restart). Pure: all effects injected.
 * Within a running daemon a process restart needs no re-point, because rt
 * assigns a stable port (--app-port) that is reused on respawn.
 */
import { endpointProxyId, bounceEndpointId } from "./handlers/endpoints.ts";
import type { CanonicalEndpoint, EndpointState } from "../endpoints-config.ts";

export interface RestoreDeps {
  repos: string[];
  loadEndpoints: (repo: string) => CanonicalEndpoint[];
  loadState: (repo: string) => EndpointState;
  /** Running target's upstream port, or undefined if not running. */
  upstreamPortOf: (processId: string) => number | undefined;
  startForward: (proxyId: string, canonicalPort: number, upstreamPort: number) => void;
  startBounce: (bounceId: string, canonicalPort: number, returnParam: string) => void;
}

export function restoreEndpoints(deps: RestoreDeps): { forward: number; bounce: number } {
  let forward = 0;
  let bounce = 0;
  for (const repo of deps.repos) {
    const eps = deps.loadEndpoints(repo);
    const state = deps.loadState(repo);
    for (const [portStr, processId] of Object.entries(state.forward)) {
      const port = Number(portStr);
      const ep = eps.find((e) => e.port === port && e.mode === "forward");
      if (!ep) continue;
      const up = deps.upstreamPortOf(processId);
      if (!up) continue;
      deps.startForward(endpointProxyId(repo, port), port, up);
      forward++;
    }
    for (const port of state.bounceEnabled) {
      const ep = eps.find((e) => e.port === port && e.mode === "bounce");
      if (!ep) continue;
      deps.startBounce(bounceEndpointId(repo, port), port, ep.returnParam ?? "rt_return");
      bounce++;
    }
  }
  return { forward, bounce };
}
