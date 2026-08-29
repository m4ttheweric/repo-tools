// lib/endpoint/__tests__/allocator.test.ts
import { describe, expect, test } from "bun:test";
import type { EndpointClaim } from "../store.ts";
import { CLAIM_TRUST_TTL_MS, defaultProbes, isLiveClaim, pruneDeadClaims, releaseWorktree, resolveClaim } from "../allocator.ts";

const role = { pool: [4001, 5001, 6001], needs: [], preserveEnv: [], env: {} };
const probes = (
  over: Partial<{ listeners: number[]; alive: number[]; unbindable: number[]; startTimes: Record<number, string> }> = {},
) => ({
  listeners: new Set(over.listeners ?? []),
  pidAlive: (pid?: number) => (over.alive ?? []).includes(pid ?? -1),
  pidStartTime: (pid?: number) => (pid === undefined ? undefined : (over.startTimes ?? {})[pid]),
  canBind: (p: number) => !(over.unbindable ?? []).includes(p),
});
const claim = (worktree: string, port: number, pid?: number, startTime?: string): EndpointClaim =>
  ({ worktree, role: "portal", port, pid, ts: "2026-08-19T00:00:00Z", startTime });

describe("resolveClaim", () => {
  test("first worktree gets the lowest bindable pool port", () => {
    const r = resolveClaim([], "portal", role, "/wt/a", 111, probes());
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4001);
    expect(r.claims[0]).toMatchObject({ worktree: "/wt/a", role: "portal", port: 4001, pid: 111 });
  });

  test("sticky: same worktree re-asks and gets its port back, pid re-stamped", () => {
    const existing = [claim("/wt/a", 4001, 111)];
    const r = resolveClaim(existing, "portal", role, "/wt/a", 222, probes({ alive: [111] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4001);
    expect(r.claims.find((c) => c.worktree === "/wt/a")?.pid).toBe(222);
  });

  test("second worktree skips a port owned by a LIVE claim (boot window: pid alive, port not listening yet)", () => {
    const existing = [claim("/wt/a", 4001, 111, "Thu Aug 27 00:00:00 2026")];
    const r = resolveClaim(existing, "portal", role, "/wt/b", 222, probes({ alive: [111], startTimes: { 111: "Thu Aug 27 00:00:00 2026" } }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(5001);
  });

  test("a dead claim's port is reusable, and the dead OTHER-worktree row is pruned", () => {
    const existing = [claim("/wt/a", 4001, 111)]; // pid dead, port silent
    const r = resolveClaim(existing, "portal", role, "/wt/b", 222, probes());
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4001);
    expect(r.claims.some((c) => c.worktree === "/wt/a")).toBe(false);
  });

  test("a foreign listener (no claim) blocks a port even when bindable-looking", () => {
    const r = resolveClaim([], "portal", role, "/wt/a", 1, probes({ listeners: [4001] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(5001);
  });

  test("own listening port is reusable on restart (self-claim survival)", () => {
    const existing = [claim("/wt/a", 4001)]; // no pid recorded, but the port listens = ours, live
    const r = resolveClaim(existing, "portal", role, "/wt/a", 9, probes({ listeners: [4001] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4001);
  });

  test("bind-probe veto: claimed-nothing, listening-nothing, but unbindable → skipped", () => {
    const r = resolveClaim([], "portal", role, "/wt/a", 1, probes({ unbindable: [4001] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(5001);
  });

  test("pool exhaustion names the role", () => {
    const r = resolveClaim([], "portal", { ...role, pool: [4001] }, "/wt/b", 2, probes({ listeners: [4001] }));
    expect(r).toEqual({ error: 'no free port in pool for role "portal" (1 declared, 0 free)' });
  });

  test("pool exhaustion when every unblocked candidate fails the bind probe (all vetoed, none truly free)", () => {
    const r = resolveClaim(
      [],
      "portal",
      { ...role, pool: [4001, 5001] },
      "/wt/a",
      1,
      probes({ unbindable: [4001, 5001] }),
    );
    expect(r).toEqual({ error: 'no free port in pool for role "portal" (2 declared, 0 free)' });
  });

  test("fixedPort role allocates nothing and returns the fixed port", () => {
    const r = resolveClaim([], "frontend", { pool: [], fixedPort: 4002, needs: [], preserveEnv: [], env: {} }, "/wt/a", 1, probes());
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4002);
    expect(r.claims).toEqual([]);
    expect(r.changed).toBe(false);
  });
});

describe("releaseWorktree", () => {
  test("releases all roles for a worktree, or one role when named", () => {
    const claims = [claim("/wt/a", 4001), { ...claim("/wt/a", 10400), role: "backend" }, claim("/wt/b", 5001)];
    const all = releaseWorktree(claims, "/wt/a");
    expect(all.released).toHaveLength(2);
    expect(all.claims).toHaveLength(1);
    const one = releaseWorktree(claims, "/wt/a", "backend");
    expect(one.released.map((c) => c.role)).toEqual(["backend"]);
  });
});

describe("liveness (verbatim lessons)", () => {
  test("no TTLs for a start-time-verified claim: an ancient claim with a live pid and matching start-time is live", () => {
    const c = { ...claim("/wt/a", 4001, 111, "Thu Jan  1 00:00:00 2020"), ts: "2020-01-01T00:00:00Z" };
    expect(isLiveClaim(c, probes({ alive: [111], startTimes: { 111: "Thu Jan  1 00:00:00 2020" } }))).toBe(true);
  });

  test("recycled pid: a live pid whose current start-time no longer matches the claim reads dead", () => {
    const c = claim("/wt/a", 4001, 111, "Thu Jan  1 00:00:00 2020");
    // Same pid number, different (later) start-time = a different process reused it after a reboot.
    expect(isLiveClaim(c, probes({ alive: [111], startTimes: { 111: "Fri Aug 28 09:00:00 2026" } }))).toBe(false);
  });

  test("legacy claim (no start-time recorded): a live pid is live within CLAIM_TRUST_TTL_MS of the claim's own ts", () => {
    const now = Date.parse("2026-08-28T00:00:00Z");
    const c = claim("/wt/a", 4001, 111); // startTime undefined
    const ts = new Date(now - (CLAIM_TRUST_TTL_MS - 1000)).toISOString();
    expect(isLiveClaim({ ...c, ts }, probes({ alive: [111] }), now)).toBe(true);
  });

  test("legacy claim (no start-time recorded): a live pid beyond CLAIM_TRUST_TTL_MS reads dead", () => {
    const now = Date.parse("2026-08-28T00:00:00Z");
    const c = claim("/wt/a", 4001, 111); // startTime undefined
    const ts = new Date(now - (CLAIM_TRUST_TTL_MS + 1000)).toISOString();
    expect(isLiveClaim({ ...c, ts }, probes({ alive: [111] }), now)).toBe(false);
  });

  test("pruneDeadClaims spares self even when dead-looking", () => {
    const { claims } = pruneDeadClaims([claim("/wt/a", 4001)], "/wt/a", probes());
    expect(claims).toHaveLength(1);
  });
});

describe("defaultProbes (real, not injected)", () => {
  test("canBind answers true for a free port and false for one already bound", async () => {
    // Regression guard: the probe used to call `Bun.listen` with an empty
    // `socket: {}`, which throws ERR_INVALID_ARG_TYPE before any bind is
    // attempted — so canBind answered false for EVERY port and every
    // allocation failed with "no free port in pool". Injected probes in the
    // tests above can't catch that; only the real one can.
    const probe = await defaultProbes();

    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const port = server.port;
    if (port === undefined) throw new Error("Bun.serve did not report a port");
    try {
      expect(probe.canBind(port)).toBe(false);
    } finally {
      server.stop(true);
    }

    // The same port, once released, must come back as bindable.
    expect(probe.canBind(port)).toBe(true);
  });
});
