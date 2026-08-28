/**
 * S081: daemon-client's timed-out/refused attribution used to live in
 * module-level flags (`_lastQueryTimedOut`/`_lastQueryWasRefused`) shared
 * across every concurrent query. A fast query resolving in between a slow
 * query's own trySocketQuery call and the moment its caller reads
 * lastQueryTimedOut() could reset those flags out from under it — the slow
 * query's caller would then see "daemon unavailable" for a call that
 * actually just exceeded its own window. daemonQueryAttributed returns the
 * failure kind alongside the response instead, so it can never be
 * clobbered by an unrelated concurrent call.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DAEMON_SOCK_PATH, TRAY_SOCK_PATH, markDaemonInstalled, markDaemonUninstalled } from "../daemon-config.ts";
import { daemonQueryAttributed } from "../daemon-client.ts";

describe("daemonQueryAttributed", () => {
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    markDaemonInstalled();
    server = Bun.serve({
      unix: DAEMON_SOCK_PATH,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/slow") {
          await new Promise(() => {}); // never resolves — the client's own AbortSignal.timeout fires
        }
        return new Response(JSON.stringify({ ok: true, data: {} }), { headers: { "Content-Type": "application/json" } });
      },
    });
  });

  afterEach(() => {
    server.stop(true);
    markDaemonUninstalled();
  });

  test("a slow query that times out reports timedOut:true even resolved after a concurrent fast success", async () => {
    const slow = daemonQueryAttributed("slow", {}, 50);
    const fast = await daemonQueryAttributed("fast", {});
    expect(fast.response?.ok).toBe(true);
    expect(fast.timedOut).toBe(false);

    const slowResult = await slow;
    expect(slowResult.response).toBeNull();
    expect(slowResult.timedOut).toBe(true);
    expect(slowResult.refused).toBe(false);
  });

  test("a fast query's own success is reported correctly even started after a slow one is already in flight", async () => {
    const slow = daemonQueryAttributed("slow", {}, 200);
    const fast = await daemonQueryAttributed("fast", {});
    expect(fast.response?.ok).toBe(true);
    expect(fast.timedOut).toBe(false);
    await slow; // drain — this one times out at 200ms, don't leave it dangling
  });
});

// S082: auto-start retried the real query exactly once, 300ms after asking
// the tray to start the daemon — but parkUntilIntended's own socket probe,
// state.db open, and the identity migration routinely take longer than
// that, so a start that genuinely succeeds still gets reported as
// "installed but not running".
describe("auto-start bounded poll (S082)", () => {
  const origRtAppSocket = process.env.RT_APP_SOCKET;
  let daemonServer: ReturnType<typeof Bun.serve> | undefined;
  let traySock: string | undefined;
  let trayServer: ReturnType<typeof Bun.serve> | undefined;
  let bindTimer: ReturnType<typeof setTimeout> | undefined;

  beforeEach(() => {
    markDaemonInstalled();
  });

  afterEach(() => {
    if (bindTimer) clearTimeout(bindTimer);
    daemonServer?.stop(true);
    trayServer?.stop(true);
    markDaemonUninstalled();
    if (origRtAppSocket === undefined) delete process.env.RT_APP_SOCKET;
    else process.env.RT_APP_SOCKET = origRtAppSocket;
  });

  test("a restart that takes longer than 300ms to bind its socket is still picked up, not reported down", async () => {
    // attemptRestart() reads the fixed TRAY_SOCK_PATH (not RT_APP_SOCKET),
    // so the fake tray must listen there.
    trayServer = Bun.serve({
      unix: TRAY_SOCK_PATH,
      fetch: () => new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }),
    });

    // No real daemon socket exists yet — simulates the gap between the tray
    // accepting /daemon/start and the daemon actually binding rt.sock.
    bindTimer = setTimeout(() => {
      daemonServer = Bun.serve({
        unix: DAEMON_SOCK_PATH,
        fetch: () => new Response(JSON.stringify({ ok: true, data: {} }), { headers: { "Content-Type": "application/json" } }),
      });
    }, 600);

    const result = await daemonQueryAttributed("ping", {}, 200);
    expect(result.response?.ok).toBe(true);
  }, 5000);
});
