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

/**
 * Start a WS echo upstream. Echoes messages back prefixed with `tag:` so tests
 * can tell which upstream answered. Acknowledges subprotocol if sent.
 */
function startWsEcho(port: number, tag: string): ReturnType<typeof Bun.serve> {
  return Bun.serve<{ sub?: string }, never>({
    port,
    fetch(req, srv) {
      const proto = req.headers.get("sec-websocket-protocol");
      const sub = proto?.split(",")[0]?.trim();
      const ok = srv.upgrade(req, { data: { sub } });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        if (ws.data.sub) ws.send(`sub:${ws.data.sub}`);
      },
      message(ws, msg) {
        if (typeof msg === "string") ws.send(`${tag}:${msg}`);
        else ws.send(msg); // binary: echo raw
      },
    },
  });
}

/** Wait for a single message matching a predicate, or time out. */
function nextMessage(
  ws: WebSocket,
  predicate: (data: unknown) => boolean = () => true,
  timeoutMs = 1000,
): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("nextMessage timed out"));
    }, timeoutMs);
    const handler = (ev: MessageEvent) => {
      if (!predicate(ev.data)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(ev);
    };
    ws.addEventListener("message", handler);
  });
}

/** Wait for close event, or time out. */
function waitClose(ws: WebSocket, timeoutMs = 1000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      // already closed — synthesize an event-like object
      resolve({ code: 1006, reason: "already closed", wasClean: false } as CloseEvent);
      return;
    }
    const timer = setTimeout(() => reject(new Error("waitClose timed out")), timeoutMs);
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      resolve(ev);
    }, { once: true });
  });
}

/** Open a client WS to the given port and wait until it opens. */
async function openWs(port: number, protocols?: string | string[]): Promise<WebSocket> {
  const ws = protocols
    ? new WebSocket(`ws://localhost:${port}/`, protocols)
    : new WebSocket(`ws://localhost:${port}/`);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("openWs timed out")), 1000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("openWs error")); }, { once: true });
  });
  return ws;
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
    pm.start("svc", canonical, upstream, "test");
    const entries = pm.list();
    expect(entries.some((e) => e.id === "svc")).toBe(true);
    pm.stop("svc");
  });

  test("getStatus returns status for running proxy", () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    pm.start("svc", canonical, upstream, "test");
    const status = pm.getStatus("svc");
    expect(status).not.toBeNull();
    expect(status?.canonicalPort).toBe(canonical);
    expect(status?.upstreamPort).toBe(upstream);
    expect(status?.running).toBe(true);
    pm.stop("svc");
  });

  test("getStatus returns null after stop", () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    pm.start("svc", canonical, upstream, "test");
    pm.stop("svc");
    expect(pm.getStatus("svc")).toBeNull();
  });

  test("stop removes from list()", () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    pm.start("svc", canonical, upstream, "test");
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

    pm.start("svc", canonical, upstreamPort, "test");
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
    pm.start("svc", canonical, badPort, "test");
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
    pm.start("svc", canonical, upstream1, "test");
    pm.setUpstream("svc", upstream2);
    expect(pm.getStatus("svc")?.upstreamPort).toBe(upstream2);
    pm.stop("svc");
  });

  test("requests after setUpstream go to new upstream", async () => {
    const [canonical, port1, port2] = [nextPort(), nextPort(), nextPort()];
    const up1 = startUpstream(port1, "server-one");
    const up2 = startUpstream(port2, "server-two");

    pm.start("svc", canonical, port1, "test");
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
    pm.start("svc1", c1, u1, "test");
    pm.start("svc2", c2, u2, "test");
    pm.stopAll();
    expect(pm.list()).toHaveLength(0);
  });

  test("start after stopAll replaces previous proxy on same id", () => {
    const [c, u1, u2] = [nextPort(), nextPort(), nextPort()];
    pm.start("svc", c, u1, "test");
    pm.stopAll();
    pm.start("svc", c, u2, "test");
    expect(pm.getStatus("svc")?.upstreamPort).toBe(u2);
    pm.stop("svc");
  });
});

