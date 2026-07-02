import { describe, test, expect } from "bun:test";
import {
  probeTunnel,
  probeQuery,
  verifyWithRetries,
  buildPostgresUrl,
  type ProbeResult,
} from "../verify.ts";

describe("probeTunnel", () => {
  test("succeeds against a listening socket", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const r = await probeTunnel("127.0.0.1", server.port);
      expect(r.ok).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("fails fast against a closed port", async () => {
    const r = await probeTunnel("127.0.0.1", 1, 1_000);
    expect(r.ok).toBe(false);
  });
});

describe("probeQuery", () => {
  test("resolves ok:false quickly for a port nobody listens on", async () => {
    const start = Date.now();
    const r = await probeQuery("postgres://postgres@127.0.0.1:1/postgres", 1_500);
    expect(r.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("never rejects on a garbage URL", async () => {
    const r = await probeQuery("not-a-url-at-all", 1_000);
    expect(r.ok).toBe(false);
  });
});

function failThenSucceed(failures: number): () => Promise<ProbeResult> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= failures) return { ok: false, error: new Error(`fail ${calls}`) };
    return { ok: true, latencyMs: 42 };
  };
}

describe("verifyWithRetries", () => {
  test("first-attempt success makes exactly one probe", async () => {
    const r = await verifyWithRetries(failThenSucceed(0), { sleep: async () => {} });
    expect(r).toEqual({ ok: true, attempts: 1, latencyMs: 42, lastError: null });
  });

  test("succeeds after warm-up failures, following the wait schedule", async () => {
    const waits: number[] = [];
    const r = await verifyWithRetries(failThenSucceed(2), { sleep: async ms => { waits.push(ms); } });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(waits).toEqual([1_000, 2_000]);
  });

  test("gives up when the schedule is exhausted", async () => {
    const r = await verifyWithRetries(failThenSucceed(99), { sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(5);
    expect(r.lastError?.message).toBe("fail 5");
  });

  test("stops early when the next wait would blow the budget", async () => {
    let clock = 0;
    const r = await verifyWithRetries(
      async () => {
        clock += 7_000;
        return { ok: false, error: new Error("slow fail") };
      },
      { sleep: async () => {}, now: () => clock },
    );
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
  });
});

describe("buildPostgresUrl", () => {
  test("defaults user and database to postgres", () => {
    expect(buildPostgresUrl("127.0.0.1:15432")).toBe("postgres://postgres@127.0.0.1:15432/postgres");
  });

  test("honors db hints", () => {
    expect(buildPostgresUrl("127.0.0.1:15432", { user: "reader", database: "main" }))
      .toBe("postgres://reader@127.0.0.1:15432/main");
  });
});
