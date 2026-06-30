/**
 * Named presets of package+script selections for rt run.
 *
 * Storage: <dataDir>/presets/<name>.json — one file per preset, named after
 * the preset itself so saving a preset with an existing name overwrites it.
 *
 * Entries store repo-relative package paths so presets are portable across
 * worktrees (worktree roots differ, but the relative package path within
 * the repo is stable).
 *
 * Best-effort I/O — silently swallows errors so a broken/missing file or
 * directory never blocks the user's actual command invocation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, basename } from "path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PresetEntry {
  /** Repo-relative path to the package (stable across worktrees). */
  packageRelPath: string;
  /** User-facing package label shown in pickers. */
  packageLabel: string;
  /** Script name within the package's package.json. */
  script: string;
  /** Name of the selected variation, if any. */
  variationName?: string;
  /** Full shell command string, if a variation/override was selected. */
  command?: string;
}

export interface Preset {
  name: string;
  entries: PresetEntry[];
}

// ─── Paths ──────────────────────────────────────────────────────────────────

function presetsDir(dataDir: string): string {
  return join(dataDir, "presets");
}

function presetPath(dataDir: string, name: string): string {
  return join(presetsDir(dataDir), `${name}.json`);
}

// ─── Read ───────────────────────────────────────────────────────────────────

export function loadPresets(dataDir: string): Preset[] {
  const dir = presetsDir(dataDir);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }

  const presets: Preset[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      presets.push({
        name: raw.name ?? basename(file, ".json"),
        entries: raw.entries ?? [],
      });
    } catch {
      // skip corrupted preset files — best effort
    }
  }
  return presets;
}

export function findPreset(dataDir: string, name: string): Preset | null {
  const path = presetPath(dataDir, name);
  if (!existsSync(path)) return null;

  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { name: raw.name ?? name, entries: raw.entries ?? [] };
  } catch {
    return null;
  }
}

// ─── Write ──────────────────────────────────────────────────────────────────

export function savePreset(dataDir: string, preset: Preset): void {
  const path = presetPath(dataDir, preset.name);
  try {
    mkdirSync(presetsDir(dataDir), { recursive: true });
    writeFileSync(path, JSON.stringify(preset, null, 2) + "\n");
  } catch {
    // best effort — don't break the user's command over a write error
  }
}
