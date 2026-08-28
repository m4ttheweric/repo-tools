import { describe, test, expect } from "bun:test";
import { bindApiServerWithRetry, BIND_RETRY_ATTEMPTS, BIND_RETRY_DELAY_MS, type BindRetryDeps } from "../api-server.ts";

function eaddrinuse(): Error {
  return Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
}

function deps(overrides: Partial<BindRetryDeps> = {}): BindRetryDeps & { logs: string[]; sleeps: number[] } {
  const logs: string[] = [];
  const sleeps: number[] = [];
  return {
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: { warn: (_o: unknown, m: string) => logs.push(`warn:${m}`) },
    logs,
    sleeps,
    ...overrides,
  };
}

describe("bindApiServerWithRetry", () => {
  test("binds immediately when the port is free, no retry", async () => {
    const d = deps();
    let calls = 0;
    const server = await bindApiServerWithRetry(() => { calls++; return "server" as any; }, d);
    expect(server).toBe("server");
    expect(calls).toBe(1);
    expect(d.sleeps).toEqual([]);
  });

  test("retries on EADDRINUSE and succeeds once the port frees", async () => {
    const d = deps();
    let calls = 0;
    const server = await bindApiServerWithRetry(() => {
      calls++;
      if (calls < 3) throw eaddrinuse();
      return "server" as any;
    }, d);
    expect(server).toBe("server");
    expect(calls).toBe(3);
    expect(d.sleeps).toEqual([BIND_RETRY_DELAY_MS, BIND_RETRY_DELAY_MS]);
    expect(d.logs.some((l) => l.includes("retrying"))).toBe(true);
  });

  test("exhausting retries rethrows the original error after exactly BIND_RETRY_ATTEMPTS calls", async () => {
    const d = deps();
    let calls = 0;
    await expect(
      bindApiServerWithRetry(() => { calls++; throw eaddrinuse(); }, d),
    ).rejects.toThrow("EADDRINUSE");
    expect(calls).toBe(BIND_RETRY_ATTEMPTS);
    expect(d.sleeps.length).toBe(BIND_RETRY_ATTEMPTS - 1);
  });

  test("a non-EADDRINUSE error is never retried", async () => {
    const d = deps();
    let calls = 0;
    await expect(
      bindApiServerWithRetry(() => { calls++; throw new Error("something else"); }, d),
    ).rejects.toThrow("something else");
    expect(calls).toBe(1);
    expect(d.sleeps).toEqual([]);
  });
});
