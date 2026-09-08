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

  test("stop runs `herdr session stop herd` without HERDR_SOCKET_PATH", async () => {
    const runs: Array<{ argv: string[]; env: Record<string, string> }> = [];
    const s = createHiddenSession({ log, home: "/h", run: async (argv, env) => { runs.push({ argv, env }); return { exitCode: 0, stdout: "" }; } });
    await s.stop();
    expect(runs[0]!.argv.slice(-3)).toEqual(["session", "stop", "herd"]);
    expect("HERDR_SOCKET_PATH" in runs[0]!.env).toBe(false);
  });
});
