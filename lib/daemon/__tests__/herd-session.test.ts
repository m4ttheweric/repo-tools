import { describe, test, expect } from "bun:test";
import { join } from "path";
import pino from "pino";
import { createHiddenSession, hiddenSocketPath } from "../herd-session.ts";

const log = pino({ level: "silent" });

describe("hidden herd session", () => {
  test("socket path is the named-session socket under the config dir", () => {
    expect(hiddenSocketPath("/h")).toBe("/h/.config/herdr/sessions/herd/herdr.sock");
  });

  test("ensure returns immediately when the server is already up", async () => {
    const spawned: string[][] = [];
    const s = createHiddenSession({ log, home: "/h", available: async () => true, spawn: (argv) => { spawned.push(argv); } });
    expect(await s.ensure()).toBe("/h/.config/herdr/sessions/herd/herdr.sock");
    expect(spawned).toEqual([]);
  });

  test("ensure spawns `herdr server` through nohup in a job-control shell, with HERDR_SESSION and no HERDR_SOCKET_PATH, then waits for the socket", async () => {
    let calls = 0;
    const spawned: Array<{ argv: string[]; env: Record<string, string>; logPath: string }> = [];
    const s = createHiddenSession({
      log, home: "/h", logDir: "/h/logs", readyTimeoutMs: 500,
      available: async () => ++calls > 2,
      spawn: (argv, env, logPath) => { spawned.push({ argv, env, logPath }); },
    });
    await s.ensure();
    expect(spawned[0]!.argv.slice(0, 2)).toEqual(["/bin/bash", "-c"]);
    expect(spawned[0]!.argv[2]).toContain("set -m");
    expect(spawned[0]!.argv[2]).toContain("nohup");
    expect(spawned[0]!.argv.slice(-2)).toEqual([expect.stringMatching(/herdr$/), join("/h/logs", "herd-session.log")]);
    expect(spawned[0]!.env.HERDR_SESSION).toBe("herd");
    expect("HERDR_SOCKET_PATH" in spawned[0]!.env).toBe(false);
    expect(spawned[0]!.logPath).toBe(join("/h/logs", "herd-session.log"));
  });

  test("ensure fails loudly when the socket never appears", async () => {
    const s = createHiddenSession({ log, home: "/h", readyTimeoutMs: 50, available: async () => false, spawn: () => {} });
    await expect(s.ensure()).rejects.toThrow(/did not come up/);
  });

  test("concurrent ensures join the launch already running instead of spawning a second server", async () => {
    let calls = 0;
    const spawned: string[][] = [];
    const s = createHiddenSession({
      log, home: "/h", logDir: "/h/logs", readyTimeoutMs: 500,
      available: async () => ++calls > 2,
      spawn: (argv) => { spawned.push(argv); },
    });
    const [a, b] = await Promise.all([s.ensure(), s.ensure()]);
    expect(spawned).toHaveLength(1);
    expect(a).toBe("/h/.config/herdr/sessions/herd/herdr.sock");
    expect(b).toBe(a);
  });

  test("a retry after a timed-out launch refuses to spawn a second server", async () => {
    const spawned: string[][] = [];
    const s = createHiddenSession({
      log, home: "/h", logDir: "/h/logs", readyTimeoutMs: 50,
      available: async () => false,
      spawn: (argv) => { spawned.push(argv); },
    });
    await expect(s.ensure()).rejects.toThrow(/did not come up/);
    await expect(s.ensure()).rejects.toThrow(/has not bound/);
    expect(spawned).toHaveLength(1);
  });

  // A crash right after a successful bind must not read as "still within
  // this spawn's cooldown": the stamp clears on the success path, so a
  // socket that vanishes afterward gets a fresh spawn attempt, not the
  // misleading "has not bound yet" refusal.
  test("a successful ensure resets the spawn stamp so a socket that later disappears relaunches", async () => {
    const spawned: string[][] = [];
    let up = false; let spawnCount = 0;
    const s = createHiddenSession({
      log, home: "/h", logDir: "/h/logs", readyTimeoutMs: 200,
      available: async () => up,
      spawn: (argv) => { spawned.push(argv); spawnCount += 1; if (spawnCount === 1) up = true; },
    });
    expect(await s.ensure()).toBe("/h/.config/herdr/sessions/herd/herdr.sock");
    expect(spawned).toHaveLength(1);
    up = false;
    await expect(s.ensure()).rejects.toThrow(/did not come up/);
    expect(spawned).toHaveLength(2);
  });

  test("stop resets the spawn stamp so a subsequent ensure is not blocked by the cooldown", async () => {
    const spawned: string[][] = [];
    const s = createHiddenSession({
      log, home: "/h", logDir: "/h/logs", readyTimeoutMs: 50,
      available: async () => false,
      spawn: (argv) => { spawned.push(argv); },
      run: async () => ({ exitCode: 0, stdout: "" }),
    });
    await expect(s.ensure()).rejects.toThrow(/did not come up/);
    expect(spawned).toHaveLength(1);
    await s.stop();
    await expect(s.ensure()).rejects.toThrow(/did not come up/);
    expect(spawned).toHaveLength(2);
  });

  test("stop runs `herdr session stop herd` without HERDR_SOCKET_PATH", async () => {
    const runs: Array<{ argv: string[]; env: Record<string, string> }> = [];
    const s = createHiddenSession({ log, home: "/h", run: async (argv, env) => { runs.push({ argv, env }); return { exitCode: 0, stdout: "" }; } });
    await s.stop();
    expect(runs[0]!.argv.slice(-3)).toEqual(["session", "stop", "herd"]);
    expect("HERDR_SOCKET_PATH" in runs[0]!.env).toBe(false);
  });
});
