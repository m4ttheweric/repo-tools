import { describe, test, expect } from "bun:test";
import { runGuidedConnect, type GuidedDeps, type GuidedTarget } from "../flow.ts";
import type { SdmSnapshot } from "../core.ts";

const target: GuidedTarget = {
  key: "demo:alpha-staging",
  label: "Alpha Staging",
  sdmResource: "example-alpha-staging",
  reasonSuggestion: "checking alpha data",
};

function snapshot(status: SdmSnapshot["health"]["status"], address: string | null = "127.0.0.1:15432"): SdmSnapshot {
  return {
    health: { status, message: status === "ok" ? null : `msg:${status}` },
    resources: new Map(
      status === "ok" ? [["example-alpha-staging", { connected: true, address, expiry: null }]] : [],
    ),
  };
}

function makeDeps(overrides: Partial<GuidedDeps> = {}): { deps: GuidedDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: GuidedDeps = {
    getSnapshot: async () => { calls.push("snapshot"); return snapshot("ok"); },
    needsAccessRequest: async () => { calls.push("needsAccess"); return false; },
    requestAccess: async (_r, d, reason) => { calls.push(`access:${d}:${reason}`); return { ok: true }; },
    connect: async () => { calls.push("connect"); return { ok: true }; },
    verify: async url => { calls.push(`verify:${url}`); return { ok: true, attempts: 1, latencyMs: 10, lastError: null }; },
    probeTunnel: async () => { calls.push("probeTunnel"); return { ok: true, latencyMs: 5 }; },
    login: async () => { calls.push("login"); return { ok: true }; },
    promptDuration: async def => { calls.push("promptDuration"); return def; },
    promptReason: async def => { calls.push("promptReason"); return def; },
    confirmProduction: async () => { calls.push("confirmProduction"); return true; },
    confirmLogin: async () => { calls.push("confirmLogin"); return true; },
    onLine: () => {},
    recordRecent: () => { calls.push("recordRecent"); },
    ...overrides,
  };
  return { deps, calls };
}

describe("runGuidedConnect", () => {
  test("promptless path: granted access, connect, verify, record", async () => {
    const { deps, calls } = makeDeps();
    const r = await runGuidedConnect(target, { interactive: true }, deps);
    expect(r.outcome).toBe("connected");
    if (r.outcome === "connected") expect(r.address).toBe("127.0.0.1:15432");
    expect(calls).not.toContain("promptReason");
    expect(calls).toContain("connect");
    expect(calls).toContain("recordRecent");
  });

  test("access-request path prompts duration and reason", async () => {
    const { deps, calls } = makeDeps({ needsAccessRequest: async () => true });
    const r = await runGuidedConnect(target, { interactive: true }, deps);
    expect(r.outcome).toBe("connected");
    expect(calls).toContain("promptDuration");
    expect(calls).toContain("access:8h:checking alpha data");
  });

  test("non-interactive access request without a reason defaults to reasonSuggestion, no prompts reached", async () => {
    const { deps, calls } = makeDeps({ needsAccessRequest: async () => true });
    const r = await runGuidedConnect(target, { interactive: false }, deps);
    expect(r.outcome).toBe("connected");
    expect(calls).toContain("access:8h:checking alpha data");
    expect(calls).not.toContain("promptReason");
    expect(calls).not.toContain("promptDuration");
  });

  test("non-interactive with flags submits them verbatim", async () => {
    const { deps, calls } = makeDeps({ needsAccessRequest: async () => true });
    const r = await runGuidedConnect(target, { interactive: false, duration: "4h", reason: "ticket 123" }, deps);
    expect(r.outcome).toBe("connected");
    expect(calls).toContain("access:4h:ticket 123");
    expect(calls).not.toContain("promptReason");
  });

  test("logged out: confirm, login, resume", async () => {
    let snapCalls = 0;
    const { deps, calls } = makeDeps({
      getSnapshot: async () => {
        snapCalls += 1;
        return snapshot(snapCalls === 1 ? "not-authenticated" : "ok");
      },
    });
    const r = await runGuidedConnect(target, { interactive: true }, deps);
    expect(r.outcome).toBe("connected");
    expect(calls).toContain("confirmLogin");
    expect(calls).toContain("login");
  });

  test("logged out and non-interactive fails at login stage", async () => {
    const { deps } = makeDeps({ getSnapshot: async () => snapshot("not-authenticated") });
    const r = await runGuidedConnect(target, { interactive: false }, deps);
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") expect(r.stage).toBe("login");
  });

  test("declined production confirm aborts before anything org-visible", async () => {
    const prod: GuidedTarget = { ...target, production: true };
    const { deps, calls } = makeDeps({
      needsAccessRequest: async () => true,
      confirmProduction: async () => false,
    });
    const r = await runGuidedConnect(prod, { interactive: true }, deps);
    expect(r.outcome).toBe("aborted");
    expect(calls.some(c => c.startsWith("access:"))).toBe(false);
  });

  test("missing tunnel address after connect fails at verify stage", async () => {
    const { deps } = makeDeps({
      getSnapshot: async (force?: boolean) => (force ? snapshot("ok", null) : snapshot("ok")),
    });
    const r = await runGuidedConnect(target, { interactive: true }, deps);
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") expect(r.stage).toBe("verify");
  });

  test("verify fails AND the TCP tunnel is down: hard verify failure", async () => {
    const { deps } = makeDeps({
      verify: async () => ({ ok: false, attempts: 5, latencyMs: null, lastError: new Error("handshake refused") }),
      probeTunnel: async () => ({ ok: false, error: new Error("ECONNREFUSED") }),
    });
    const r = await runGuidedConnect(target, { interactive: true }, deps);
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") {
      expect(r.stage).toBe("verify");
      expect(r.error).toContain("handshake refused");
    }
  });

  test("verify fails but the TCP tunnel is up: connected-with-warning, still recorded", async () => {
    const { deps, calls } = makeDeps({
      verify: async () => ({ ok: false, attempts: 5, latencyMs: null, lastError: new Error("Connection closed") }),
      // default probeTunnel returns ok (tunnel reachable)
    });
    const r = await runGuidedConnect(target, { interactive: true }, deps);
    expect(r.outcome).toBe("connected");
    if (r.outcome === "connected") {
      expect(r.unverified).toBe(true);
      expect(r.verify.lastError?.message).toBe("Connection closed");
    }
    // A usable tunnel is still recorded as a recent (unlike a hard failure).
    expect(calls).toContain("recordRecent");
  });
});

