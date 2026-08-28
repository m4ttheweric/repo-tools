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

  test("ping carries a supervision summary (Task 10)", async () => {
    const h = createStatusHandlers(fakeCtx());
    const res = (await h["ping"]!({}, undefined as any)) as any;
    // Loose on values deliberately: daemon-supervision kv is process-wide
    // (lib/daemon/supervision-state.ts, `getStateDb("daemon")`), so this test
    // sharing a `bun test` process with supervision-state.test.ts can see
    // whatever that suite last wrote. The shape/cap is what this test owns.
    expect(typeof res.supervision.bootAttempts).toBe("number");
    expect(typeof res.supervision.lastReadyAt).toBe("number");
    expect(Array.isArray(res.supervision.recentFailures)).toBe(true);
    expect(res.supervision.recentFailures.length).toBeLessThanOrEqual(3);
    expect(res.supervision.lastExit === null || typeof res.supervision.lastExit === "object").toBe(true);
  });

  test("status.data carries the identity object", async () => {
    const h = createStatusHandlers(fakeCtx());
    const res = (await h["status"]!({}, undefined as any)) as any;
    expect(res.data.identity).toEqual({ flavor: "dev", version: "source", sourceRev: "abc1234", startedAt: 123 });
  });
});
