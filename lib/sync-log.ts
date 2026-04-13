/**
 * lib/sync-log.ts — Append-only audit log for rt sync operations.
 *
 * Written to ~/.rt/sync.log.
 * Each "session" covers one rt sync invocation (single or all-worktrees).
 * Within a session, every git command is logged with:
 *   - timestamp
 *   - cwd (worktree path)
 *   - command arguments
 *   - exit code
 *   - trimmed stdout / stderr (truncated to 2 KB each to prevent runaway logs)
 *
 * Usage:
 *   import { syncLog } from "../lib/sync-log.ts";
 *   syncLog.start("rt sync all");
 *   syncLog.worktree("/path/to/wt", "feature/my-branch");
 *   syncLog.cmd("fetch origin", "/path/to/wt", 0, "", "");
 *   syncLog.phase("reset-to-origin", { status: "fast-forward" });
 *   syncLog.worktreeEnd("feature/my-branch", null);
 *   syncLog.end();
 */

import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const LOG_DIR = join(homedir(), ".rt");
const LOG_PATH = join(LOG_DIR, "sync.log");
const MAX_OUTPUT_BYTES = 2048;

function ts(): string {
  return new Date().toISOString();
}

function truncate(s: string): string {
  if (!s) return "";
  const t = s.trim();
  if (t.length <= MAX_OUTPUT_BYTES) return t;
  return t.slice(0, MAX_OUTPUT_BYTES) + `… [+${t.length - MAX_OUTPUT_BYTES} bytes]`;
}

function write(line: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, line + "\n", "utf8");
  } catch {
    // Non-fatal — never let logging break a sync operation
  }
}

function header(char: string, label: string): string {
  const bar = char.repeat(60);
  return `${bar}\n${label}\n${bar}`;
}

class SyncLogger {
  private _session: string | null = null;

  /** Call once at the start of every sync invocation. */
  start(label: string): void {
    this._session = ts();
    write("");
    write(header("=", `[${this._session}] SESSION START — ${label}`));
  }

  /** Called when processing starts for a specific worktree. */
  worktree(cwd: string, branch: string): void {
    write(`\n${header("-", `[${ts()}] WORKTREE: ${cwd}  branch: ${branch}`)}`);
  }

  /**
   * Log a git command result.
   * @param args  Git args string (e.g. "fetch origin") or argv array joined
   * @param cwd   Working directory
   * @param code  Exit code (0 = success)
   * @param stdout stdout output (truncated)
   * @param stderr stderr output (truncated)
   */
  cmd(
    args: string | string[],
    cwd: string,
    code: number | null,
    stdout: string,
    stderr: string,
  ): void {
    const argStr = Array.isArray(args) ? args.join(" ") : args;
    const status = code === 0 ? "OK" : `FAIL(${code})`;
    write(`[${ts()}] CMD ${status}  git ${argStr}`);
    write(`         cwd: ${cwd}`);
    if (stdout) write(`         out: ${truncate(stdout).replace(/\n/g, "\n              ")}`);
    if (stderr) write(`         err: ${truncate(stderr).replace(/\n/g, "\n              ")}`);
  }

  /** Log the result of a named phase (reset-to-origin, rebase, push, etc.) */
  phase(name: string, result: Record<string, unknown>): void {
    const status = result.status ?? (result.error ? "error" : "ok");
    const extra = result.error ? `  error: ${result.error}` : "";
    write(`[${ts()}] PHASE ${name}  status=${status}${extra}`);
    if (result.backupBranch) write(`         backup: ${result.backupBranch}`);
    if (result.target) write(`         target: ${result.target}`);
    if (result.commitsBehind) write(`         behind: ${result.commitsBehind}`);
  }

  /** Log the final outcome of a worktree sync. */
  worktreeEnd(branch: string, error: string | undefined | null): void {
    if (error) {
      write(`[${ts()}] WORKTREE END  branch: ${branch}  ERROR: ${error}`);
    } else {
      write(`[${ts()}] WORKTREE END  branch: ${branch}  OK`);
    }
  }

  /** Call once at the end of every sync invocation. */
  end(): void {
    write(header("=", `[${ts()}] SESSION END`));
    write("");
    this._session = null;
  }
}

/** Singleton logger — shared across all sync modules in a process. */
export const syncLog = new SyncLogger();

/**
 * Wrap execSync with automatic logging.
 * Drop-in replacement for the local git() helpers in reset.ts and rebase.ts.
 */
export function gitLogged(
  args: string,
  cwd: string,
  execSyncFn: (cmd: string, opts: object) => string,
): string {
  let stdout = "";
  let stderr = "";
  let code: number | null = 0;
  try {
    stdout = execSyncFn(`git ${args}`, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    } as any) as unknown as string;
    if (typeof stdout === "string") stdout = stdout.trim();
    syncLog.cmd(args, cwd, 0, stdout, "");
    return stdout;
  } catch (err: any) {
    stderr = err?.stderr ?? "";
    stdout = err?.stdout ?? "";
    code = err?.status ?? 1;
    syncLog.cmd(args, cwd, code, stdout, stderr);
    throw err;
  }
}

/**
 * Wrap spawnSync with automatic logging.
 * Drop-in for spawnSync("git", [...]) calls in rebase.ts / reset.ts.
 */
export function spawnLogged(
  args: string[],
  cwd: string,
  spawnSyncFn: (cmd: string, args: string[], opts: object) => any,
  extraEnv?: Record<string, string>,
): ReturnType<typeof spawnSyncFn> {
  const result = spawnSyncFn("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });
  syncLog.cmd(args, cwd, result.status, result.stdout ?? "", result.stderr ?? "");
  return result;
}
