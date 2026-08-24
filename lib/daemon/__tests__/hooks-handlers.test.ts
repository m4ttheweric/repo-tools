import { describe, expect, test } from "bun:test";
import { createHooksHandlers } from "../handlers/hooks.ts";
import type { HandlerContext } from "../handlers/types.ts";

function fakeCtx(repos: Record<string, string> = {}): HandlerContext {
  return {
    repoIndex: () => repos,
    checkAndRepairHooksPath: async () => true,
    startWatchingRepo: () => {},
  } as unknown as HandlerContext;
}

describe("hooks handlers — identity-only guard", () => {
  test("hooks:status refuses a bare display name, same as every other repo-keyed verb", async () => {
    const h = createHooksHandlers(fakeCtx());
    const res = await h["hooks:status"]!({ repo: "repo" });
    expect(res.ok).toBe(true);
    expect((res as { data: unknown }).data).toBeNull();
  });

  test("hooks:repair refuses a bare display name", async () => {
    const h = createHooksHandlers(fakeCtx());
    const res = await h["hooks:repair"]!({ repo: "repo" });
    expect(res.ok).toBe(true);
    expect((res as { repaired: boolean }).repaired).toBe(false);
  });

  test("hooks:watch refuses a bare display name and never starts a watch", async () => {
    let watched = false;
    const ctx = fakeCtx({ "path:/repo": "/repo" });
    ctx.startWatchingRepo = () => { watched = true; };
    const h = createHooksHandlers(ctx);

    const res = await h["hooks:watch"]!({ repo: "repo" });

    expect(res.ok).toBe(true);
    expect(watched).toBe(false);
  });

  test("hooks:watch accepts a serialized identity and starts the watch", async () => {
    let watchedName: string | null = null;
    const ctx = fakeCtx({ "path:/repo": "/repo" });
    ctx.startWatchingRepo = (repoName: string) => { watchedName = repoName; };
    const h = createHooksHandlers(ctx);

    const res = await h["hooks:watch"]!({ repo: "path:/repo" });

    expect(res.ok).toBe(true);
    // Cast: TS narrows watchedName to null (its initializer) because the
    // mutating assignment lives in a closure it can't prove ran.
    expect(watchedName as string | null).toBe("path:/repo");
  });
});
