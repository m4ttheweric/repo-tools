/**
 * CLI command logger -- automatic structured logging for every rt command invocation.
 *
 * Writes JSON lines to ~/.rt/logs/cli.YYYY-MM-DD.log with daily rotation
 * and 14-day retention. Designed to be zero-cost to callers: logging never
 * throws, never blocks the command, and requires no per-module code.
 *
 * Wired into the command-tree dispatcher so new modules get logging for free.
 */

import { openSync, writeSync, closeSync, readdirSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { logsDir } from "./rt-paths.ts";

const RETENTION_DAYS = 14;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function logPath(): string {
  return join(logsDir(), `cli.${today()}.log`);
}

function pruneOldLogs(): void {
  try {
    const dir = logsDir();
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("cli.") || !f.endsWith(".log")) continue;
      const match = f.match(/^cli\.(\d{4}-\d{2}-\d{2})\.log$/);
      if (!match) continue;
      const fileDate = new Date(match[1]!).getTime();
      if (fileDate < cutoff) {
        try { unlinkSync(join(dir, f)); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort */ }
}

let hasPruned = false;

interface CommandLog {
  command: string;
  args: string[];
  cwd: string;
  repo?: string;
  durationMs: number;
  outcome: "ok" | "error" | "cancelled";
  error?: string;
  stack?: string;
  exitCode?: number;
}

/**
 * Returns a copy of args with the value following any `--reason` flag
 * replaced by "[redacted]" (also handles the `--reason=value` form). Reason
 * text is free-form and often sensitive (e.g. `rt sdm connect`), so it must
 * never reach the on-disk CLI log. This only affects what gets logged --
 * the real args passed to command handlers are never touched.
 */
export function redactSensitiveArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--reason") {
      result.push(arg);
      if (i + 1 < args.length) {
        result.push("[redacted]");
        i++;
      }
      continue;
    }
    if (arg.startsWith("--reason=")) {
      result.push("--reason=[redacted]");
      continue;
    }
    result.push(arg);
  }
  return result;
}

export function logCommand(entry: CommandLog): void {
  finalized = true;
  try {
    const dir = logsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const line = JSON.stringify({
      time: new Date().toISOString(),
      ...entry,
      args: redactSensitiveArgs(entry.args),
    }) + "\n";

    const fd = openSync(logPath(), "a");
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }

    if (!hasPruned) {
      hasPruned = true;
      pruneOldLogs();
    }
  } catch { /* logging must never break a command */ }
}

// ─── Invocation-level coverage ───────────────────────────────────────────────
// dispatch() logs the happy path and thrown errors, but ~100 command paths
// terminate via process.exit() and never return to it. The exit hook below
// writes the record for those, so every invocation is logged no matter how
// it ends. `finalized` prevents double-writes when dispatch already logged.

let current: { command: string; args: string[]; t0: number } | null = null;
let finalized = false;

/** Called by dispatch() once the command label is resolved. */
export function beginCommand(command: string, args: string[]): void {
  if (current) {
    current.command = command;
    current.args = args;
  }
}

/**
 * Install process-level hooks: an exit hook that records any invocation not
 * already logged (captures every process.exit() path), plus crash handlers
 * that persist uncaught exception / rejection stacks. Call ONCE at CLI entry,
 * never for the --daemon path (the daemon has its own pino crash handlers).
 */
export function installCliLogging(argv: string[]): void {
  // Redact before joining: this seeds `current.command` for the window before
  // beginCommand() runs, so a crash in that window must not bake --reason
  // text into the on-disk log via the joined command string.
  const safeArgv = redactSensitiveArgs(argv);
  current = {
    command: safeArgv.length ? safeArgv.join(" ") : "(picker)",
    args: [],
    t0: Date.now(),
  };

  process.on("exit", (code) => {
    if (finalized || !current) return;
    logCommand({
      command: current.command,
      args: current.args,
      cwd: process.cwd(),
      durationMs: Date.now() - current.t0,
      outcome: code === 0 ? "ok" : code === 130 ? "cancelled" : "error",
      exitCode: code,
    });
  });

  const crash = (kind: string) => (err: unknown) => {
    if (!finalized && current) {
      logCommand({
        command: current.command,
        args: current.args,
        cwd: process.cwd(),
        durationMs: Date.now() - current.t0,
        outcome: "error",
        error: `${kind}: ${err instanceof Error ? err.message : String(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
        exitCode: 1,
      });
    }
    // Preserve default behavior: print the failure and exit nonzero.
    console.error(err);
    process.exit(1);
  };
  process.on("uncaughtException", crash("uncaughtException"));
  process.on("unhandledRejection", crash("unhandledRejection"));
}
