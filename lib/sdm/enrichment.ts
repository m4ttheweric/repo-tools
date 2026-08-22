/**
 * Declarative enrichment overlay: labels, tiers, and db defaults layered on
 * top of resources the catalog scanner (scan.ts) already discovered.
 *
 * Ownership-latch port (wave 2, registry key `rt.sdmEnrichment`, team-only
 * scope — enrichment names employer resources and must never be settable in
 * a user or machine store): `getSetting("rt.sdmEnrichment").value ===
 * undefined` means the store does not own the key, so the legacy
 * ~/.mattstack/rt/sdm/enrichment.jsonc file stays authoritative, same as
 * always. Once the team store owns the key it wins WHOLESALE (a name-keyed
 * map, not a field-bag — unlike rt.worktreeApp, there is no per-field
 * default to fall back through), and the file is never consulted. A probe
 * failure (thrown by getSetting, or a store value the registry's type check
 * refuses) counts as unowned plus one warning that never echoes the value.
 * Pure and additive either way: loading never mutates the file and never
 * throws, so a missing or corrupt file just means "no enrichment" rather
 * than a crash.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { rtDir } from "../rt-paths.ts";
import { join } from "node:path";
import { stripJsonc } from "../jsonc.ts";
import { getSetting } from "../settings/resolve.ts";

export interface EnrichmentEntry {
  label?: string;
  tier?: string;
  production?: boolean;
  reasonSuggestion?: string;
  db?: { database?: string; schema?: string; user?: string };
}

const SETTING_KEY = "rt.sdmEnrichment";

export function enrichmentPath(): string {
  return join(rtDir(), "sdm", "enrichment.jsonc");
}

// Re-exported for existing importers; the implementation moved to
// lib/jsonc.ts when the validate-farm overlay files needed a string-aware
// version (origin URLs contain `//`, which the old regex ate).
export { stripJsonc } from "../jsonc.ts";

/**
 * The ownership-latch probe: `undefined` means `rt.sdmEnrichment` is unowned
 * and the legacy file stays authoritative. Exported so the `rt sdm
 * enrichment init` scaffold verb can refuse to write the file once the team
 * store owns the key.
 */
export function probeEnrichmentStore(): Record<string, EnrichmentEntry> | undefined {
  try {
    return getSetting<Record<string, EnrichmentEntry>>(SETTING_KEY).value;
  } catch (err) {
    console.warn(`rt: ignoring "${SETTING_KEY}" — ${(err as Error).message}`);
    return undefined;
  }
}

export function loadEnrichment(path = enrichmentPath()): Record<string, EnrichmentEntry> {
  const owned = probeEnrichmentStore();
  if (owned !== undefined) return owned;

  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(stripJsonc(raw));
  } catch (err) {
    if (existsSync(path)) {
      console.warn(`rt: failed to parse ${path}, ignoring enrichment file: ${(err as Error).message}`);
    }
    return {};
  }
}
