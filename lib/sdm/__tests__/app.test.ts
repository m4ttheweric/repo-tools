import { describe, test, expect } from "bun:test";
import { ensureSdmApp, type EnsureAppDeps } from "../app.ts";
import type { SdmSnapshot } from "../core.ts";

function snap(status: SdmSnapshot["health"]["status"]): SdmSnapshot {
  return { health: { status, message: null }, resources: new Map() };
}

function makeDeps(overrides: Partial<EnsureAppDeps>) {
  const calls = { launched: 0, forcedProbes: 0 };
  const deps: EnsureAppDeps = {
    getSnapshot: async force => {
      if (force) calls.forcedProbes++;
      return snap("ok");
    },
    isRunning: async () => true,
    launch: async () => {
      calls.launched++;
      return { code: 0 };
    },
    sleep: async () => {},
    ...overrides,
  };
  return { deps, calls };
}

describe("ensureSdmApp", () => {
  test("healthy CLI: no process check, no launch", async () => {
    const { deps, calls } = makeDeps({});
    expect(await ensureSdmApp(() => {}, deps)).toEqual({ ok: true });
    expect(calls.launched).toBe(0);
  });

  test("not-authenticated is not the app's problem: no launch", async () => {
    const { deps, calls } = makeDeps({ getSnapshot: async () => snap("not-authenticated") });
    expect((await ensureSdmApp(() => {}, deps)).ok).toBe(true);
    expect(calls.launched).toBe(0);
  });

  test("CLI error but app running: pass through without launching", async () => {
    const { deps, calls } = makeDeps({ getSnapshot: async () => snap("error") });
    expect((await ensureSdmApp(() => {}, deps)).ok).toBe(true);
    expect(calls.launched).toBe(0);
  });

  test("CLI error and app absent: launches and polls until the CLI answers", async () => {
    let probes = 0;
    const { deps, calls } = makeDeps({
      isRunning: async () => false,
      getSnapshot: async force => {
        if (!force) return snap("error");
        probes++;
        return probes >= 3 ? snap("not-authenticated") : snap("error");
      },
    });
    const lines: string[] = [];
    expect((await ensureSdmApp(l => lines.push(l), deps)).ok).toBe(true);
    expect(calls.launched).toBe(1);
    expect(probes).toBe(3);
    expect(lines.some(l => l.includes("launching"))).toBe(true);
  });

  test("launch failure reports an error", async () => {
    const { deps } = makeDeps({
      isRunning: async () => false,
      getSnapshot: async () => snap("error"),
      launch: async () => ({ code: 1 }),
    });
    const r = await ensureSdmApp(() => {}, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("launch");
  });

  test("app never becomes ready: times out with a clear error", async () => {
    const { deps } = makeDeps({
      isRunning: async () => false,
      getSnapshot: async () => snap("error"),
    });
    const r = await ensureSdmApp(() => {}, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("did not become ready");
  });
});
