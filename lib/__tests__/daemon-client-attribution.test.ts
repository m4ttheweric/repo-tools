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
import { DAEMON_SOCK_PATH, markDaemonInstalled, markDaemonUninstalled } from "../daemon-config.ts";
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
