/**
 * Named presets of package+script selections for rt run.
 *
 * Resolved through the settings resolver (`rt.presets`, user.repo scope):
 * one object keyed by preset name, each value `{ entries: [...] }`.
 *
 * Entries store repo-relative package paths so presets are portable across
 * worktrees (worktree roots differ, but the relative package path within
 * the repo is stable).
 *
 * Best-effort I/O — silently swallows errors so a broken/missing store value
 * never blocks the user's actual command invocation.
 */

import { getSetting } from "./settings/resolve.ts";
import { setSetting } from "./settings/write.ts";

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

// ─── Read ───────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The resolved `rt.presets` object as a name → entries map, or empty when
 * nothing resolves. A resolver throw (e.g. an unexpandable ${...} variable
 * authored by hand) degrades the same way a missing/corrupt file did before.
 */
function presetsMap(repoIdentity: string | null): Record<string, { entries: PresetEntry[] }> {
  let raw: unknown;
  try {
    raw = getSetting<unknown>("rt.presets", { repoIdentity }).value;
  } catch {
    return {};
  }
  if (!isPlainObject(raw)) return {};

  const out: Record<string, { entries: PresetEntry[] }> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (isPlainObject(value) && Array.isArray(value.entries)) {
      out[name] = { entries: value.entries as PresetEntry[] };
    }
  }
  return out;
}

export function loadPresets(repoIdentity: string | null): Preset[] {
  return Object.entries(presetsMap(repoIdentity)).map(([name, { entries }]) => ({ name, entries }));
}

export function findPreset(repoIdentity: string | null, name: string): Preset | null {
  const entry = presetsMap(repoIdentity)[name];
  return entry ? { name, entries: entry.entries } : null;
}

// ─── Write ──────────────────────────────────────────────────────────────────

/** Overwrites `preset.name`'s entry; every other saved preset survives the write. */
export function savePreset(repoIdentity: string | null, preset: Preset): void {
  if (repoIdentity === null) return; // best effort: no identity, nowhere repo-scoped to write

  const all = presetsMap(repoIdentity);
  all[preset.name] = { entries: preset.entries };

  try {
    setSetting("rt.presets", all, "user", { repoIdentity });
  } catch {
    // best effort — don't break the user's command over a write error
  }
}
