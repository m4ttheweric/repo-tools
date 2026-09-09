import { describe, test, expect } from "bun:test";
import { join } from "path";
import pino from "pino";
import type { Logger } from "pino";
import { createBgService, bgSocketPath } from "../bg-service.ts";

const log = pino({ level: "silent" });

/** Never lands real subprocess calls: the login-shell env probe and the
    parity probes both go through this unless a test overrides them. */
const fixedEnvLines = ["/probed/bin", "/probed/home", "/probed/bin/zsh", "/probed/tmp", "en_US.UTF-8"];
const quietRun = async () => ({ exitCode: 0, stdout: fixedEnvLines.join("\n") });
const matchingProbe = async () => "bun\nnode\nclaude\nrt\ngit\n/probed/bin";

function silent(warns?: unknown[][]): Logger {
  return {
    info: () => {},
    warn: (...a: unknown[]) => { warns?.push(a); },
    error: () => {},
    debug: () => {},
  } as unknown as Logger;
}

describe("bg service", () => {
  test("socket path is the named-session socket under the config dir", () => {
    expect(bgSocketPath("/h")).toBe("/h/.config/herdr/sessions/bg/herdr.sock");
  });

  test("ensure returns immediately when the server is already up", async () => {
    const spawned: string[][] = [];
    const s = createBgService({ log, home: "/h", available: async () => true, spawn: (argv) => { spawned.push(argv); } });
    expect(await s.ensure()).toEqual({ socket: "/h/.config/herdr/sessions/bg/herdr.sock", started: false });
    expect(spawned).toEqual([]);
  });

  test("ensure spawns `herdr server` through nohup in a job-control shell, with HERDR_SESSION and no HERDR_SOCKET_PATH, then waits for the socket", async () => {
    let calls = 0;
    const spawned: Array<{ argv: string[]; env: Record<string, string>; logPath: string }> = [];
    const s = createBgService({
      log, home: "/h", logDir: "/h/logs", readyTimeoutMs: 500,
      available: async () => ++calls > 2,
      spawn: (argv, env, logPath) => { spawned.push({ argv, env, logPath }); },
      run: quietRun,
      probePane: matchingProbe,
    });
    const result = await s.ensure();
    expect(result).toEqual({ socket: "/h/.config/herdr/sessions/bg/herdr.sock", started: true });
    expect(spawned[0]!.argv.slice(0, 2)).toEqual(["/bin/bash", "-c"]);
    expect(spawned[0]!.argv[2]).toContain("set -m");
    expect(spawned[0]!.argv[2]).toContain("nohup");
    expect(spawned[0]!.argv.slice(-2)).toEqual([expect.stringMatching(/herdr$/), join("/h/logs", "bg-service.log")]);
    expect(spawned[0]!.env.HERDR_SESSION).toBe("bg");
    expect("HERDR_SOCKET_PATH" in spawned[0]!.env).toBe(false);
    expect(spawned[0]!.logPath).toBe(join("/h/logs", "bg-service.log"));
  });

  test("ensure fails loudly when the socket never appears", async () => {
    const s = createBgService({ log, home: "/h", readyTimeoutMs: 50, available: async () => false, spawn: () => {}, run: quietRun });
    await expect(s.ensure()).rejects.toThrow(/did not come up/);
  });

  test("concurrent ensures join the launch already running instead of spawning a second server", async () => {
    let calls = 0;
    const spawned: string[][] = [];
    const s = createBgService({
      log, home: "/h", logDir: "/h/logs", readyTimeoutMs: 500,
      available: async () => ++calls > 2,
      spawn: (argv) => { spawned.push(argv); },
      run: quietRun,
      probePane: matchingProbe,
    });
    const [a, b] = await Promise.all([s.ensure(), s.ensure()]);
    expect(spawned).toHaveLength(1);
    expect(a).toEqual({ socket: "/h/.config/herdr/sessions/bg/herdr.sock", started: true });
    expect(b).toEqual(a);
  });

  test("a retry after a timed-out launch refuses to spawn a second server", async () => {
    const spawned: string[][] = [];
    const s = createBgService({
      log, home: "/h", logDir: "/h/logs", readyTimeoutMs: 50,
      available: async () => false,
      spawn: (argv) => { spawned.push(argv); },
      run: quietRun,
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
    const s = createBgService({
      log, home: "/h", logDir: "/h/logs", readyTimeoutMs: 200,
      available: async () => up,
      spawn: (argv) => { spawned.push(argv); spawnCount += 1; if (spawnCount === 1) up = true; },
      run: quietRun,
      probePane: matchingProbe,
    });
    expect(await s.ensure()).toEqual({ socket: "/h/.config/herdr/sessions/bg/herdr.sock", started: true });
    expect(spawned).toHaveLength(1);
    up = false;
    await expect(s.ensure()).rejects.toThrow(/did not come up/);
    expect(spawned).toHaveLength(2);
  });

  test("stop resets the spawn stamp so a subsequent ensure is not blocked by the cooldown", async () => {
    const spawned: string[][] = [];
    const s = createBgService({
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

  test("stop runs `herdr session stop bg` without HERDR_SOCKET_PATH", async () => {
    const runs: Array<{ argv: string[]; env: Record<string, string> }> = [];
    const s = createBgService({ log, home: "/h", run: async (argv, env) => { runs.push({ argv, env }); return { exitCode: 0, stdout: "" }; } });
    await s.stop();
    expect(runs[0]!.argv.slice(-3)).toEqual(["session", "stop", "bg"]);
    expect("HERDR_SOCKET_PATH" in runs[0]!.env).toBe(false);
  });

  test("ensure seeds the spawned server's env from the login-shell probe, overriding the daemon's own PATH", async () => {
    let calls = 0;
    const spawned: Array<{ env: Record<string, string> }> = [];
    const runs: Array<{ argv: string[]; env: Record<string, string> }> = [];
    const s = createBgService({
      log, home: "/h", logDir: "/h/logs", readyTimeoutMs: 500,
      available: async () => ++calls > 2,
      spawn: (argv, env) => { spawned.push({ env }); },
      run: async (argv, env) => { runs.push({ argv, env }); return { exitCode: 0, stdout: fixedEnvLines.join("\n") }; },
      probePane: matchingProbe,
    });
    await s.ensure();
    expect(runs[0]!.argv).toEqual(["zsh", "-lc", 'printf "%s\\n" "$PATH" "$HOME" "$SHELL" "$TMPDIR" "$LANG"']);
    const env = spawned[0]!.env;
    expect(env.PATH).toBe(fixedEnvLines[0]);
    expect(env.HOME).toBe(fixedEnvLines[1]);
    expect(env.SHELL).toBe(fixedEnvLines[2]);
    expect(env.TMPDIR).toBe(fixedEnvLines[3]);
    expect(env.LANG).toBe(fixedEnvLines[4]);
    expect(env.HERDR_SESSION).toBe("bg");
    expect(env.PATH).not.toBe(process.env.PATH);
  });

  test("a failed login-shell probe warns and falls back to the daemon's own env, without failing ensure", async () => {
    const warns: unknown[][] = [];
    let calls = 0;
    const spawned: Array<{ env: Record<string, string> }> = [];
    const s = createBgService({
      log: silent(warns), home: "/h", logDir: "/h/logs", readyTimeoutMs: 500,
      available: async () => ++calls > 2,
      spawn: (argv, env) => { spawned.push({ env }); },
      run: async () => ({ exitCode: 1, stdout: "" }),
      probePane: matchingProbe,
    });
    const result = await s.ensure();
    expect(result.started).toBe(true);
    expect(spawned[0]!.env.PATH).toBe(process.env.PATH);
    expect(warns.some((a) => String(a[1] ?? "").includes("login-shell env probe"))).toBe(true);
  });

  test("a login-shell probe that throws also falls back to the daemon's own env, without failing ensure", async () => {
    const warns: unknown[][] = [];
    let calls = 0;
    const s = createBgService({
      log: silent(warns), home: "/h", logDir: "/h/logs", readyTimeoutMs: 500,
      available: async () => ++calls > 2,
      spawn: () => {},
      run: async () => { throw new Error("boom"); },
      probePane: matchingProbe,
    });
    const result = await s.ensure();
    expect(result.started).toBe(true);
    expect(warns.some((a) => String(a[1] ?? "").includes("login-shell env probe"))).toBe(true);
  });

  test("a fresh start runs a parity probe and records drift when a binary resolves differently", async () => {
    let calls = 0;
    const probes: Array<string | null> = [];
    const s = createBgService({
      log, home: "/h", logDir: "/h/logs", readyTimeoutMs: 500,
      available: async () => ++calls > 2,
      spawn: () => {},
      run: quietRun,
      probePane: async (socket) => {
        probes.push(socket);
        return socket === null
          ? "/usr/local/bin/bun\nnode\nclaude\n/usr/local/bin/rt\ngit\n/visible/path"
          : "/opt/bun\nnode\nclaude\n/opt/rt\ngit\n/bg/path";
      },
    });
    await s.ensure();
    expect(probes).toEqual(["/h/.config/herdr/sessions/bg/herdr.sock", null]);
    const parity = s.lastParity();
    expect(parity?.ok).toBe(false);
    expect(parity?.drift.some((d) => d.startsWith("bun:"))).toBe(true);
    expect(parity?.drift.some((d) => d.startsWith("rt:"))).toBe(true);
    expect(parity?.drift.some((d) => d.startsWith("PATH:"))).toBe(true);
    expect(parity?.drift.some((d) => d.startsWith("node:"))).toBe(false);
  });

  test("a fresh start with matching probes records ok parity and no drift", async () => {
    let calls = 0;
    const s = createBgService({
      log, home: "/h", logDir: "/h/logs", readyTimeoutMs: 500,
      available: async () => ++calls > 2,
      spawn: () => {},
      run: quietRun,
      probePane: matchingProbe,
    });
    await s.ensure();
    expect(s.lastParity()).toEqual({ ok: true, drift: [] });
  });

  test("a parity probe failure is tolerated: ensure still returns the socket and warns, lastParity stays null", async () => {
    const warns: unknown[][] = [];
    let calls = 0;
    const s = createBgService({
      log: silent(warns), home: "/h", logDir: "/h/logs", readyTimeoutMs: 500,
      available: async () => ++calls > 2,
      spawn: () => {},
      run: quietRun,
      probePane: async () => { throw new Error("herdr not found"); },
    });
    const result = await s.ensure();
    expect(result).toEqual({ socket: "/h/.config/herdr/sessions/bg/herdr.sock", started: true });
    expect(s.lastParity()).toBeNull();
    expect(warns.some((a) => String(a[1] ?? "").includes("parity probe failed"))).toBe(true);
  });

  test("reprobe re-runs both probes against a running server and updates lastParity", async () => {
    const s = createBgService({
      log, home: "/h",
      available: async () => true,
      probePane: async (socket) => (socket === null ? "same" : "same"),
    });
    expect(s.lastParity()).toBeNull();
    const report = await s.reprobe();
    expect(report).toEqual({ ok: true, drift: [] });
    expect(s.lastParity()).toEqual(report);
  });
});
