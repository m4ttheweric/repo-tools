/**
 * Read/write `~/.doppler/.doppler.yaml`, the global Doppler CLI config.
 *
 * Treated by rt as a cache: the reconciler keeps it in sync with each repo's
 * doppler-template.yaml. Doppler CLI reads this file at runtime, so any
 * process anywhere on the machine that calls `doppler` works as long as the
 * cache is up to date.
 *
 * Writes are atomic (write to .tmp, rename over original) so Doppler CLI
 * never sees a half-written file.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse } from "yaml";

/** Per-path Doppler config (token + endpoints OR enclave.project + enclave.config). */
export interface DopplerScopedEntry {
  token?:             string;
  "api-host"?:        string;
  "dashboard-host"?:  string;
  "enclave.project"?: string;
  "enclave.config"?:  string;
}

export interface DopplerConfig {
  scoped: Record<string, DopplerScopedEntry>;
  /** `fallback:` and any unknown top-level keys preserved as-is for round-trip safety. */
  [other: string]: unknown;
}

/** Resolve ~/.doppler at call time so tests can override HOME before importing. */
function dopplerDir(): string {
  return join(process.env.HOME ?? homedir(), ".doppler");
}

export function dopplerConfigPath(): string {
  return join(dopplerDir(), ".doppler.yaml");
}

/** Load `~/.doppler/.doppler.yaml`. Returns `{ scoped: {} }` if missing or malformed. */
export function loadDopplerConfig(): DopplerConfig {
  const path = dopplerConfigPath();
  if (!existsSync(path)) return { scoped: {} };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = parse(raw);
    if (!parsed || typeof parsed !== "object") return { scoped: {} };
    if (!parsed.scoped || typeof parsed.scoped !== "object") {
      return { ...parsed, scoped: {} };
    }
    // Validate each scoped value is an object — guards downstream callers
    // (addScopedEntry, etc.) from null/string/number values that may have
    // crept in via hand-edits to ~/.doppler/.doppler.yaml.
    const scoped: Record<string, DopplerScopedEntry> = {};
    for (const [key, val] of Object.entries(parsed.scoped)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        scoped[key] = val as DopplerScopedEntry;
      }
    }
    return { ...parsed, scoped };
  } catch {
    return { scoped: {} };
  }
}
