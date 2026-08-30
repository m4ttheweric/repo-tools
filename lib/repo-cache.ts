/**
 * cd-cache: a best-effort, disposable snapshot of the known-repo list that
 * `rt cd` serves from instead of rebuilding it live on every invocation.
 *
 * Ink-free and daemon-safe by design: pure fs + JSON, no git, no picker
 * imports, no subprocess. Later tasks reach this from the daemon poll loop
 * as well as from the CLI's cd path, so it must never pull in anything that
 * assumes a TTY or a git checkout.
 */

import { readFileSync, renameSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { cdCachePath } from "./rt-paths.ts";
import type { KnownRepo } from "./repo-index.ts";

const CACHE_VERSION = 1;

interface RepoCachePayload {
  version: number;
  builtAt: number;
  repos: KnownRepo[];
}

/**
 * Writes the cache atomically: temp file + renameSync over the real path, so
 * a concurrent reader never observes a partially written file. Best-effort
 * (a stale cache is safe) - failures are swallowed rather than thrown.
 */
export function writeRepoCache(repos: KnownRepo[]): void {
  try {
    const path = cdCachePath();
    const tmpPath = path + ".tmp";
    const payload: RepoCachePayload = { version: CACHE_VERSION, builtAt: Date.now(), repos };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(payload));
    renameSync(tmpPath, path);
  } catch {
    // best effort - a stale or missing cache is safe, see module docblock
  }
}

/**
 * Reads the cache. Returns null on a missing file, corrupt JSON, or a
 * `version` other than the one this module writes - never throws.
 */
export function readRepoCache(): { builtAt: number; repos: KnownRepo[] } | null {
  try {
    const raw = readFileSync(cdCachePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<RepoCachePayload>;
    if (parsed.version !== CACHE_VERSION) return null;
    if (typeof parsed.builtAt !== "number" || !Array.isArray(parsed.repos)) return null;
    return { builtAt: parsed.builtAt, repos: parsed.repos };
  } catch {
    return null;
  }
}
