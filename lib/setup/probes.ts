/**
 * Probes seam — the one boundary every setup validator/step calls through
 * instead of touching fs/exec/network/tray/daemon directly, so validators
 * and steps stay pure functions over injected state and tests never touch
 * the real machine.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { daemonQuery, trayRequest, type DaemonResponse, type TrayClient } from "../daemon-client.ts";
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
  /** Spawns this same rt (process.execPath) with args; stdin from `input`. Never throws. */
  runRt(args: string[], opts?: { input?: string; timeoutMs?: number }): Promise<ExecResult>;
}

const DEFAULT_FETCH_TIMEOUT_MS = 5000;

async function execWithTimeout(argv: string[], opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; input?: string; inherit?: boolean }): Promise<ExecResult> {
  try {
    const hasInput = opts?.input !== undefined && !opts?.inherit;
    const proc = Bun.spawn(argv, {
      cwd: opts?.cwd,
      // Bun.spawn resolves the executable against the PATH captured at
      // process start; a runtime process.env.PATH mutation is invisible to
      // it, so this must be a live reference, not a snapshot taken earlier.
      env: { ...process.env, ...opts?.env },
      stdin: opts?.inherit ? "inherit" : hasInput ? "pipe" : "ignore",
      stdout: opts?.inherit ? "inherit" : "pipe",
      stderr: opts?.inherit ? "inherit" : "pipe",
    });

    if (hasInput) {
      // stdin's static type is FileSink | undefined because the "pipe"
      // literal above is widened through the ternary; hasInput guarantees
      // stdin:"pipe" was actually passed, so it's defined at runtime.
      proc.stdin!.write(opts!.input!);
      proc.stdin!.end();
    }

    let timedOut = false;
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, opts.timeoutMs)
      : null;

    const [stdout, stderr, code] = await Promise.all([
      opts?.inherit ? Promise.resolve("") : new Response(proc.stdout).text(),
      opts?.inherit ? Promise.resolve("") : new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timer) clearTimeout(timer);

    return { code: timedOut ? 124 : code, stdout, stderr };
  } catch {
    // Bun.spawn throws synchronously (posix_spawn ENOENT) for a missing binary.
    return { code: 127, stdout: "", stderr: `ENOENT: ${argv[0]}` };
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
      return readdirSync(path);
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
      return daemonQuery(cmd, payload, timeoutMs);
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
