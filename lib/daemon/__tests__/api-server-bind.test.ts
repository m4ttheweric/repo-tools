import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "bun";
import { bindApiServerWithRetry, BIND_RETRY_ATTEMPTS, BIND_RETRY_DELAY_MS, startApiServer, type BindRetryDeps } from "../api-server.ts";
import { ApiPortInUseError } from "../api-server.ts";
import { setSetting, unsetSetting } from "../../settings/write.ts";
import { getSetting } from "../../settings/resolve.ts";

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

describe("startApiServer — binds via resolveApiPort() (S043 caller-side wiring)", () => {
  let server: Server<any> | undefined;
  let prevEnv: string | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    // Runs even when an assertion above threw — restore both regardless of
    // pass/fail, and regardless of test HOME being shared across the whole
    // `bun test` run (test-setup.ts preloads it once, not per file).
    if (prevEnv !== undefined) process.env.RT_API_PORT = prevEnv;
    else delete process.env.RT_API_PORT;
    unsetSetting("rt.apiPort", "user");
  });

  test("binds to the rt.apiPort setting value, not the hardcoded 9401 default", async () => {
    prevEnv = process.env.RT_API_PORT;
    delete process.env.RT_API_PORT;

    // Measure a free port rather than hardcoding one, then release it
    // immediately — startApiServer binds it back before anything else can.
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);

    setSetting("rt.apiPort", port, "user");
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

    server = await startApiServer({ handleCommand: async () => ({ ok: true }), log });

    expect(server.port).toBe(port);
  });

  test("the rt.apiPort setting from the previous test does not leak into later tests (C8)", () => {
    // 9401 is the registry default — proof the "user" scope value was
    // actually removed, not just that some value happens to be present.
    expect(getSetting<number>("rt.apiPort").value).toBe(9401);
  });
});
