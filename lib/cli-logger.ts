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
import { homedir } from "os";

const LOG_DIR = join(homedir(), ".rt", "logs");
const RETENTION_DAYS = 14;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function logPath(): string {
  return join(LOG_DIR, `cli.${today()}.log`);
}

function pruneOldLogs(): void {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const f of readdirSync(LOG_DIR)) {
      if (!f.startsWith("cli.") || !f.endsWith(".log")) continue;
      const match = f.match(/^cli\.(\d{4}-\d{2}-\d{2})\.log$/);
      if (!match) continue;
      const fileDate = new Date(match[1]!).getTime();
      if (fileDate < cutoff) {
        try { unlinkSync(join(LOG_DIR, f)); } catch { /* best-effort */ }
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
  outcome: "ok" | "error";
  error?: string;
}

export function logCommand(entry: CommandLog): void {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

    const line = JSON.stringify({
      time: new Date().toISOString(),
      ...entry,
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