// ── WebSocket proxying ───────────────────────────────────────────────────────

describe("WebSocket proxying", () => {
  test("client↔upstream message round-trip through proxy", async () => {
    const [canonical, upstreamPort] = [nextPort(), nextPort()];
    const upstream = startWsEcho(upstreamPort, "one");
    pm.start("svc", canonical, upstreamPort, "test");
    await sleep(50);

    const ws = await openWs(canonical);
    try {
      ws.send("hello");
      const ev = await nextMessage(ws);
      expect(ev.data).toBe("one:hello");
    } finally {
      ws.close();
      pm.stop("svc");
      upstream.stop(true);
    }
  });

  test("binary frames pass through", async () => {
    const [canonical, upstreamPort] = [nextPort(), nextPort()];
    const upstream = startWsEcho(upstreamPort, "bin");
    pm.start("svc", canonical, upstreamPort, "test");
    await sleep(50);

    const ws = await openWs(canonical);
    try {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      ws.send(bytes);
      const ev = await nextMessage(ws, (d) => d instanceof ArrayBuffer);
      const received = new Uint8Array(ev.data as ArrayBuffer);
      expect(Array.from(received)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      ws.close();
      pm.stop("svc");
      upstream.stop(true);
    }
  });

  test("forwards Sec-WebSocket-Protocol to upstream", async () => {
    const [canonical, upstreamPort] = [nextPort(), nextPort()];
    const upstream = startWsEcho(upstreamPort, "proto");
    pm.start("svc", canonical, upstreamPort, "test");
    await sleep(50);

    const ws = await openWs(canonical, "hmr-v1");
    try {
      // echo upstream greets with `sub:<subprotocol>` on open
      const ev = await nextMessage(ws, (d) => typeof d === "string" && (d as string).startsWith("sub:"));
      expect(ev.data).toBe("sub:hmr-v1");
    } finally {
      ws.close();
      pm.stop("svc");
      upstream.stop(true);
    }
  });

  test("setUpstream closes live bridges with code 1012", async () => {
    const [canonical, port1, port2] = [nextPort(), nextPort(), nextPort()];
    const up1 = startWsEcho(port1, "one");
    const up2 = startWsEcho(port2, "two");
    pm.start("svc", canonical, port1, "test");
    await sleep(50);

    const ws = await openWs(canonical);
    // prove it's connected to up1
    ws.send("ping");
    const first = await nextMessage(ws);
    expect(first.data).toBe("one:ping");

    // hot-swap — live bridge should be closed
    pm.setUpstream("svc", port2);
    const closeEv = await waitClose(ws);
    expect(closeEv.code).toBe(1012);

    // reconnect should hit the new upstream
    const ws2 = await openWs(canonical);
    try {
      ws2.send("ping");
      const ev = await nextMessage(ws2);
      expect(ev.data).toBe("two:ping");
    } finally {
      ws2.close();
      pm.stop("svc");
      up1.stop(true);
      up2.stop(true);
    }
  });

  test("stop closes live bridges", async () => {
    const [canonical, upstreamPort] = [nextPort(), nextPort()];
    const upstream = startWsEcho(upstreamPort, "x");
    pm.start("svc", canonical, upstreamPort, "test");
    await sleep(50);

    const ws = await openWs(canonical);
    try {
      pm.stop("svc");
      const ev = await waitClose(ws);
      // Any close code is acceptable — the point is that the bridge was torn down
      // (server.stop(true) and our explicit close race, resulting codes vary).
      expect(ev).toBeDefined();
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    } finally {
      upstream.stop(true);
    }
  });

  test("upstream close propagates to client", async () => {
    const [canonical, upstreamPort] = [nextPort(), nextPort()];
    const upstream = startWsEcho(upstreamPort, "x");
    pm.start("svc", canonical, upstreamPort, "test");
    await sleep(50);

    const ws = await openWs(canonical);
    try {
      upstream.stop(true);
      const ev = await waitClose(ws, 2000);
      expect(ev).toBeDefined();
    } finally {
      pm.stop("svc");
    }
  });
});

// ── pause / resume + initiator ──────────────────────────────────────────────

describe("pause and resume", () => {
  test("list() and getStatus() surface the initiator", () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    pm.start("svc", canonical, upstream, "runner:foo");
    const info = pm.list().find((e) => e.id === "svc");
    expect(info?.initiator).toBe("runner:foo");
    expect(info?.paused).toBe(false);
    expect(info?.running).toBe(true);
    expect(pm.getStatus("svc")?.initiator).toBe("runner:foo");
    pm.stop("svc");
  });

  test("pause frees the canonical port but keeps the entry", async () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    const up = startUpstream(upstream, "hi");
    try {
      pm.start("svc", canonical, upstream, "runner:x");
      await sleep(20);

      // Port is bound — a second Bun.serve on the same port should fail.
      expect(() => Bun.serve({ port: canonical, fetch: () => new Response() }).stop(true))
        .toThrow();

      pm.pause("svc");
      await sleep(20);

      const info = pm.list().find((e) => e.id === "svc");
      expect(info?.paused).toBe(true);
      expect(info?.running).toBe(false);
      expect(info?.initiator).toBe("runner:x");

      // Port is now free — we can bind it ourselves.
      const squatter = Bun.serve({ port: canonical, fetch: () => new Response("squat") });
      squatter.stop(true);
    } finally {
      pm.stop("svc");
      up.stop(true);
    }
  });

  test("resume rebinds the canonical port with the remembered upstream", async () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    const up = startUpstream(upstream, "live");
    try {
      pm.start("svc", canonical, upstream, "runner:x");
      pm.pause("svc");
      await sleep(20);

      pm.resume("svc");
      await sleep(20);

      const res = await fetch(`http://localhost:${canonical}/`);
      expect(await res.text()).toBe("live");

      const info = pm.getStatus("svc");
      expect(info?.paused).toBe(false);
      expect(info?.upstreamPort).toBe(upstream);
      expect(info?.initiator).toBe("runner:x");
    } finally {
      pm.stop("svc");
      up.stop(true);
    }
  });

  test("pause is a no-op on already-paused entry", () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    pm.start("svc", canonical, upstream, "test");
    pm.pause("svc");
    pm.pause("svc"); // second call — should not throw, should stay paused
    expect(pm.getStatus("svc")?.paused).toBe(true);
    pm.stop("svc");
  });

  test("resume is a no-op on a running entry", () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    pm.start("svc", canonical, upstream, "test");
    pm.resume("svc"); // not paused — no-op
    expect(pm.getStatus("svc")?.paused).toBe(false);
    pm.stop("svc");
  });

  test("pause/resume on unknown id is a no-op", () => {
    expect(() => pm.pause("nope")).not.toThrow();
    expect(() => pm.resume("nope")).not.toThrow();
    expect(pm.getStatus("nope")).toBeNull();
  });

  test("stop on a paused entry removes it", () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    pm.start("svc", canonical, upstream, "test");
    pm.pause("svc");
    pm.stop("svc");
    expect(pm.getStatus("svc")).toBeNull();
  });

  test("start replaces a paused entry with a fresh initiator", async () => {
    const [canonical, upstream] = [nextPort(), nextPort()];
    const up = startUpstream(upstream, "v2");
    try {
      pm.start("svc", canonical, upstream, "runner:a");
      pm.pause("svc");
      pm.start("svc", canonical, upstream, "runner:b");
      await sleep(20);
      const info = pm.getStatus("svc");
      expect(info?.paused).toBe(false);
      expect(info?.initiator).toBe("runner:b");
    } finally {
      pm.stop("svc");
      up.stop(true);
    }
  });
});
