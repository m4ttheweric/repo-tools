import { describe, test, expect } from "bun:test";
import { restoreEndpoints } from "../endpoint-restore.ts";
import { endpointProxyId, bounceEndpointId } from "../handlers/endpoints.ts";

test("restores forward proxies for running targets and enabled bounces", () => {
  const fwd: any[] = [];
  const bnc: any[] = [];
  const result = restoreEndpoints({
    repos: ["r"],
    loadEndpoints: () => [
      { port: 4000, name: "app", mode: "forward" },
      { port: 4001, name: "auth", mode: "bounce", returnParam: "rt_return" },
    ],
    loadState: () => ({ forward: { "4000": "wt:dev" }, bounceEnabled: [4001] }),
    upstreamPortOf: (id) => (id === "wt:dev" ? 10001 : undefined),
    startForward: (proxyId, canonicalPort, upstreamPort) => fwd.push([proxyId, canonicalPort, upstreamPort]),
    startBounce: (bounceId, canonicalPort, returnParam) => bnc.push([bounceId, canonicalPort, returnParam]),
  });
  expect(fwd).toEqual([[endpointProxyId("r", 4000), 4000, 10001]]);
  expect(bnc).toEqual([[bounceEndpointId("r", 4001), 4001, "rt_return"]]);
  expect(result).toEqual({ forward: 1, bounce: 1 });
});

test("skips a forward mapping whose target is not running", () => {
  const fwd: any[] = [];
  const result = restoreEndpoints({
    repos: ["r"],
    loadEndpoints: () => [{ port: 4000, name: "app", mode: "forward" }],
    loadState: () => ({ forward: { "4000": "wt:dev" }, bounceEnabled: [] }),
    upstreamPortOf: () => undefined, // not running
    startForward: (...a) => fwd.push(a),
    startBounce: () => {},
  });
  expect(fwd).toEqual([]);
  expect(result).toEqual({ forward: 0, bounce: 0 });
});

test("skips a bounce port with no matching declared endpoint", () => {
  const bnc: any[] = [];
  const result = restoreEndpoints({
    repos: ["r"],
    loadEndpoints: () => [], // nothing declared
    loadState: () => ({ forward: {}, bounceEnabled: [4001] }),
    upstreamPortOf: () => undefined,
    startForward: () => {},
    startBounce: (...a) => bnc.push(a),
  });
  expect(bnc).toEqual([]);
  expect(result).toEqual({ forward: 0, bounce: 0 });
});
