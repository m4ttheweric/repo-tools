/**
 * bg:* handler tests. The claims store is real (tmp sqlite, same pattern as
 * bg-claims-store.test.ts); the BgService is faked -- its process lifecycle
 * is bg-service.test.ts's job, not this file's.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createBgClaimsStore, type BgClaimsStore } from "../bg-claims-store.ts";
import { createBgHandlers } from "../handlers/bg.ts";
import type { BgService, ParityReport } from "../bg-service.ts";

const log = pino({ level: "silent" });
const SOCKET = "/h/.config/herdr/sessions/bg/herdr.sock";

let dirs: string[] = [];
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function claimsStore(): BgClaimsStore {
  const dir = mkdtempSync(join(tmpdir(), "rt-bg-handlers-"));
  dirs.push(dir);
  return createBgClaimsStore({ dbPath: join(dir, "bg-claims.db"), log });
}

function fakeService(opts: { up?: boolean; started?: boolean; parity?: ParityReport | null } = {}): { service: BgService; stopCalls: number[] } {
  const stopCalls: number[] = [];
  const parity = opts.parity ?? null;
  const service: BgService = {
    socketPath: () => SOCKET,
    up: async () => opts.up ?? true,
    ensure: async () => ({ socket: SOCKET, started: opts.started ?? true }),
    stop: async () => { stopCalls.push(Date.now()); },
    reprobe: async () => parity ?? { ok: true, drift: [] },
    lastParity: () => parity,
  };
  return { service, stopCalls };
}

function fakeLifecycle(): { lifecycle: { watch(socket: string): void }; watched: string[] } {
  const watched: string[] = [];
  return { lifecycle: { watch: (socket: string) => { watched.push(socket); } }, watched };
}

describe("bg handlers", () => {
  test("bg:ensure ensures, watches the socket, and registers the claim when given", async () => {
    const claims = claimsStore();
    const { service } = fakeService({ started: true, parity: { ok: true, drift: [] } });
    const { lifecycle, watched } = fakeLifecycle();
    const bg = createBgHandlers({ service, claims, lifecycle });

    const res = await bg["bg:ensure"]({ claim: "gitq" });
    expect(res).toEqual({ ok: true, data: { socket: SOCKET, started: true, parity: { ok: true, drift: [] } } });
    expect(watched).toEqual([SOCKET]);
    expect(claims.list()).toEqual([{ owner: "gitq", pane: null, createdAt: expect.any(Number) }]);
  });

  test("bg:ensure with no claim just ensures, registering nothing", async () => {
    const claims = claimsStore();
    const { service } = fakeService();
    const { lifecycle, watched } = fakeLifecycle();
    const bg = createBgHandlers({ service, claims, lifecycle });

    const res = await bg["bg:ensure"]({});
    expect(res.ok).toBe(true);
    expect(watched).toEqual([SOCKET]);
    expect(claims.list()).toEqual([]);
  });

  test("bg:stop rejects while claims are live, naming every owner", async () => {
    const claims = claimsStore();
    claims.claim("gitq");
    claims.claim("herd:demo-1", "w1:p1");
    const { service, stopCalls } = fakeService();
    const { lifecycle } = fakeLifecycle();
    const bg = createBgHandlers({ service, claims, lifecycle });

    const res = await bg["bg:stop"]({});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain("gitq");
    expect(res.error).toContain("herd:demo-1");
    expect(stopCalls).toHaveLength(0);
  });

  test("bg:release then bg:stop succeeds and calls service.stop()", async () => {
    const claims = claimsStore();
    claims.claim("gitq");
    const { service, stopCalls } = fakeService();
    const { lifecycle } = fakeLifecycle();
    const bg = createBgHandlers({ service, claims, lifecycle });

    const released = await bg["bg:release"]({ claim: "gitq" });
    expect(released).toEqual({ ok: true, data: { released: true } });
    expect(claims.list()).toEqual([]);

    const stopped = await bg["bg:stop"]({});
    expect(stopped).toEqual({ ok: true, data: { stopped: true } });
    expect(stopCalls).toHaveLength(1);
  });

  test("bg:release reports false for an owner not currently claimed", async () => {
    const claims = claimsStore();
    const { service } = fakeService();
    const { lifecycle } = fakeLifecycle();
    const bg = createBgHandlers({ service, claims, lifecycle });

    const res = await bg["bg:release"]({ claim: "nobody" });
    expect(res).toEqual({ ok: true, data: { released: false } });
  });

  test("bg:status reflects up() and the current claims, without ensuring", async () => {
    const claims = claimsStore();
    claims.claim("gitq");
    const { service } = fakeService({ up: false });
    const { lifecycle } = fakeLifecycle();
    const bg = createBgHandlers({ service, claims, lifecycle });

    const res = await bg["bg:status"]({});
    expect(res).toEqual({
      ok: true,
      data: { up: false, socket: SOCKET, claims: [{ owner: "gitq", pane: null, createdAt: expect.any(Number) }] },
    });
  });
});
