/**
 * cache:read's read contract (S069/Task 10): the store keys `ctx.cache.entries`
 * by the composite `${identity}:${branch}` now, but cache:read's OUTPUT must
 * stay keyed by the bare branch, never a composite key, so the CLI/board/
 * tray see exactly the same shape they always have. An absent `repoIdentity`
 * falls back to a suffix match across repos; a present one scopes exactly.
 */
import { describe, test, expect } from "bun:test";
import { createCacheHandlers } from "../handlers/cache.ts";
import { composeKey } from "../../state/branch-cache.ts";
import { fakeStore } from "./fake-cache-store.ts";

function makeCtx(entries: Record<string, any>) {
  const ctx = {
    cache: fakeStore(entries),
    refreshCache: async () => {},
  } as any;
  return createCacheHandlers(ctx);
}

describe("cache:read: bare-branch output", () => {
  test("an unfiltered read returns bare-branch keys, never the store's composite keys", async () => {
    const entries = {
      [composeKey("remote:host%2Fa", "main")]: { linearId: "A", ticket: null, mr: null, fetchedAt: 1 },
    };
    const handlers = makeCtx(entries);

    const res = await handlers["cache:read"]!({});

    expect(Object.keys(res.data)).toEqual(["main"]);
    expect(res.data.main.linearId).toBe("A");
  });

  test("a filtered read (branches list) resolves a bare branch by suffix match when repoIdentity is absent", async () => {
    const entries = {
      [composeKey("remote:host%2Fa", "main")]: { linearId: "A", ticket: null, mr: null, fetchedAt: 1 },
    };
    const handlers = makeCtx(entries);

    const res = await handlers["cache:read"]!({ branches: ["main"] });

    expect(Object.keys(res.data)).toEqual(["main"]);
    expect(res.data.main.linearId).toBe("A");
  });

  test("two repos sharing a branch name: an unscoped read picks one entry, never crashes or merges them", async () => {
    const entries = {
      [composeKey("remote:host%2Fa", "main")]: { linearId: "A", ticket: null, mr: null, fetchedAt: 1 },
      [composeKey("remote:host%2Fb", "main")]: { linearId: "B", ticket: null, mr: null, fetchedAt: 2 },
    };
    const handlers = makeCtx(entries);

    const res = await handlers["cache:read"]!({ branches: ["main"] });

    expect(Object.keys(res.data)).toEqual(["main"]);
    expect(["A", "B"]).toContain(res.data.main.linearId);
  });

  test("an explicit repoIdentity scopes exactly, disambiguating two repos sharing a branch name", async () => {
    const entries = {
      [composeKey("remote:host%2Fa", "main")]: { linearId: "A", ticket: null, mr: null, fetchedAt: 1 },
      [composeKey("remote:host%2Fb", "main")]: { linearId: "B", ticket: null, mr: null, fetchedAt: 2 },
    };
    const handlers = makeCtx(entries);

    const res = await handlers["cache:read"]!({ branches: ["main"], repoIdentity: "remote:host%2Fb" });

    expect(res.data.main.linearId).toBe("B");
  });
});
