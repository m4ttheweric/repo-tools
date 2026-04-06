/**
 * ProxyManager integration tests (13 tests)
 *
 * Starts real Bun.serve reverse proxies. Tests use ephemeral ports.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ProxyManager } from "../proxy-manager.ts";

let pm: ProxyManager;

// Simple counter to pick unique test ports to avoid cross-test conflicts
let portBase = 20100;
function nextPort(): number { return portBase++; }

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Start a minimal upstream server that responds with a fixed body */
function startUpstream(port: number, body: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    fetch() {
      return new Response(body, { status: 200 });
    },
  });
}

beforeEach(() => {
  pm = new ProxyManager();
});

afterEach(() => {
  pm.stopAll();
});

// ── start / stop ─────────────────────────────────────────────────────────────

describe("start and stop", () => {
  test("start registers a proxy in list()", () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    pm.start("svc", canonical, upstream);
    const entries = pm.list();
    expect(entries.some((e) => e.id === "svc")).toBe(true);
    pm.stop("svc");
  });

  test("getStatus returns status for running proxy", () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    pm.start("svc", canonical, upstream);
    const status = pm.getStatus("svc");
    expect(status).not.toBeNull();
    expect(status?.canonicalPort).toBe(canonical);
    expect(status?.upstreamPort).toBe(upstream);
    expect(status?.running).toBe(true);
    pm.stop("svc");
  });

  test("getStatus returns null after stop", () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    pm.start("svc", canonical, upstream);
    pm.stop("svc");
    expect(pm.getStatus("svc")).toBeNull();
  });

  test("stop removes from list()", () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    pm.start("svc", canonical, upstream);
    pm.stop("svc");
    expect(pm.list().some((e) => e.id === "svc")).toBe(false);
  });

  test("stop is no-op for unknown id", () => {
    expect(() => pm.stop("nonexistent")).not.toThrow();
  });
});

// ── HTTP proxying ─────────────────────────────────────────────────────────────

describe("HTTP proxying", () => {
  test("proxy forwards request to upstream", async () => {
    const [canonical, upstreamPort] = [nextPort(), nextPort()];
    const upstream = startUpstream(upstreamPort, "hello-from-upstream");

    pm.start("svc", canonical, upstreamPort);
    await sleep(100);

    try {
      const res = await fetch(`http://localhost:${canonical}/`);
      const body = await res.text();
      expect(body).toBe("hello-from-upstream");
    } finally {
      pm.stop("svc");
      upstream.stop(true);
    }
  });

  test("proxy returns 502 when upstream is unreachable", async () => {
    const [canonical, badPort] = [nextPort(), nextPort()]; // badPort has no server
    pm.start("svc", canonical, badPort);
    await sleep(100);

    try {
      const res = await fetch(`http://localhost:${canonical}/`);
      expect(res.status).toBe(502);
    } finally {
      pm.stop("svc");
    }
  });
});

// ── setUpstream (hot-swap) ───────────────────────────────────────────────────

describe("setUpstream hot-swap", () => {
  test("setUpstream changes the upstream port", () => {
    const [canonical, upstream1, upstream2] = [nextPort(), nextPort(), nextPort()];
    pm.start("svc", canonical, upstream1);
    pm.setUpstream("svc", upstream2);
    expect(pm.getStatus("svc")?.upstreamPort).toBe(upstream2);
    pm.stop("svc");
  });

  test("requests after setUpstream go to new upstream", async () => {
    const [canonical, port1, port2] = [nextPort(), nextPort(), nextPort()];
    const up1 = startUpstream(port1, "server-one");
    const up2 = startUpstream(port2, "server-two");

    pm.start("svc", canonical, port1);
    await sleep(100);

    const res1 = await fetch(`http://localhost:${canonical}/`);
    expect(await res1.text()).toBe("server-one");

    pm.setUpstream("svc", port2);
    await sleep(50);

    const res2 = await fetch(`http://localhost:${canonical}/`);
    expect(await res2.text()).toBe("server-two");

    pm.stop("svc");
    up1.stop(true);
    up2.stop(true);
  });

  test("setUpstream throws for unknown id", () => {
    expect(() => pm.setUpstream("nonexistent", 12345)).toThrow();
  });
});

// ── stopAll ───────────────────────────────────────────────────────────────────

describe("stopAll", () => {
  test("stopAll removes all proxies", () => {
    const [c1, u1, c2, u2] = [nextPort(), nextPort(), nextPort(), nextPort()];
    pm.start("svc1", c1, u1);
    pm.start("svc2", c2, u2);
    pm.stopAll();
    expect(pm.list()).toHaveLength(0);
  });

  test("start after stopAll replaces previous proxy on same id", () => {
    const [c, u1, u2] = [nextPort(), nextPort(), nextPort()];
    pm.start("svc", c, u1);
    pm.stopAll();
    pm.start("svc", c, u2);
    expect(pm.getStatus("svc")?.upstreamPort).toBe(u2);
    pm.stop("svc");
  });
});
