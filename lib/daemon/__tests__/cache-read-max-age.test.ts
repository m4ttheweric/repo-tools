import { describe, test, expect } from "bun:test";
import { createCacheHandlers } from "../handlers/cache.ts";

function makeCtx(entries: Record<string, any>) {
  const state = { refreshes: 0 };
  const ctx = {
    cache: { entries },
    refreshCache: async () => {
      state.refreshes++;
      // Simulate the refresh updating entries in place (loadCache reload).
      for (const e of Object.values(entries)) (e as any).fetchedAt = Date.now();
    },
  } as any;
  return { ctx, state };
}

describe("cache:read maxAgeMs", () => {
  test("absent maxAgeMs never refreshes", async () => {
    const { ctx, state } = makeCtx({ a: { fetchedAt: 1 } });
    const handlers = createCacheHandlers(ctx);
    const res = await handlers["cache:read"]!({});
    expect(res.ok).toBe(true);
    expect(state.refreshes).toBe(0);
  });

  test("fresh entries within maxAgeMs skip the refresh", async () => {
    const { ctx, state } = makeCtx({ a: { fetchedAt: Date.now() } });
    const handlers = createCacheHandlers(ctx);
    await handlers["cache:read"]!({ maxAgeMs: 60_000 });
    expect(state.refreshes).toBe(0);
  });

  test("a stale entry triggers an awaited refresh before answering", async () => {
    const { ctx, state } = makeCtx({ a: { fetchedAt: Date.now() - 120_000 } });
    const handlers = createCacheHandlers(ctx);
    const res = await handlers["cache:read"]!({ maxAgeMs: 60_000 });
    expect(state.refreshes).toBe(1);
    expect(res.data.a.fetchedAt).toBeGreaterThan(Date.now() - 5_000); // answered post-refresh
  });

  test("maxAgeMs 0 always refreshes", async () => {
    const { ctx, state } = makeCtx({ a: { fetchedAt: Date.now() } });
    const handlers = createCacheHandlers(ctx);
    await handlers["cache:read"]!({ maxAgeMs: 0 });
    expect(state.refreshes).toBe(1);
  });

  test("staleness is judged only across requested branches", async () => {
    const { ctx, state } = makeCtx({
      fresh: { fetchedAt: Date.now() },
      stale: { fetchedAt: 1 },
    });
    const handlers = createCacheHandlers(ctx);
    await handlers["cache:read"]!({ branches: ["fresh"], maxAgeMs: 60_000 });
    expect(state.refreshes).toBe(0);
    await handlers["cache:read"]!({ branches: ["stale"], maxAgeMs: 60_000 });
    expect(state.refreshes).toBe(1);
  });

  test("a requested branch missing from the cache counts as infinitely stale", async () => {
    const { ctx, state } = makeCtx({ a: { fetchedAt: Date.now() } });
    const handlers = createCacheHandlers(ctx);
    await handlers["cache:read"]!({ branches: ["a", "unknown"], maxAgeMs: 60_000 });
    expect(state.refreshes).toBe(1);
  });

  test("an empty cache with no filter counts as stale", async () => {
    const { ctx, state } = makeCtx({});
    const handlers = createCacheHandlers(ctx);
    await handlers["cache:read"]!({ maxAgeMs: 60_000 });
    expect(state.refreshes).toBe(1);
  });
});
