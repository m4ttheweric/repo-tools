import { describe, test, expect } from "bun:test";
import { reconcileForwardForProcess } from "../forward-reconcile.ts";
import { endpointProxyId } from "../handlers/endpoints.ts";

const eps = () => [{ port: 4000, name: "app", mode: "forward" as const }];

test("binds the forward proxy for a matching, running process", () => {
  const calls: any[] = [];
  const n = reconcileForwardForProcess("wt:dev", {
    repos: ["r"], loadEndpoints: eps,
    loadState: () => ({ forward: { "4000": "wt:dev" }, bounceEnabled: [] }),
    upstreamPortOf: (id) => (id === "wt:dev" ? 10001 : undefined),
    startForward: (...a) => calls.push(a),
  });
  expect(calls).toEqual([[endpointProxyId("r", 4000), 4000, 10001]]);
  expect(n).toBe(1);
});

test("does nothing for a process with no forward mapping", () => {
  const calls: any[] = [];
  const n = reconcileForwardForProcess("other", {
    repos: ["r"], loadEndpoints: eps,
    loadState: () => ({ forward: { "4000": "wt:dev" }, bounceEnabled: [] }),
    upstreamPortOf: () => 10001,
    startForward: (...a) => calls.push(a),
  });
  expect(calls).toEqual([]);
  expect(n).toBe(0);
});

test("skips when the upstream port is unknown", () => {
  const calls: any[] = [];
  const n = reconcileForwardForProcess("wt:dev", {
    repos: ["r"], loadEndpoints: eps,
    loadState: () => ({ forward: { "4000": "wt:dev" }, bounceEnabled: [] }),
    upstreamPortOf: () => undefined,
    startForward: (...a) => calls.push(a),
  });
  expect(calls).toEqual([]);
  expect(n).toBe(0);
});
