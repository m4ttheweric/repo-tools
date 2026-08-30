/**
 * Age-based log pruning, generalized from cli-logger.ts's true age sweep to
 * every surface (daemon, cli, tray, ...). pino-roll's `limit.count` counts
 * FILES not days, and the daemon stream can roll several size-split files
 * per day, so a file-count floor makes "N days of retention" far shorter
 * than N days whenever a surface rolls often. This module deletes by age
 * instead, at the caller's chosen root.
 */

import { readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";

const DAY = 24 * 60 * 60 * 1000;

/** `<surface>.YYYY-MM-DD.log` or `<surface>.YYYY-MM-DD.N.log` (size-split rotation). */
const LOG_FILE_PATTERN = /^[a-z-]+\.\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/;

const LOGS_DIR_SUFFIX = join("rt", "logs");

/**
 * Last line of defense before any unlink: `dir` must actually be an rt logs
 * directory. Every surface's log dir is `.../rt/logs`, so a caller passing
 * anything else (a typo, a refactor that threads the wrong path) is refused
 * outright rather than silently pruning wherever it points.
 */
function assertLogsDir(dir: string): void {
  if (!dir.endsWith(LOGS_DIR_SUFFIX)) {
    throw new Error(`log-janitor: refusing to prune "${dir}" — expected a path ending in ${LOGS_DIR_SUFFIX}`);
  }
}

/**
 * Deletes regular files directly in `dir` (never recursing, never touching
 * directories) whose name matches the surface log pattern and whose mtime is
 * older than `retentionDays` back from `now`. Returns the basenames removed.
 */
export function pruneLogs(
  dir: string,
  retentionDays: number,
  now: number,
  onError?: (phase: "readdir" | "unlink", err: unknown, file?: string) => void,
): { removed: string[] } {
  assertLogsDir(dir);

  const cutoff = now - retentionDays * DAY;
  const removed: string[] = [];

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    onError?.("readdir", err);
    return { removed };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !LOG_FILE_PATTERN.test(entry.name)) continue;

    const full = join(dir, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= cutoff) continue;

    try {
      unlinkSync(full);
      removed.push(entry.name);
    } catch (err) {
      // best-effort: a file gone or unreadable between stat and unlink is not fatal
      onError?.("unlink", err, entry.name);
    }
  }

  return { removed };
}
