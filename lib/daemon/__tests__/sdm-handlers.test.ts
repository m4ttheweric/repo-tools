import { describe, test, expect } from "bun:test";
import { createSdmHandlers, type SdmHandlerDeps } from "../handlers/sdm.ts";
import type { HandlerContext } from "../handlers/types.ts";
import type { SdmSnapshot } from "../../sdm/core.ts";

const ctx = { log: { info: () => {}, warn: () => {}, debug: () => {} } } as unknown as HandlerContext;

function okSnapshot(): SdmSnapshot {
  return {
    health: { status: "ok", message: null },
    resources: new Map([["example-alpha-staging", { connected: true, address: "127.0.0.1:15432", expiry: null }]]),
  };
}

function makeDeps(overrides: Partial<SdmHandlerDeps> = {}): SdmHandlerDeps {
  return {
    discover: async () => ({
      connections: [{ id: "a", label: "A", sdmResource: "example-a", key: "demo:a", connector: "demo" }],
      errors: [],
      fromCache: false,
    }),
    getSnapshot: async () => okSnapshot(),
    loadState: () => ({
      version: 1,
      recents: [{
        key: "demo:alpha", label: "Alpha", sdmResource: "example-alpha-staging",
        tier: "staging", reasonSuggestion: "investigating alpha staging data",
        lastConnectedAt: "2026-07-01T00:00:00.000Z",
      }],
    }),
    needsAccessRequest: async () => false,
    connect: async () => ({ ok: true }),
    verify: async () => ({ ok: true, attempts: 1, latencyMs: 12, lastError: null }),
    recordRecent: () => ({ version: 1, recents: [] }),
    ...overrides,
  };
}

describe("sdm handlers", () => {
  test("sdm:catalog returns connections and errors", async () => {
    const h = createSdmHandlers(ctx, makeDeps());
    const r = await h["sdm:catalog"]!({});
    expect(r.ok).toBe(true);
    expect(r.connections).toHaveLength(1);
  });

  test("sdm:snapshot serializes resources as a plain object", async () => {
    const h = createSdmHandlers(ctx, makeDeps());
    const r = await h["sdm:snapshot"]!({});
    expect(r.ok).toBe(true);
    expect(r.health.status).toBe("ok");
    expect(r.resources["example-alpha-staging"].address).toBe("127.0.0.1:15432");
    expect(JSON.parse(JSON.stringify(r)).resources["example-alpha-staging"].connected).toBe(true);
  });

  test("sdm:recents joins live connected state", async () => {
    const h = createSdmHandlers(ctx, makeDeps());
    const r = await h["sdm:recents"]!({});
    expect(r.ok).toBe(true);
    expect(r.recents[0].connected).toBe(true);
  });

  test("sdm:reconnect refuses when an access request is needed", async () => {
    const h = createSdmHandlers(ctx, makeDeps({ needsAccessRequest: async () => true }));
    const r = await h["sdm:reconnect"]!({ key: "demo:alpha" });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("needs-access-request");
  });

  test("sdm:reconnect connects, verifies, and returns the address", async () => {
    let recorded: any;
    const h = createSdmHandlers(ctx, makeDeps({
      recordRecent: entry => {
        recorded = entry;
        return { version: 1, recents: [] };
      },
    }));
    const r = await h["sdm:reconnect"]!({ key: "demo:alpha" });
    expect(r.ok).toBe(true);
    expect(r.address).toBe("127.0.0.1:15432");
    expect(recorded.tier).toBe("staging");
    expect(recorded.reasonSuggestion).toBe("investigating alpha staging data");
  });

  test("sdm:reconnect rejects an unknown key", async () => {
    const h = createSdmHandlers(ctx, makeDeps());
    const r = await h["sdm:reconnect"]!({ key: "nope:missing" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unknown");
  });
});
