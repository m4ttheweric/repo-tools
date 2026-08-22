/**
 * Probes seam — the one boundary every setup validator/step calls through
 * instead of touching fs/exec/network/tray/daemon directly, so validators
 * and steps stay pure functions over injected state and tests never touch
 * the real machine.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { daemonSocketQuery, trayRequest, type DaemonResponse, type TrayClient } from "../daemon-client.ts";
import { UserActionableError } from "./errors.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Probes {
  /** Never throws: a missing binary yields code 127 with stderr "ENOENT: <argv0>"; timeout yields 124. `inherit` hands the child the TTY (interactive logins) — stdout/stderr then come back empty. */
  exec(argv: string[], opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; input?: string; inherit?: boolean }): Promise<ExecResult>;
  exists(path: string): boolean;
  readFile(path: string): string | null;
  readDir(path: string): string[];
  readlink(path: string): string | null;
  writeFile(path: string, content: string, mode?: number): void;
  removeFile(path: string): void;
  removeDir(path: string): void;
  symlink(target: string, path: string): void;
  mkdirp(path: string, mode?: number): void;
  /** Never throws: network failure yields status 0, body "", headers {}. Header names are lowercased. */
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ status: number; body: string; headers: Record<string, string> }>;
  tray: TrayClient;
  daemon(cmd: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<DaemonResponse | null>;
  env: Record<string, string | undefined>;
  home: string;
  now(): Date;
  /**
   * Spawns this same rt (process.execPath) with args; stdin from `input`.
   * Never throws. Under `bun run cli.ts` (dev/test) `process.execPath` is the
   * `bun` binary, not `rt` — argv becomes `bun <args>`. That's only correct
   * for the compiled binary, which is the real target for every setup step
   * that calls this.
   */
  runRt(args: string[], opts?: { input?: string; timeoutMs?: number }): Promise<ExecResult>;
}

const DEFAULT_FETCH_TIMEOUT_MS = 5000;
/** Grace between SIGTERM and SIGKILL once timeoutMs elapses — long enough for a well-behaved child to exit on TERM, short enough to keep the 124 path bounded. */
const KILL_GRACE_MS = 200;

async function execWithTimeout(argv: string[], opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; input?: string; inherit?: boolean }): Promise<ExecResult> {
  const hasInput = opts?.input !== undefined && !opts?.inherit;

  // A local no-arg closure (rather than `Bun.spawn(argv, {...})` inline
  // under an explicitly-typed `let proc`) so TS infers `proc`'s type from
  // this specific literal options shape — pre-declaring `proc`'s type
  // against the generic `ReturnType<typeof Bun.spawn>` collapses `stdin` to
  // `number | FileSink`, losing the `FileSink` narrowing the write below needs.
  const trySpawn = () =>
    Bun.spawn(argv, {
      cwd: opts?.cwd,
      // Spread at call time (not a module-level snapshot) so a caller that
      // sets env vars right before invoking the probe sees them; opts.env
      // then overlays that copy of process.env.
      env: { ...process.env, ...opts?.env },
      stdin: opts?.inherit ? "inherit" : hasInput ? "pipe" : "ignore",
      stdout: opts?.inherit ? "inherit" : "pipe",
      stderr: opts?.inherit ? "inherit" : "pipe",
    });

  let proc: ReturnType<typeof trySpawn>;
  try {
    proc = trySpawn();
  } catch {
    // Bun.spawn throws synchronously (posix_spawn ENOENT) only for a
    // missing/unexecutable binary — narrowed to just the spawn call so a
    // later failure (stdin delivery, stream read) is never mislabeled 127.
    return { code: 127, stdout: "", stderr: `ENOENT: ${argv[0]}` };
  }

  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    if (hasInput) {
      // stdin's static type is FileSink | undefined because the "pipe"
      // literal above is widened through the ternary; hasInput guarantees
      // stdin:"pipe" was actually passed, so it's defined at runtime.
      try {
        await proc.stdin!.write(opts!.input!);
        await proc.stdin!.end();
      } catch {
        // Best-effort delivery: a child that closes or never reads stdin
        // (e.g. `exit 0` fed a multi-MB payload) rejects the write/end with
        // EPIPE. That must never escape as an unhandled rejection — the
        // real outcome is whatever exit code the child produces below.
      }
    }

    const stdoutP = opts?.inherit ? Promise.resolve("") : new Response(proc.stdout as ReadableStream).text();
    const stderrP = opts?.inherit ? Promise.resolve("") : new Response(proc.stderr as ReadableStream).text();
    const collected = Promise.all([stdoutP, stderrP, proc.exited]);

    if (!opts?.timeoutMs) {
      const [stdout, stderr, code] = await collected;
      return { code, stdout, stderr };
    }

    // A backgrounded grandchild can hold the stdout/stderr pipe open even
    // after the direct child is killed, and a child can trap SIGTERM
    // outright — either way `collected` may never settle, so it races the
    // deadline instead of being awaited unconditionally.
    const timedOut = new Promise<true>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(true), opts.timeoutMs);
    });
    const raceResult = await Promise.race([
      collected.then((r) => ({ timedOut: false as const, r })),
      timedOut.then(() => ({ timedOut: true as const })),
    ]);

    if (!raceResult.timedOut) return { code: raceResult.r[2], stdout: raceResult.r[0], stderr: raceResult.r[1] };

    try {
      proc.kill("SIGTERM");
    } catch {
      // already exited
    }
    // Escalate past a signal-trapping child; fire-and-forget — the caller
    // already has its 124 and isn't waiting on this.
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, KILL_GRACE_MS);
    // The abandoned stream/exit reads may still settle (or reject) later —
    // swallow so that doesn't surface as an unhandled rejection.
    collected.catch(() => {});

    return { code: 124, stdout: "", stderr: "" };
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

