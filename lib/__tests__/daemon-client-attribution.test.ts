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

// R5 (RT-91 wave-1 minor): attemptRestart used to run its own bounded
// isDaemonRunning() poll (sleep 250ms, then check, up to 12 times) before
// daemonQueryAttributed ran a SECOND bounded wait via waitForSocket(). The
// first loop's sleep-then-check order forces a needless fixed 250ms floor
// even when the daemon binds almost immediately, since it never checks
// before its first sleep. Collapsing to the single, already-shared
// waitForSocket() (which checks immediately, then sleeps at a tighter 150ms
// interval) should resolve a fast restart well under that 250ms floor.
describe("restart wait is not doubled (R5)", () => {
  let trayServer: ReturnType<typeof Bun.serve> | undefined;
  let daemonServer: ReturnType<typeof Bun.serve> | undefined;
  let bindTimer: ReturnType<typeof setTimeout> | undefined;

  beforeEach(() => {
    markDaemonInstalled();
  });

  afterEach(() => {
    if (bindTimer) clearTimeout(bindTimer);
    trayServer?.stop(true);
    daemonServer?.stop(true);
    markDaemonUninstalled();
  });

  test("a daemon that binds shortly after the tray ack is picked up in a single wait, not a 250ms-floor double wait", async () => {
    trayServer = Bun.serve({
      unix: TRAY_SOCK_PATH,
      fetch: () => new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }),
    });

    // Socket absent at call time (forces the restart path); bound 10ms in,
    // well before either loop's first real check would land.
    bindTimer = setTimeout(() => {
      daemonServer = Bun.serve({
        unix: DAEMON_SOCK_PATH,
        fetch: () => new Response(JSON.stringify({ ok: true, data: {} }), { headers: { "Content-Type": "application/json" } }),
      });
    }, 10);

    const start = Date.now();
    const result = await daemonQueryAttributed("ping", {}, 200);
    const elapsed = Date.now() - start;

    expect(result.response?.ok).toBe(true);
    // A single waitForSocket() wait catches this well inside its first
    // 150ms-interval check; attemptRestart's old internal loop could not
    // resolve before its first forced 250ms sleep elapsed.
    expect(elapsed).toBeLessThan(220);
  }, 5000);
});
