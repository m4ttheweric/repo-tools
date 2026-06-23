// lib/daemon/__tests__/endpoints-handlers.test.ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createEndpointHandlers, endpointProxyId } from "../handlers/endpoints.ts";

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