export function createRealProbes(): Probes {
  return {
    exec: execWithTimeout,

    exists(path) {
      return existsSync(path);
    },

    readFile(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },

    readDir(path) {
      try {
        return readdirSync(path);
      } catch {
        return []; // missing or unreadable — matches the fake, and every other read on this seam
      }
    },

    readlink(path) {
      try {
        return readlinkSync(path);
      } catch {
        return null; // not a symlink, or missing
      }
    },

    writeFile(path, content, mode) {
      writeFileSync(path, content, mode !== undefined ? { mode } : undefined);
    },

    removeFile(path) {
      try {
        unlinkSync(path);
      } catch {
        // best-effort
      }
    },

    removeDir(path) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },

    symlink(target, path) {
      symlinkSync(target, path);
    },

    mkdirp(path, mode) {
      mkdirSync(path, { recursive: true, ...(mode !== undefined ? { mode } : {}) });
    },

    async fetch(url, init) {
      try {
        const response = await fetch(url, {
          method: init?.method ?? "GET",
          headers: init?.headers,
          body: init?.body,
          signal: AbortSignal.timeout(init?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
        });
        const body = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        return { status: response.status, body, headers };
      } catch {
        return { status: 0, body: "", headers: {} };
      }
    },

    tray: trayRequest,

    async daemon(cmd, payload, timeoutMs) {
      return daemonSocketQuery(cmd, payload, timeoutMs);
    },

    env: process.env,

    home: process.env.HOME ?? homedir(),

    now() {
      return new Date();
    },

    async runRt(args, opts) {
      return execWithTimeout([process.execPath, ...args], {
        input: opts?.input,
        timeoutMs: opts?.timeoutMs,
        env: { RT_SKIP_SETUP: "1" },
      });
    },
  };
}

/**
 * Reads a full stdin stream, JSON.parse'd. `stream` defaults to the process's
 * real stdin; tests inject a synthetic ReadableStream instead of piping a
 * child process. Empty input is a legitimate "nothing piped" case (null, not
 * an error) — only malformed JSON is user-actionable.
 */
export async function readStdinJson<T = unknown>(stream: ReadableStream<Uint8Array> = Bun.stdin.stream()): Promise<T | null> {
  const text = await new Response(stream).text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UserActionableError("bad-stdin", "stdin did not contain valid JSON");
  }
}
