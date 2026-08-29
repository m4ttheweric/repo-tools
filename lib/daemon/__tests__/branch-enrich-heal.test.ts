import { describe, test, expect } from "bun:test";
import { createCacheHandlers } from "../handlers/cache.ts";
import { fakeStore } from "./fake-cache-store.ts";

const HOUR = 60 * 60 * 1000;

function makeCtx(entries: Record<string, any>) {
  const ctx = { cache: fakeStore(entries), refreshCache: async () => {} } as any;
  return ctx;
}

describe("branch:enrich heals an entry whose ticket never resolved", () => {
  test("a complete entry is served from cache without re-enriching", async () => {
    const ctx = makeCtx({
      b: { linearId: "ACME-1", ticket: { identifier: "ACME-1" }, mr: null, fetchedAt: Date.now() - HOUR },
    });
    const res = await createCacheHandlers(ctx)["branch:enrich"]!({ branch: "b", repoPath: "/tmp/x" }) as any;
    expect(res.ok).toBe(true);
    expect(res.source).toBe("cache");
  });

  test("an entry with no linear id at all stays a cache hit", async () => {
    // Nothing to resolve: re-enriching would spend a lookup per read forever.
    const ctx = makeCtx({ b: { linearId: null, ticket: null, mr: null, fetchedAt: 1 } });
    const res = await createCacheHandlers(ctx)["branch:enrich"]!({ branch: "b", repoPath: "/tmp/x" }) as any;
    expect(res.source).toBe("cache");
  });

  test("healing forces a refresh, since enrichBranches also short-circuits on a cached branch", async () => {
    let opts: any = null;
    const ctx = makeCtx({
      b: { linearId: "ACME-1", ticket: null, mr: null, fetchedAt: Date.now() - HOUR },
    });
    await createCacheHandlers(ctx)["branch:enrich"]!({
      branch: "b",
      repoPath: "/tmp/x",
      enrich: async (_b: unknown, _r: unknown, o: unknown) => {
        opts = o;
        ctx.cache.entries.b.ticket = { identifier: "ACME-1" };
      },
    });
    expect(opts?.forceRefresh).toBe(true);
  });

  test("an id resolved but no ticket is INCOMPLETE, and re-enriches", async () => {
    const ctx = makeCtx({
      b: { linearId: "ACME-1", ticket: null, mr: null, fetchedAt: Date.now() - HOUR },
    });
    const res = await createCacheHandlers(ctx)["branch:enrich"]!({
      branch: "b",
      repoPath: "/tmp/x",
      // The enricher is injected so the test never reaches the network.
      enrich: async () => {
        ctx.cache.entries.b.ticket = { identifier: "ACME-1", title: "t", url: "u" };
      },
    }) as any;
    expect(res.source).toBe("fresh");
    expect(res.data.ticket.identifier).toBe("ACME-1");
  });

  test("a recent incomplete entry is not retried, so a genuinely missing ticket costs one lookup", async () => {
    let calls = 0;
    const ctx = makeCtx({
      b: { linearId: "ACME-1", ticket: null, mr: null, fetchedAt: Date.now() - 1_000 },
    });
    const res = await createCacheHandlers(ctx)["branch:enrich"]!({
      branch: "b",
      repoPath: "/tmp/x",
      enrich: async () => {
        calls++;
      },
    }) as any;
    expect(calls).toBe(0);
    expect(res.source).toBe("cache");
  });
});
