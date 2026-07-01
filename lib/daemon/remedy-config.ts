/**
 * Remedy rule types + on-disk remedy configuration.
 *
 * Global auto-remedy rules live in ~/.rt/remedies/_global.json (GlobalRemedy[]).
 * Per-entry rules ride along on lane entries (see lane-config.ts) and are fed
 * to the RemedyEngine at spawn time.
 *
 * Formerly part of lib/runner-store.ts; split out when the runner TUI was
 * removed because the remedy engine and the daemon's hot-reload watcher are
 * still live consumers.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * An auto-remedy rule attached to a lane entry.
 *
 * When the daemon detects `pattern` in the entry's live PTY output, it runs
 * `cmds` in the entry's working directory and optionally restarts the process.
 * Used for mechanical fixes like clearing a corrupted cache directory.
 */
export interface Remedy {
  name: string;          // human label, e.g. "Clear parcel cache"
  /**
   * One or more regex strings matched against ANSI-stripped log lines.
   * A single string or an array — if array, ANY match triggers the remedy (OR logic).
   */
  pattern: string | string[];
  cmds: string[];        // ordered shell commands to execute, e.g. ["rm -rf .parcel-cache"]
  thenRestart?: boolean; // restart the process after cmds complete? (default: true)
  cooldownMs?: number;   // min ms between triggers to prevent flapping (default: 30_000)
}

/**
 * A global auto-remedy rule stored in ~/.rt/remedies/_global.json.
 *
 * Applies to any process whose working directory contains `cwdContains`
 * AND whose command contains `cmdContains`. Both matchers are optional
 * substrings (case-insensitive). If both are omitted the rule matches every
 * process — useful for truly universal fixes.
 *
 * Extends Remedy with the two selector fields.
 */
export interface GlobalRemedy extends Remedy {
  /** Substring that must appear in the process's working directory path. */
  cwdContains?: string;
  /** Substring that must appear in the process's command string. */
  cmdContains?: string;
}

/** Normalize a raw remedy object from disk into the typed shape. */
export function normalizeRemedy(raw: any): Remedy {
  const rawPattern = raw.pattern;
  const pattern: string[] = Array.isArray(rawPattern)
    ? rawPattern.map(String)
    : rawPattern !== undefined ? [String(rawPattern)] : [];
  return {
    name:        String(raw.name ?? ""),
    pattern,
    cmds:        Array.isArray(raw.cmds) ? raw.cmds.map(String) : [],
    thenRestart: raw.thenRestart !== false,
    cooldownMs:  Number(raw.cooldownMs ?? 30_000),
  };
}

/** Directory where remedy files live: ~/.rt/remedies/ */
function remediesDir(): string {
  return join(homedir(), ".rt", "remedies");
}

/** Absolute path for the global remedy file. */
export function globalRemedyPath(): string {
  return join(remediesDir(), "_global.json");
}

function normalizeGlobalRemedy(raw: any): GlobalRemedy {
  return {
    ...normalizeRemedy(raw),
    ...(raw.cwdContains !== undefined ? { cwdContains: String(raw.cwdContains) } : {}),
    ...(raw.cmdContains !== undefined ? { cmdContains: String(raw.cmdContains) } : {}),
  };
}

/**
 * Load global remedies from ~/.rt/remedies/_global.json.
 *
 * Returns [] when the file doesn't exist (fresh install).
 * Throws on JSON parse failure or non-array shape so callers can preserve
 * their last-good state instead of silently wiping everything — editors
 * commonly produce transient invalid states during atomic-rename saves.
 */
export function loadGlobalRemedies(): GlobalRemedy[] {
  const path = globalRemedyPath();
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error("global remedy file is not a JSON array");
  return raw.map(normalizeGlobalRemedy);
}
