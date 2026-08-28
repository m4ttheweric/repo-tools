/**
 * `rt daemon uninstall`/`start` — the CLI-side liveness guards (Task 14,
 * S027/S030/S028-CLI). Fakes the tray over a real Bun.serve on
 * TRAY_SOCK_PATH (same rig as commands/__tests__/settings-dev-mode.test.ts)
 * and, where a scenario needs "the daemon is live", a real Bun.serve on
 * DAEMON_SOCK_PATH answering /ping — isDaemonProcessRunning's pid check and
 * probeSocketHolder/isDaemonRunning's socket ping are both exercised for
 * real, never mocked module internals.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { start, uninstall } from "../daemon.ts";
import {
  DAEMON_CONFIG_PATH,
  DAEMON_PID_PATH,
  DAEMON_SOCK_PATH,
  RT_DIR,
  TRAY_SOCK_PATH,
  markDaemonInstalled,
} from "../../lib/daemon-config.ts";
import { resolveIntendedMode } from "../../lib/dev-mode.ts";

let servers: ReturnType<typeof Bun.serve>[] = [];
let logs: string[] = [];
const realLog = console.log;

function captureLogs(): void {
  logs = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
}

function serveTray(handlers: Record<string, () => Response>): void {
  servers.push(Bun.serve({
    unix: TRAY_SOCK_PATH,
    fetch(req) {
      const url = new URL(req.url);
      const handler = handlers[url.pathname];
      return handler ? handler() : new Response("not found", { status: 404 });
    },
  }));
}

/** A real listener on rt.sock that answers /ping — what both isDaemonRunning()
 *  (daemon-client.ts) and probeSocketHolder() (lib/daemon/park.ts) fetch.
 *  Flavor defaults to the CURRENT intended mode (not a hardcoded "prod") so
 *  start()'s post-liveness warnIfWrongFlavor() check never fires a spurious
 *  mismatch when this file runs after another test flips mattstack.mode in
 *  the shared isolated HOME `bun test` uses for the whole process. */
function serveDaemonPing(body?: Record<string, unknown>): void {
  const resolvedBody = body ?? { ok: true, pid: 4242, flavor: resolveIntendedMode().mode };
  servers.push(Bun.serve({
    unix: DAEMON_SOCK_PATH,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/ping") return Response.json(resolvedBody);
      return new Response("not found", { status: 404 });
    },
  }));
}

afterEach(() => {
  console.log = realLog;
  for (const s of servers) { try { s.stop(true); } catch { /* already stopped */ } }
  servers = [];
  for (const p of [DAEMON_SOCK_PATH, DAEMON_PID_PATH, TRAY_SOCK_PATH, DAEMON_CONFIG_PATH]) {
    try { rmSync(p); } catch { /* absent */ }
  }
});

describe("uninstall — liveness guard", () => {
  test("leaves rt.pid/daemon.json when isDaemonProcessRunning() says the daemon is alive", async () => {
    mkdirSync(RT_DIR, { recursive: true });
    markDaemonInstalled();
    writeFileSync(DAEMON_PID_PATH, String(process.pid)); // this test process is genuinely alive
    // tray unreachable: trayQuery('/daemon/stop') resolves null (no server on TRAY_SOCK_PATH)

    captureLogs();
    await uninstall();

    expect(existsSync(DAEMON_PID_PATH)).toBe(true); // cleanupDaemonFiles did NOT run
    expect(JSON.parse(readFileSync(DAEMON_CONFIG_PATH, "utf8")).installed).toBe(true); // markDaemonUninstalled did NOT run
    expect(logs.join("\n")).toContain("launchctl bootout");
  });

  test("leaves rt.sock/daemon.json when probeSocketHolder() finds a live holder (no rt.pid at all)", async () => {
    mkdirSync(RT_DIR, { recursive: true });
    markDaemonInstalled();
    serveDaemonPing();

    captureLogs();
    await uninstall();

    expect(JSON.parse(readFileSync(DAEMON_CONFIG_PATH, "utf8")).installed).toBe(true);
    expect(logs.join("\n")).toContain("launchctl bootout");
  });

  test("cleans up rt.sock/rt.pid/daemon.json when nothing is alive", async () => {
    mkdirSync(RT_DIR, { recursive: true });
    markDaemonInstalled();
    writeFileSync(DAEMON_PID_PATH, "999999"); // no such pid
    writeFileSync(DAEMON_SOCK_PATH, ""); // stale file, not a real listener — probeSocketHolder's fetch fails

    captureLogs();
    await uninstall();

    expect(existsSync(DAEMON_PID_PATH)).toBe(false);
    expect(JSON.parse(readFileSync(DAEMON_CONFIG_PATH, "utf8")).installed).toBe(false);
    expect(logs.join("\n")).not.toContain("launchctl bootout");
    expect(logs.join("\n")).toContain("daemon fully uninstalled");
  });
});

describe("start — kickstart escalation", () => {
  test("falls back to /daemon/restart when the tray acks /daemon/start but the socket never comes up", async () => {
    mkdirSync(RT_DIR, { recursive: true });
    markDaemonInstalled();
    let restartCalled = false;
    serveTray({
      "/daemon/start": () => Response.json({ ok: true }),
      "/daemon/restart": () => { restartCalled = true; return Response.json({ ok: true }); },
    });

    captureLogs();
    await start();

    expect(restartCalled).toBe(true);
  }, 20_000);

  test("escalation succeeds once /daemon/restart actually brings the socket up", async () => {
    mkdirSync(RT_DIR, { recursive: true });
    markDaemonInstalled();
    serveTray({
      "/daemon/start": () => Response.json({ ok: true }),
      "/daemon/restart": () => {
        serveDaemonPing();
        return Response.json({ ok: true });
      },
    });

    captureLogs();
    await start();

    expect(logs.join("\n")).toContain("daemon started");
  }, 20_000);
});
