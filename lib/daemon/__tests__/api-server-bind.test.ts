import { describe, test, expect } from "bun:test";
import { bindApiServerWithRetry, BIND_RETRY_ATTEMPTS, BIND_RETRY_DELAY_MS, type BindRetryDeps } from "../api-server.ts";
import { ApiPortInUseError } from "../api-server.ts";

function eaddrinuse(): Error {
  return Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
}

function deps(overrides: Partial<BindRetryDeps> = {}): BindRetryDeps & { logs: string[]; sleeps: number[] } {
  const logs: string[] = [];
  const sleeps: number[] = [];
  return {
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: { warn: (_o: unknown, m: string) => logs.push(`warn:${m}`) },
    probePortHolder: async () => "n/a",
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

  test("exhausting retries rethrows as ApiPortInUseError after exactly BIND_RETRY_ATTEMPTS calls", async () => {
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

function depsWithProbe(overrides: Partial<BindRetryDeps> = {}) {
  const logs: Array<{ o: unknown; m: string }> = [];
  const sleeps: number[] = [];
  const probeCalls: number[] = [];
  return {
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: { warn: (o: unknown, m: string) => logs.push({ o, m }) },
    probePortHolder: async (port: number) => { probeCalls.push(port); return "COMMAND PID USER\nnode 123 matt"; },
    logs,
    sleeps,
    probeCalls,
    ...overrides,
  };
}

describe("bindApiServerWithRetry — exhausted retries (S043)", () => {
  test("throws ApiPortInUseError (not the raw EADDRINUSE Error) once attempts are exhausted", async () => {
    const d = depsWithProbe();
    let error: unknown;
    try {
      await bindApiServerWithRetry(() => { throw eaddrinuse(); }, d);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ApiPortInUseError);
    expect((error as ApiPortInUseError).code).toBe("EADDRINUSE");
    expect((error as Error).message).toContain("EADDRINUSE");
  });

  test("probes the port holder exactly once, only after the final attempt", async () => {
    const d = depsWithProbe();
    let calls = 0;
    await expect(
      bindApiServerWithRetry(() => { calls++; throw eaddrinuse(); }, d),
    ).rejects.toBeInstanceOf(ApiPortInUseError);
    expect(calls).toBe(BIND_RETRY_ATTEMPTS);
    expect(d.probeCalls.length).toBe(1);
  });

  test("logs the probe result at warn before throwing", async () => {
    const d = depsWithProbe();
    await expect(
      bindApiServerWithRetry(() => { throw eaddrinuse(); }, d),
    ).rejects.toBeInstanceOf(ApiPortInUseError);
    const finalWarn = d.logs.at(-1)!;
    expect(finalWarn.o).toMatchObject({ holder: expect.stringContaining("node") });
  });

  test("a probe failure does not prevent the ApiPortInUseError from being thrown", async () => {
    const d = depsWithProbe({ probePortHolder: async () => { throw new Error("lsof: command not found"); } });
    await expect(
      bindApiServerWithRetry(() => { throw eaddrinuse(); }, d),
    ).rejects.toBeInstanceOf(ApiPortInUseError);
  });

  test("a successful bind never probes", async () => {
    const d = depsWithProbe();
    await bindApiServerWithRetry(() => "server" as any, d);
    expect(d.probeCalls.length).toBe(0);
  });
});
