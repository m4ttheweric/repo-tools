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

  test("non-interactive access request without a reason fails, submitting nothing", async () => {
    const { deps, calls } = makeDeps({ needsAccessRequest: async () => true });
    const r = await runGuidedConnect(target, { interactive: false }, deps);
    expect(r.outcome).toBe("failed");
    if (r.outcome === "failed") expect(r.stage).toBe("access");
    expect(calls.some(c => c.startsWith("access:"))).toBe(false);
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
