import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
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
