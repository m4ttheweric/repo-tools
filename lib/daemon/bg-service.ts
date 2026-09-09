/**
 * The background server: one daemon-owned headless herdr server for panes
 * that never appear in the attached UI. Generalizes the herd-only hidden
 * session it replaced; see
 * docs/superpowers/specs/2026-09-09-background-server-design.md "The bg
 * service" and "Environment".
 *
 * HERDR_SOCKET_PATH must be ABSENT from the env of every command aimed at
 * it: herdr injects that variable into managed panes and it outranks
 * HERDR_SESSION, so leaving it in would silently target the visible
 * session (verified on herdr 0.7.5).
 */
import { homedir } from "os";
import { join, dirname } from "path";
import { mkdirSync } from "fs";
import type { Logger } from "pino";
import { herdrAvailable } from "../herdr/client.ts";
import { resolveHerdrBin, defaultHerdrRunner, launchInWorkspace, type HerdrRunner } from "../agent-herdr.ts";
import { runCapture } from "../subprocess.ts";

export const BG_SESSION = "bg";

export function bgSocketPath(home: string = process.env.HOME ?? homedir()): string {
  return join(home, ".config", "herdr", "sessions", BG_SESSION, "herdr.sock");
}

export interface ParityReport {
  ok: boolean;
  drift: string[];
}

export interface BgService {
  socketPath(): string;
  up(): Promise<boolean>;
  ensure(): Promise<{ socket: string; started: boolean }>;
  stop(): Promise<void>;
  reprobe(): Promise<ParityReport>;
  lastParity(): ParityReport | null;
}

function envWithoutSocket(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k !== "HERDR_SOCKET_PATH" && v !== undefined) env[k] = v;
  return { ...env, ...extra };
}

function plainProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return env;
}

const ENV_PROBE_KEYS = ["PATH", "HOME", "SHELL", "TMPDIR", "LANG"] as const;
const PROBE_BINARIES = ["bun", "node", "claude", "rt", "git"] as const;
const PROBE_CMD = 'zsh -lc "which bun node claude rt git; echo $PATH"';

function diffParity(bgOutput: string, visibleOutput: string): ParityReport {
  const bgLines = bgOutput.split("\n");
  const visibleLines = visibleOutput.split("\n");
  const labels = [...PROBE_BINARIES, "PATH"];
  const drift: string[] = [];
  labels.forEach((label, i) => {
    const bg = (bgLines[i] ?? "").trim();
    const visible = (visibleLines[i] ?? "").trim();
    if (bg !== visible) drift.push(`${label}: bg="${bg}" visible="${visible}"`);
  });
  return { ok: drift.length === 0, drift };
}

const PROBE_SETTLE_MS = 800;

/** Spawns a throwaway pane on the given socket (null = the visible server),
    runs cmd, and returns its output. No claude agent runs here, so there is
    no agent.wait to poll; a short settle stands in for it. */
async function defaultProbePane(socket: string | null, cmd: string): Promise<string> {
  const runner: HerdrRunner = socket
    ? defaultHerdrRunner({ ...process.env, HERDR_SOCKET_PATH: socket })
    : defaultHerdrRunner();
  const out = await launchInWorkspace(
    { workspaceLabel: "bg-probe", tabLabel: `probe-${crypto.randomUUID()}`, paneCommand: cmd },
    runner,
  );
  await Bun.sleep(PROBE_SETTLE_MS);
  const read = await runner(["pane", "read", out.paneId, "--source", "recent"]);
  await runner(["workspace", "close", out.workspaceId]);
  return read.stdout;
}

