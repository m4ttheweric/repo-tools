// lib/daemon/__tests__/endpoints-handlers.test.ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createEndpointHandlers, endpointProxyId, bounceEndpointId } from "../handlers/endpoints.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rt-eph-"));
  writeFileSync(join(dir, "endpoints.json"), JSON.stringify({
    endpoints: [{ port: 4000, name: "app", mode: "forward" }],
  }));
  const proxyCalls: any[] = [];
  const ctx = {
    repoDataDirOf: () => dir,
    proxyManager: {
      start: (id: string, c: number, u: number, who: string) => proxyCalls.push(["start", id, c, u, who]),
      stop: (id: string) => proxyCalls.push(["stop", id]),
    },
  };
  return { dir, ctx, proxyCalls, handlers: createEndpointHandlers(ctx as any) };
}

describe("endpoints:list", () => {
  test("returns declared endpoints + state", async () => {
    const { dir, handlers } = setup();
    try {
      const res = await handlers["endpoints:list"]!({ repo: "r" });
      expect(res.ok).toBe(true);
      expect(res.data.endpoints).toEqual([{ port: 4000, name: "app", mode: "forward" }]);
      expect(res.data.state).toEqual({ forward: {}, bounceEnabled: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("endpoints:map (forward)", () => {
  test("starts a proxy and records the mapping", async () => {
    const { dir, handlers, proxyCalls } = setup();
    try {
      const res = await handlers["endpoints:map"]!({ repo: "r", port: 4000, processId: "wt:dev", upstreamPort: 4123 });
      expect(res.ok).toBe(true);
      expect(proxyCalls).toEqual([["start", endpointProxyId("r", 4000), 4000, 4123, "endpoint:r"]]);
      const after = await handlers["endpoints:list"]!({ repo: "r" });
      expect(after.data.state.forward).toEqual({ "4000": "wt:dev" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("rejects an unknown or non-forward port", async () => {
    const { dir, handlers } = setup();
    try {
      const res = await handlers["endpoints:map"]!({ repo: "r", port: 9999, processId: "x", upstreamPort: 1 });
      expect(res.ok).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("endpoints:unmap", () => {
  test("stops the proxy and clears the mapping", async () => {
    const { dir, handlers, proxyCalls } = setup();
    try {
      await handlers["endpoints:map"]!({ repo: "r", port: 4000, processId: "wt:dev", upstreamPort: 4123 });
      const res = await handlers["endpoints:unmap"]!({ repo: "r", port: 4000 });
      expect(res.ok).toBe(true);
      expect(proxyCalls).toContainEqual(["stop", endpointProxyId("r", 4000)]);
      const after = await handlers["endpoints:list"]!({ repo: "r" });
      expect(after.data.state.forward).toEqual({});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("endpoints:bounce-enable / disable", () => {
  function bounceSetup() {
    const dir = mkdtempSync(join(tmpdir(), "rt-eph-"));
    writeFileSync(join(dir, "endpoints.json"), JSON.stringify({
      endpoints: [{ port: 4001, name: "auth", mode: "bounce", returnParam: "rt_return" }],
    }));
    const calls: any[] = [];
    const ctx = {
      repoDataDirOf: () => dir,
      proxyManager: { start() {}, stop() {} },
      bounceManager: {
        start: (id: string, port: number, _deps: any) => calls.push(["start", id, port]),
        stop: (id: string) => calls.push(["stop", id]),
      },
      liveOriginsFor: () => () => new Set<string>(),
    };
    return { dir, calls, handlers: createEndpointHandlers(ctx as any) };
  }

  test("enable starts a bounce and records the port", async () => {
    const { dir, calls, handlers } = bounceSetup();
    try {
      const res = await handlers["endpoints:bounce-enable"]!({ repo: "r", port: 4001 });
      expect(res.ok).toBe(true);
      expect(calls).toEqual([["start", bounceEndpointId("r", 4001), 4001]]);
      const after = await handlers["endpoints:list"]!({ repo: "r" });
      expect(after.data.state.bounceEnabled).toEqual([4001]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("enable rejects an unknown or non-bounce port", async () => {
    const { dir, handlers } = bounceSetup();
    try {
      expect((await handlers["endpoints:bounce-enable"]!({ repo: "r", port: 9999 })).ok).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("disable stops the bounce and clears the port", async () => {
    const { dir, calls, handlers } = bounceSetup();
    try {
      await handlers["endpoints:bounce-enable"]!({ repo: "r", port: 4001 });
      const res = await handlers["endpoints:bounce-disable"]!({ repo: "r", port: 4001 });
      expect(res.ok).toBe(true);
      expect(calls).toContainEqual(["stop", bounceEndpointId("r", 4001)]);
      const after = await handlers["endpoints:list"]!({ repo: "r" });
      expect(after.data.state.bounceEnabled).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
