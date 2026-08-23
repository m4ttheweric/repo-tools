import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { traySocketPath, trayRequest } from "../daemon-client.ts";

describe("traySocketPath", () => {
  const originalEnv = process.env.RT_APP_SOCKET;
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.RT_APP_SOCKET;
    else process.env.RT_APP_SOCKET = originalEnv;
    process.env.HOME = originalHome;
  });

  test("RT_APP_SOCKET wins over the default path when set", () => {
    process.env.RT_APP_SOCKET = "/nonexistent.sock";
    expect(traySocketPath()).toBe("/nonexistent.sock");
  });

  test("resolves HOME at call time, not at module load", () => {
    // The endsWith check this test used to make would pass even under
    // module-load resolution, because the bun preload repoints HOME before
    // any module loads — mutating HOME after import is the only way to
    // actually exercise call-time resolution. Mirrors
    // lib/__tests__/rt-paths.test.ts's logsDir guard.
    delete process.env.RT_APP_SOCKET;
    process.env.HOME = "/tmp/tray-home-1";
    expect(traySocketPath()).toBe("/tmp/tray-home-1/.mattstack/rt/tray.sock");
    process.env.HOME = "/tmp/tray-home-2";
    expect(traySocketPath()).toBe("/tmp/tray-home-2/.mattstack/rt/tray.sock");
  });
});

describe("trayRequest", () => {
  const originalEnv = process.env.RT_APP_SOCKET;

  beforeEach(() => {
    process.env.RT_APP_SOCKET = "/nonexistent.sock";
  });

  afterEach(() => {
    // Unconditional delete here would clear a genuinely-set RT_APP_SOCKET
    // (exactly what the app sets when it spawns rt) for every test that
    // runs afterwards in this shared bun test process — restore, don't clear.
    if (originalEnv === undefined) delete process.env.RT_APP_SOCKET;
    else process.env.RT_APP_SOCKET = originalEnv;
  });

  test("resolves {status:0, json:null} instead of throwing when the socket is absent", async () => {
    const reply = await trayRequest("/health");
    expect(reply).toEqual({ status: 0, json: null });
  });

  test("tolerates a non-JSON response body — status carries through, json is null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-tray-test-"));
    const sockPath = join(dir, "tray.sock");
    const server = Bun.serve({ unix: sockPath, fetch: () => new Response("not json", { status: 200 }) });
    process.env.RT_APP_SOCKET = sockPath;
    try {
      const reply = await trayRequest("/whatever");
      expect(reply).toEqual({ status: 200, json: null });
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
