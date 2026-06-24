/**
 * Per-repo script variations for rt run.
 *
 * Storage: <dataDir>/variations.json — a single JSON object keyed by
 * `absolutePackagePath:scriptName`, each value an array of {name, command}.
 *
 * Best-effort I/O — silently swallows errors so a broken/missing file
 * never blocks the user's actual command invocation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Variation {
  /** User-facing label shown in the variations sub-picker. */
  name: string;
  /** Full shell command string to execute. */
  command: string;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

function variationsPath(dataDir: string): string {
  return join(dataDir, "variations.json");
}

// ─── Keys ───────────────────────────────────────────────────────────────────

export function variationKey(packagePath: string, script: string): string {
  return `${packagePath}:${script}`;
}

// ─── Read ───────────────────────────────────────────────────────────────────

export function loadVariations(
  dataDir: string,
): Record<string, Variation[]> {
  const path = variationsPath(dataDir);
  if (!existsSync(path)) return {};

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, Variation[]>;
  } catch {
    return {};
  }
}

// ─── Write ──────────────────────────────────────────────────────────────────

export function saveVariation(
  dataDir: string,
  packagePath: string,
  script: string,
  variation: Variation,
): void {
  const path = variationsPath(dataDir);
  const key = variationKey(packagePath, script);

  const all = loadVariations(dataDir);
  const list = all[key] ?? [];
  all[key] = [...list, variation];

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all, null, 2) + "\n");
  } catch {
    // best effort — don't break the user's command over a write error
  }
}