export function createBgService(opts: {
  log: Logger;
  spawn?: (argv: string[], env: Record<string, string>, logPath: string) => void;
  available?: (sock: string) => Promise<boolean>;
  run?: (argv: string[], env: Record<string, string>) => Promise<{ exitCode: number; stdout: string }>;
  probePane?: (socket: string | null, cmd: string) => Promise<string>;
  home?: string;
  logDir?: string;
  readyTimeoutMs?: number;
}): BgService {
  const home = opts.home ?? process.env.HOME ?? homedir();
  const logDir = opts.logDir ?? join(home, ".mattstack", "rt", "logs");
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;
  const available = opts.available ?? herdrAvailable;
  const probePane = opts.probePane ?? defaultProbePane;
  const sock = bgSocketPath(home);
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

  /** One server per socket: a launch that times out leaves its child alive, so
      a second one would fight the first for the same socket. */
  const SPAWN_COOLDOWN_MS = 60_000;
  let inFlight: Promise<{ socket: string; started: boolean }> | null = null;
  let lastSpawnAt = 0;
  let lastParityReport: ParityReport | null = null;

  /** Captures a login-shell snapshot so the server's own binary resolution
      matches the user's terminal, not launchd's minimal env. A probe failure
      degrades to the daemon's own env rather than blocking the start. */
  async function seededEnv(): Promise<Record<string, string>> {
    const base = envWithoutSocket({ HERDR_SESSION: BG_SESSION });
    let r: { exitCode: number; stdout: string };
    try {
      r = await run(["zsh", "-lc", 'printf "%s\\n" "$PATH" "$HOME" "$SHELL" "$TMPDIR" "$LANG"'], plainProcessEnv());
    } catch (err) {
      opts.log.warn({ err }, "bg: login-shell env probe threw; starting with the daemon's own env");
      return base;
    }
    if (r.exitCode !== 0) {
      opts.log.warn({ exitCode: r.exitCode }, "bg: login-shell env probe failed; starting with the daemon's own env");
      return base;
    }
    const lines = r.stdout.split("\n");
    const seeded = { ...base };
    ENV_PROBE_KEYS.forEach((key, i) => {
      const v = lines[i];
      if (v) seeded[key] = v;
    });
    return seeded;
  }

  /** Sequential, not Promise.all: defaultProbePane spawns its throwaway pane
      into a shared "bg-probe" workspace label, so running both probes
      concurrently is a create-create race on that workspace. */
  async function runParity(socket: string): Promise<void> {
    try {
      const bg = await probePane(socket, PROBE_CMD);
      const visible = await probePane(null, PROBE_CMD);
      const report = diffParity(bg, visible);
      lastParityReport = report;
      if (!report.ok) opts.log.warn({ drift: report.drift }, "bg: environment parity drift against the visible server");
    } catch (err) {
      opts.log.warn({ err }, "bg: parity probe failed; skipping");
    }
  }

  async function launch(): Promise<{ socket: string; started: boolean }> {
    if (await available(sock)) return { socket: sock, started: false };
    const logPath = join(logDir, "bg-service.log");
    const sinceSpawn = Date.now() - lastSpawnAt;
    if (lastSpawnAt > 0 && sinceSpawn < SPAWN_COOLDOWN_MS) {
      throw new Error(`bg server was spawned ${Math.round(sinceSpawn / 1000)}s ago and has not bound yet; see ${logPath}`);
    }
    lastSpawnAt = Date.now();
    const env = await seededEnv();
    spawn(serverArgv(resolveHerdrBin(), logPath), env, logPath);
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await available(sock)) {
        // A bound socket clears the stamp: a later crash must not read as
        // "still within this spawn's cooldown" and refuse to relaunch.
        lastSpawnAt = 0;
        opts.log.info({ sock }, "bg server started");
        await runParity(sock);
        return { socket: sock, started: true };
      }
      await Bun.sleep(100);
    }
    throw new Error(`bg server did not come up within ${readyTimeoutMs}ms (socket ${sock}); see ${logPath}`);
  }

  return {
    socketPath: () => sock,
    async up(): Promise<boolean> {
      return available(sock);
    },
    async ensure(): Promise<{ socket: string; started: boolean }> {
      // Concurrent ensures join the launch already running; probing and
      // spawning independently is what puts two servers on one socket.
      if (inFlight) return inFlight;
      inFlight = launch();
      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    },
    async stop(): Promise<void> {
      const r = await run([resolveHerdrBin(), "session", "stop", BG_SESSION], envWithoutSocket({}));
      if (r.exitCode !== 0) throw new Error(`herdr session stop failed: ${r.stdout.slice(0, 200)}`);
      lastSpawnAt = 0;
    },
    async reprobe(): Promise<ParityReport> {
      await runParity(sock);
      return lastParityReport ?? { ok: true, drift: [] };
    },
    lastParity(): ParityReport | null {
      return lastParityReport;
    },
  };
}
