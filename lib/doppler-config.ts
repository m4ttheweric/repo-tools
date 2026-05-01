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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse, stringify } from "yaml";

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

/**
 * Write the config atomically: stringify, write to a `.tmp` sibling, then
 * `renameSync` over the destination. Doppler CLI never sees a half-written
 * file because rename is atomic on the same filesystem.
 *
 * Parent directory is created if missing.
 */
export function writeDopplerConfig(config: DopplerConfig): void {
  const path = dopplerConfigPath();
  const dir = dopplerDir();
  mkdirSync(dir, { recursive: true });

  const tmp = path + ".tmp";
  const yaml = stringify(config);
  writeFileSync(tmp, yaml);
  renameSync(tmp, path);
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

/** Read the scoped entry for a path, or `undefined` if absent. */
export function getScopedEntry(
  config: DopplerConfig,
  absolutePath: string,
): DopplerScopedEntry | undefined {
  return config.scoped[absolutePath];
}

/**
 * Result of attempting to add an entry:
 * - "wrote"      → entry was missing; we added it
 * - "unchanged"  → entry already exists with matching project + config
 * - "overridden" → entry exists but differs from what we wanted; we did NOT modify it
 *
 * Mutates `config.scoped` in place when result is "wrote". The caller must
 * call `writeDopplerConfig(config)` to persist.
 */
export type AddScopedResult = "wrote" | "unchanged" | "overridden";

export function addScopedEntry(
  config: DopplerConfig,
  absolutePath: string,
  project: string,
  configName: string,
): AddScopedResult {
  const existing = config.scoped[absolutePath];
  if (existing === undefined) {
    config.scoped[absolutePath] = {
      "enclave.project": project,
      "enclave.config":  configName,
    };
    return "wrote";
  }
  if (
    existing["enclave.project"] === project &&
    existing["enclave.config"]  === configName
  ) {
    return "unchanged";
  }
  return "overridden";
}