const ADDRESS = "127.0.0.1:15432";

function okSnapshot(): SdmSnapshot {
  return {
    health: { status: "ok", message: null },
    resources: new Map([["res", { connected: true, address: ADDRESS, expiry: null }]]),
  };
}

const never = async (): Promise<never> => {
  throw new Error("prompt reached in non-interactive flow");
};

function makeResDeps(overrides: Partial<GuidedDeps> = {}) {
  const accessCalls: Array<{ resource: string; duration: string; reason: string }> = [];
  const deps: GuidedDeps = {
    getSnapshot: async () => okSnapshot(),
    needsAccessRequest: async () => true,
    requestAccess: async (resource, duration, reason) => {
      accessCalls.push({ resource, duration, reason });
      return { ok: true };
    },
    connect: async () => ({ ok: true }),
    verify: async () => ({ ok: true, attempts: 1, latencyMs: 5, lastError: null }),
    probeTunnel: async () => ({ ok: true, latencyMs: 1 }),
    login: never,
    promptDuration: never,
    promptReason: never,
    confirmProduction: never,
    confirmLogin: never,
    onLine: () => {},
    recordRecent: () => {},
    ...overrides,
  };
  return { deps, accessCalls };
}

const resTarget: GuidedTarget = {
  key: "sdm:res",
  label: "res label",
  sdmResource: "res",
  reasonSuggestion: "investigating res data",
};

describe("runGuidedConnect non-interactive defaulting", () => {
  test("defaults duration to 8h and reason to reasonSuggestion", async () => {
    const { deps, accessCalls } = makeResDeps();
    const result = await runGuidedConnect(resTarget, { interactive: false }, deps);
    expect(result.outcome).toBe("connected");
    expect(accessCalls).toEqual([{ resource: "res", duration: "8h", reason: "investigating res data" }]);
  });

  test("falls back to the label template when reasonSuggestion is absent", async () => {
    const { deps, accessCalls } = makeResDeps();
    const bare: GuidedTarget = { key: "sdm:res", label: "res label", sdmResource: "res" };
    await runGuidedConnect(bare, { interactive: false }, deps);
    expect(accessCalls[0]!.reason).toBe("investigating res label data");
  });

  test("explicit flags win over defaults", async () => {
    const { deps, accessCalls } = makeResDeps();
    await runGuidedConnect(resTarget, { interactive: false, duration: "1h", reason: "ticket ABC-1" }, deps);
    expect(accessCalls).toEqual([{ resource: "res", duration: "1h", reason: "ticket ABC-1" }]);
  });

  test("whitespace-only reason falls back to the suggestion", async () => {
    const { deps, accessCalls } = makeResDeps();
    await runGuidedConnect(resTarget, { interactive: false, reason: "   " }, deps);
    expect(accessCalls[0]!.reason).toBe("investigating res data");
  });
});
