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
 * Reads are best-effort — a broken/missing store value degrades to empty
 * rather than blocking the user's actual command invocation. Writes are NOT
 * silently swallowed: `savePreset` reports success/failure so a caller (`rt
 * run`) can tell the user the truth instead of printing a checkmark for a
 * save that never landed.
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

export type SaveResult =
  | { ok: true }
  | { ok: false; reason: "no-identity" }
  | { ok: false; reason: "write-failed"; message: string };

/**
 * Overwrites `preset.name`'s entry; every other saved preset survives the
 * write — but the base it merges onto is the RESOLVED value across every
 * scope the key allows (user/team/machine), not just what's already in the
 * user store. Presets are single-scope in practice (personal, written only
 * to "user"), so this only matters if a preset was ever hand-authored into
 * team or machine: the next save here copies the whole merged map — that
 * foreign preset included — into the user store too. Accepted, not guarded.
 */
export function savePreset(repoIdentity: string | null, preset: Preset): SaveResult {
  if (repoIdentity === null) return { ok: false, reason: "no-identity" };

  const all = presetsMap(repoIdentity);
  all[preset.name] = { entries: preset.entries };

  try {
    setSetting("rt.presets", all, "user", { repoIdentity });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "write-failed", message: err instanceof Error ? err.message : String(err) };
  }
}
