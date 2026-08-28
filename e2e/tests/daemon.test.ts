import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { createTestHome, rt } from "../harness.ts";

describe("fatal boot", () => {
  test("daemon boot with API port already bound exits non-zero and leaves no stale rt.pid", async () => {
    const { path: home, cleanup } = createTestHome();
    // Bind the API port inside the isolated HOME so the daemon cannot.
    const port = 9411;
    const squatter = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("busy") });
    try {
      const result = await rt(["--daemon"], { home, env: { RT_API_PORT: String(port) } });

      expect(result.exitCode).not.toBe(0);
      expect(existsSync(join(home, ".mattstack", "rt", "rt.pid"))).toBe(false);
    } finally {
      squatter.stop(true);
      cleanup();
    }
  }, 60_000);

  test("a corrupt events.db does not crash the daemon silently — error is captured", async () => {
    const { path: home, cleanup } = createTestHome();
    try {
      // Pre-create a corrupt events.db in the isolated HOME, before the
      // daemon ever runs — createEventsBus (module scope) throws opening it.
      const rtDir = join(home, ".mattstack", "rt");
      mkdirSync(rtDir, { recursive: true });
      writeFileSync(join(rtDir, "events.db"), "not a sqlite file at all");

      const result = await rt(["--daemon"], { home });

      expect(result.exitCode).not.toBe(0);
      // Task 4 makes this self-heal (quarantine + retry); for Task 3 we only
      // require the failure is captured, not that boot recovers.
      const stderrLog = join(rtDir, "logs", "daemon-stderr.log");
      const quarantined = existsSync(rtDir) && readdirSync(rtDir).some((f) => f.startsWith("events.db.corrupt-"));
      const captured = existsSync(stderrLog) || quarantined;
      expect(captured).toBe(true);
    } finally {
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
