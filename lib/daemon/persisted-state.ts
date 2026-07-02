/**
 * Persisted daemon state loader — the one place corrupt state files get
 * discarded, so the discard is always logged. The previous per-module
 * empty-catch "start fresh" pattern silently lost process/port/group state,
 * which then surfaced as "things vanished" with no cause in the log.
 */

import { existsSync, readFileSync } from "fs";
import { getDaemonLogger } from "../daemon-logger.ts";

const log = (await getDaemonLogger()).childLogger("state-load");

/**
 * Read and parse a persisted state file.
 * Missing file → undefined (normal first run, not logged).
 * Unreadable or corrupt file → undefined, logged at warn with the path.
 */
export function loadPersistedState<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    log.warn({ err, path }, "corrupt persisted state discarded; starting fresh");
    return undefined;
  }
}

/**
 * Wrap the "hydrate in-memory maps from parsed state" step so shape drift in
 * old files is logged rather than silently truncating the load.
 */
export function hydratePersistedState(path: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.warn({ err, path }, "persisted state partially hydrated; shape mismatch");
  }
}
