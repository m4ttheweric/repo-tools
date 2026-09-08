/**
 * The hidden herd: a named headless herdr server whose panes never appear
 * in the attached UI. HERDR_SOCKET_PATH must be ABSENT from the env of every
 * command aimed at it: herdr injects that variable into managed panes and
 * it outranks HERDR_SESSION, so leaving it in would silently target the
 * visible session (verified on herdr 0.7.5).
 */
import { homedir } from "os";
import { join, dirname } from "path";
import { mkdirSync } from "fs";
import type { Logger } from "pino";
import { herdrAvailable } from "../herdr/client.ts";
import { resolveHerdrBin } from "../agent-herdr.ts";
import { runCapture } from "../subprocess.ts";

export const HIDDEN_SESSION = "herd";

export function hiddenSocketPath(home: string = process.env.HOME ?? homedir()): string {
  return join(home, ".config", "herdr", "sessions", HIDDEN_SESSION, "herdr.sock");
}

function envWithoutSocket(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k !== "HERDR_SOCKET_PATH" && v !== undefined) env[k] = v;
  return { ...env, ...extra };
}

export function createHiddenSession(opts: {
  log: Logger;
  spawn?: (argv: string[], env: Record<string, string>, logPath: string) => void;
  available?: (sock: string) => Promise<boolean>;
  run?: (argv: string[], env: Record<string, string>) => Promise<{ exitCode: number; stdout: string }>;
  home?: string;
  logDir?: string;
  readyTimeoutMs?: number;
}) {
  const home = opts.home ?? process.env.HOME ?? homedir();
  const logDir = opts.logDir ?? join(home, ".mattstack", "rt", "logs");
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;
  const available = opts.available ?? herdrAvailable;
  const sock = hiddenSocketPath(home);
  // Bun.spawn has no detached mode, and launchd kills the daemon's whole
  // process group on restart. `set -m` makes bash put the background job in
  // its own process group; nohup keeps it alive past the shell.
  const spawn = opts.spawn ?? ((argv: string[], env: Record<string, string>, logPath: string) => {
    mkdirSync(dirname(logPath), { recursive: true });
    const child = Bun.spawn(argv, { env, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    child.unref();
  });
  const serverArgv = (bin: string, logPath: string): string[] => ["/bin/bash", "-c", 'set -m; nohup "$0" server >>"$1" 2>&1 &', bin, logPath];
  const run = opts.run ?? (async (argv: string[], env: Record<string, string>) => {
    const r = await runCapture([argv[0]!, ...argv.slice(1)], { env, timeoutMs: 15_000, stderr: "pipe" });
    return { exitCode: r.exitCode, stdout: r.stdout || r.stderr };
  });

  return {
    socketPath: () => sock,
    async up(): Promise<boolean> {
      return available(sock);
    },
    async ensure(): Promise<string> {
      if (await available(sock)) return sock;
      const logPath = join(logDir, "herd-session.log");
      spawn(serverArgv(resolveHerdrBin(), logPath), envWithoutSocket({ HERDR_SESSION: HIDDEN_SESSION }), logPath);
      const deadline = Date.now() + readyTimeoutMs;
      while (Date.now() < deadline) {
        if (await available(sock)) {
          opts.log.info({ sock }, "hidden herd session started");
          return sock;
        }
        await Bun.sleep(100);
      }
      throw new Error(`hidden herd session did not come up within ${readyTimeoutMs}ms (socket ${sock}); see ${logPath}`);
    },
    async stop(): Promise<void> {
      const r = await run([resolveHerdrBin(), "session", "stop", HIDDEN_SESSION], envWithoutSocket({}));
      if (r.exitCode !== 0) throw new Error(`herdr session stop failed: ${r.stdout.slice(0, 200)}`);
    },
  };
}
