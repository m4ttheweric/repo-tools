import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { createTestHome, rt, RT_BINARY } from "../harness.ts";

async function waitForSocket(sockPath: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(sockPath)) {
    if (Date.now() > deadline) throw new Error(`daemon socket never appeared at ${sockPath}`);
    await Bun.sleep(100);
  }
}

/** Grab a free TCP port by binding port 0 and releasing it. */
function freePort(): number {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = srv.port;
  srv.stop(true);
  if (!port) throw new Error("failed to allocate a free port");
  return port;
}

describe("fatal boot", () => {
  // These three used to assert a crash (S043 pre-fix: EADDRINUSE on the API
  // port took the daemon down the fatal boot-failed path). The integration
  // job's I5(a) wiring (lib/daemon.ts's withApiPortParkRetry around
  // startApiServer, docs/daemon-api-auth.md's S043 caller-side contract)
  // makes this recoverable instead: the daemon parks and retries with
  // backoff rather than crashing, so it now boots successfully once the
  // squatted port frees.
  test("daemon parks (does not crash) while the API port is squatted, and boots once it frees", async () => {
    const { path: home, cleanup } = createTestHome();
    const bunDir = join(process.execPath, "..");
    const port = 9411;
    const rtDir = join(home, ".mattstack", "rt");
    const squatter = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("busy") });
    let daemon: ReturnType<typeof Bun.spawn> | undefined;
    try {
      daemon = Bun.spawn([RT_BINARY, "--daemon"], {
        env: {
          HOME: home,
          PATH: `${join(RT_BINARY, "..")}:${bunDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,
          TERM: "xterm-256color",
          RT_SKIP_SETUP: "1",
          CI: "true",
          RT_API_PORT: String(port),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      // Give bindApiServerWithRetry's own ~3s inner retry a full cycle to
      // exhaust and reach the outer park-retry loop; it must still be alive
      // (parked, not crashed) and must not have written rt.sock/rt.pid yet
      // (neither server has bound).
      await Bun.sleep(4_000);
      expect(daemon.exitCode).toBeNull();
      expect(existsSync(join(rtDir, "rt.sock"))).toBe(false);
      expect(existsSync(join(rtDir, "rt.pid"))).toBe(false);

      squatter.stop(true);

      await waitForSocket(join(rtDir, "rt.sock"), 40_000);
      expect(daemon.exitCode).toBeNull();
      expect(existsSync(join(rtDir, "rt.pid"))).toBe(true);
    } finally {
      squatter.stop(true);
      try { daemon?.kill(); } catch { /* already gone */ }
      await daemon?.exited;
      cleanup();
    }
  }, 60_000);

  test("daemon status --json never claims 'running' while parked on a squatted API port, and does once it recovers", async () => {
    const { path: home, cleanup } = createTestHome();
    const bunDir = join(process.execPath, "..");
    // A different port than the sibling test above, so parallel test files
    // can never collide on the same bound TCP port.
    const port = 9412;
    const rtDir = join(home, ".mattstack", "rt");
    const squatter = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("busy") });
    let daemon: ReturnType<typeof Bun.spawn> | undefined;
    try {
      // `rt daemon status` short-circuits to "not installed" before it ever
      // reaches a liveness classification, install first.
      await rt(["daemon", "install"], { home });

      daemon = Bun.spawn([RT_BINARY, "--daemon"], {
        env: {
          HOME: home,
          PATH: `${join(RT_BINARY, "..")}:${bunDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,
          TERM: "xterm-256color",
          RT_SKIP_SETUP: "1",
          CI: "true",
          RT_API_PORT: String(port),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      await Bun.sleep(4_000);
      expect(daemon.exitCode).toBeNull();

      const parked = await rt(["daemon", "status", "--json"], { home, env: { RT_API_PORT: String(port) } });
      expect(parked.exitCode).toBe(0);
      expect(JSON.parse(parked.stdout).state).not.toBe("running");

      squatter.stop(true);
      await waitForSocket(join(rtDir, "rt.sock"), 40_000);

      const recovered = await rt(["daemon", "status", "--json"], { home, env: { RT_API_PORT: String(port) } });
      expect(recovered.exitCode).toBe(0);
      expect(JSON.parse(recovered.stdout).state).toBe("running");
    } finally {
      squatter.stop(true);
      try { daemon?.kill(); } catch { /* already gone */ }
      await daemon?.exited;
      cleanup();
    }
  }, 60_000);

  test("a corrupt events.db self-heals (quarantined), and the daemon boots and serves", async () => {
    const { path: home, cleanup } = createTestHome();
    const bunDir = join(process.execPath, "..");
    let daemon: ReturnType<typeof Bun.spawn> | undefined;
    try {
      // Pre-create a corrupt events.db in the isolated HOME, before the
      // daemon ever runs; createEventsBus (module scope) opens it.
      const rtDir = join(home, ".mattstack", "rt");
      mkdirSync(rtDir, { recursive: true });
      writeFileSync(join(rtDir, "events.db"), "not a sqlite file at all");

      const apiPort = freePort();
      daemon = Bun.spawn([RT_BINARY, "--daemon"], {
        env: {
          HOME: home,
          PATH: `${join(RT_BINARY, "..")}:${bunDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,
          TERM: "xterm-256color",
          RT_SKIP_SETUP: "1",
          CI: "true",
          RT_API_PORT: String(apiPort),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      await waitForSocket(join(rtDir, "rt.sock"));
      expect(daemon.exitCode).toBeNull();

      // (a) the corrupt events.db was quarantined, not just failed on.
      expect(readdirSync(rtDir).some((f) => f.startsWith("events.db.corrupt-"))).toBe(true);

      // (b) the daemon actually boots and serves: a live round trip through
      // the recreated events.db proves it, not just the socket's existence.
      const served = await rt(["events", "emit", "e2e/corrupt-events-recover"], {
        home,
        env: { RT_API_PORT: String(apiPort) },
      });
      expect(served.exitCode).toBe(0);
    } finally {
      try { daemon?.kill(); } catch { /* already gone */ }
      await daemon?.exited;
      cleanup();
    }
  }, 60_000);
});

describe("daemon", () => {
  describe("install creates config", () => {
    let home: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ path: home, cleanup } = createTestHome());
    });

    afterAll(() => cleanup());

    test("rt daemon install creates daemon.json", async () => {
      const daemonJson = join(home, ".mattstack", "rt", "daemon.json");
      expect(existsSync(daemonJson)).toBe(false);

      const result = await rt(["daemon", "install"], { home });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("saved config");
      expect(existsSync(daemonJson)).toBe(true);
    }, 30_000);

    test("rt daemon status after install shows installed state", async () => {
      const result = await rt(["daemon", "status"], { home });

      expect(result.exitCode).toBe(0);
      const output = result.stdout;
      expect(output).toContain("installed");
    }, 30_000);
  });

  describe("status without install", () => {
    let home: string;
    let cleanup: () => void;

    beforeAll(() => {
      ({ path: home, cleanup } = createTestHome());
    });

    afterAll(() => cleanup());

    test("rt daemon status shows not installed", async () => {
      const result = await rt(["daemon", "status"], { home });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("not installed");
    });
  });
});

// Additive coverage for the health snapshot (level/reasons + metrics +
// eventLoop) that computeHealth (lib/daemon/health.ts) attaches to every
// status-shaped surface, and for the heartbeat file the loop monitor writes
// alongside it. A live foreground daemon on a per-run free RT_API_PORT, same
// pattern as e2e/tests/events.test.ts and e2e/tests/endpoint.test.ts.
describe("health surfaces", () => {
  let home: string;
  let cleanup: () => void;
  let apiPort = 0;
  let daemon: ReturnType<typeof Bun.spawn>;

  /** Grab a free TCP port by binding port 0 and releasing it. */
  function freePort(): number {
    const srv = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = srv.port;
    srv.stop(true);
    if (!port) throw new Error("failed to allocate a free port");
    return port;
  }

  beforeAll(async () => {
    apiPort = freePort();
    ({ path: home, cleanup } = createTestHome());
    // `rt daemon status` short-circuits to "not installed" before it ever
    // reaches a liveness classification, install first.
    await rt(["daemon", "install"], { home });
    const bunDir = join(process.execPath, "..");
    daemon = Bun.spawn([RT_BINARY, "--daemon"], {
      env: {
        HOME: home,
        PATH: `${join(RT_BINARY, "..")}:${bunDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,
        TERM: "xterm-256color",
        RT_SKIP_SETUP: "1",
        CI: "true",
        RT_API_PORT: String(apiPort),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForSocket(join(home, ".mattstack", "rt", "rt.sock"));
    if (daemon.exitCode !== null) {
      throw new Error(
        `daemon process exited (code ${daemon.exitCode}) right after creating its socket ` +
          `(port ${apiPort} collision or daemon boot crash; check the daemon's stderr).`,
      );
    }
  }, 60_000);

  afterAll(async () => {
    try { daemon?.kill(); } catch { /* already gone */ }
    await daemon?.exited;
    cleanup();
  });

  function expectHealthLevel(level: unknown) {
    expect(["ok", "degraded", "unhealthy"]).toContain(level as string);
  }

  test("rt daemon status --json carries health, metrics, and eventLoop, additive to the existing fields", async () => {
    const result = await rt(["daemon", "status", "--json"], { home });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);

    // Pre-existing fields still present.
    expect(out.ok).toBe(true);
    expect(out.state).toBe("running");
    expect(typeof out.data.pid).toBe("number");
    expect(typeof out.data.watchedRepos).toBe("number");

    // New blocks.
    expectHealthLevel(out.data.health.level);
    expect(Array.isArray(out.data.health.reasons)).toBe(true);
    expect(typeof out.data.metrics.rss).toBe("number");
    expect(typeof out.data.eventLoop.maxLagMs).toBe("number");
  }, 30_000);

  test("GET /api/status (tray:status) carries health, metrics, and eventLoop, additive to the existing fields", async () => {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/status`);
    expect(res.status).toBe(200);
    const out = (await res.json()) as any;

    // Pre-existing fields still present.
    expect(out.ok).toBe(true);
    expect(typeof out.data.pid).toBe("number");
    expect(typeof out.data.memoryUsage).toBe("number");

    // New blocks.
    expectHealthLevel(out.data.health.level);
    expect(Array.isArray(out.data.health.reasons)).toBe(true);
    expect(typeof out.data.metrics.rss).toBe("number");
    expect(typeof out.data.eventLoop.maxLagMs).toBe("number");
  }, 15_000);

  test("ping over rt.sock carries the health level and eventLoop, additive to the existing fields", async () => {
    const sockPath = join(home, ".mattstack", "rt", "rt.sock");
    const res = await fetch("http://localhost/ping", {
      unix: sockPath,
      signal: AbortSignal.timeout(5_000),
    } as any);
    const out = (await res.json()) as any;

    // Pre-existing fields still present.
    expect(out.ok).toBe(true);
    expect(typeof out.uptime).toBe("number");
    expect(typeof out.pid).toBe("number");

    // New blocks. ping's `health` field is the level string itself (not an
    // object), unlike status/tray:status where health.level is nested.
    expectHealthLevel(out.health);
    expect(typeof out.eventLoop.maxLagMs).toBe("number");
  }, 15_000);

  test("a heartbeat file appears under the isolated HOME's RT_DIR within a few seconds", async () => {
    const heartbeatPath = join(home, ".mattstack", "rt", "daemon-heartbeat.json");
    const deadline = Date.now() + 5_000;
    while (!existsSync(heartbeatPath) && Date.now() < deadline) {
      await Bun.sleep(200);
    }
    expect(existsSync(heartbeatPath)).toBe(true);

    const hb = JSON.parse(readFileSync(heartbeatPath, "utf8"));
    expect(typeof hb.at).toBe("number");
    expect(typeof hb.seq).toBe("number");
  }, 10_000);
});
