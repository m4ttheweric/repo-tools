// lib/endpoint/__tests__/allocator.test.ts
import { describe, expect, test } from "bun:test";
import type { EndpointClaim } from "../store.ts";
import { isLiveClaim, pruneDeadClaims, releaseWorktree, resolveClaim } from "../allocator.ts";

const role = { pool: [4001, 5001, 6001], needs: [], preserveEnv: [], env: {} };
const probes = (over: Partial<{ listeners: number[]; alive: number[]; unbindable: number[] }> = {}) => ({
  listeners: new Set(over.listeners ?? []),
  pidAlive: (pid?: number) => (over.alive ?? []).includes(pid ?? -1),
  canBind: (p: number) => !(over.unbindable ?? []).includes(p),
});
const claim = (worktree: string, port: number, pid?: number): EndpointClaim =>
  ({ worktree, role: "adjuster", port, pid, ts: "2026-08-19T00:00:00Z" });

describe("resolveClaim", () => {
  test("first worktree gets the lowest bindable pool port", () => {
    const r = resolveClaim([], "adjuster", role, "/wt/a", 111, probes());
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4001);
    expect(r.claims[0]).toMatchObject({ worktree: "/wt/a", role: "adjuster", port: 4001, pid: 111 });
  });

  test("sticky: same worktree re-asks and gets its port back, pid re-stamped", () => {
    const existing = [claim("/wt/a", 4001, 111)];
    const r = resolveClaim(existing, "adjuster", role, "/wt/a", 222, probes({ alive: [111] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4001);
    expect(r.claims.find((c) => c.worktree === "/wt/a")?.pid).toBe(222);
  });

  test("second worktree skips a port owned by a LIVE claim (boot window: pid alive, port not listening yet)", () => {
    const existing = [claim("/wt/a", 4001, 111)];
    const r = resolveClaim(existing, "adjuster", role, "/wt/b", 222, probes({ alive: [111] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(5001);
  });

  test("a dead claim's port is reusable, and the dead OTHER-worktree row is pruned", () => {
    const existing = [claim("/wt/a", 4001, 111)]; // pid dead, port silent
    const r = resolveClaim(existing, "adjuster", role, "/wt/b", 222, probes());
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4001);
    expect(r.claims.some((c) => c.worktree === "/wt/a")).toBe(false);
  });

  test("a foreign listener (no claim) blocks a port even when bindable-looking", () => {
    const r = resolveClaim([], "adjuster", role, "/wt/a", 1, probes({ listeners: [4001] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(5001);
  });

  test("own listening port is reusable on restart (self-claim survival)", () => {
    const existing = [claim("/wt/a", 4001)]; // no pid recorded, but the port listens = ours, live
    const r = resolveClaim(existing, "adjuster", role, "/wt/a", 9, probes({ listeners: [4001] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4001);
  });

  test("bind-probe veto: claimed-nothing, listening-nothing, but unbindable → skipped", () => {
    const r = resolveClaim([], "adjuster", role, "/wt/a", 1, probes({ unbindable: [4001] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(5001);
  });

  test("pool exhaustion names the role", () => {
    const r = resolveClaim([], "adjuster", { ...role, pool: [4001] }, "/wt/b", 2, probes({ listeners: [4001] }));
    expect(r).toEqual({ error: 'no free port in pool for role "adjuster" (1 declared, 0 free)' });
  });

  test("pool exhaustion when every unblocked candidate fails the bind probe (all vetoed, none truly free)", () => {
    const r = resolveClaim(
      [],
      "adjuster",
      { ...role, pool: [4001, 5001] },
      "/wt/a",
      1,
      probes({ unbindable: [4001, 5001] }),
    );
    expect(r).toEqual({ error: 'no free port in pool for role "adjuster" (2 declared, 0 free)' });
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
  test("no TTLs: an ancient claim with a live pid is live", () => {
    expect(isLiveClaim({ ...claim("/wt/a", 4001, 111), ts: "2020-01-01T00:00:00Z" }, probes({ alive: [111] }))).toBe(true);
  });
  test("pruneDeadClaims spares self even when dead-looking", () => {
    const { claims } = pruneDeadClaims([claim("/wt/a", 4001)], "/wt/a", probes());
    expect(claims).toHaveLength(1);
  });
});
