import { describe, test, expect } from "bun:test";
import { createStatusHandlers } from "../handlers/status.ts";

function fakeCtx(): any {
  return {
    startedAt: 123,
    identity: { flavor: "dev", version: "source", sourceRev: "abc1234", startedAt: 123 },
    watchedConfigs: new Map(),
    cache: { entries: {} },
    portCacheRef: { ports: [], updatedAt: null },
  };
}

describe("daemon identity", () => {
  test("ping carries flavor/version/sourceRev", async () => {
    const h = createStatusHandlers(fakeCtx());
    const res = await h["ping"]!({}, undefined as any);
    expect(res).toMatchObject({ ok: true, flavor: "dev", version: "source", sourceRev: "abc1234" });
  });

  test("status.data carries the identity object", async () => {
    const h = createStatusHandlers(fakeCtx());
    const res = (await h["status"]!({}, undefined as any)) as any;
    expect(res.data.identity).toEqual({ flavor: "dev", version: "source", sourceRev: "abc1234", startedAt: 123 });
  });
});
