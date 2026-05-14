import { describe, test, expect } from "bun:test";
import { createTunnelHandlers } from "../handlers/tunnel.ts";

function fakeCtx() {
  const calls: any[] = [];
  return {
    calls,
    tunnelManager: {
      async apply(boardName: string, lanes: any[]) { calls.push({ kind: "apply", boardName, lanes }); },
      async stop(boardName: string) { calls.push({ kind: "stop", boardName }); },
      status(boardName: string) { return { state: "stopped" as const }; },
    },
    log: () => {},
  };
}

describe("tunnel handlers", () => {
  test("tunnel:apply forwards to tunnelManager", async () => {
    const ctx = fakeCtx();
    const handlers = createTunnelHandlers(ctx as any);
    const res = await handlers["tunnel:apply"]({ boardName: "b1", lanes: [] });
    expect(res).toEqual({ ok: true });
    expect(ctx.calls).toContainEqual({ kind: "apply", boardName: "b1", lanes: [] });
  });

  test("tunnel:apply rejects missing boardName", async () => {
    const handlers = createTunnelHandlers(fakeCtx() as any);
    const res = await handlers["tunnel:apply"]({ lanes: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/boardName/);
  });

  test("tunnel:status returns manager status", async () => {
    const handlers = createTunnelHandlers(fakeCtx() as any);
    const res = await handlers["tunnel:status"]({ boardName: "b1" });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ state: "stopped" });
  });

  test("tunnel:stop forwards to tunnelManager.stop", async () => {
    const ctx = fakeCtx();
    const handlers = createTunnelHandlers(ctx as any);
    await handlers["tunnel:stop"]({ boardName: "b1" });
    expect(ctx.calls).toContainEqual({ kind: "stop", boardName: "b1" });
  });
});
