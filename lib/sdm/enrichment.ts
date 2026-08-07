/**
 * Declarative enrichment overlay: a user-maintained JSONC file at
 * ~/.rt/sdm/enrichment.jsonc that layers labels, tiers, and db defaults on
 * top of resources the catalog scanner (scan.ts) already discovered. Pure
 * and additive: loading never mutates the file and never throws, so a
 * missing or corrupt file just means "no enrichment" rather than a crash.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripJsonc } from "../jsonc.ts";

export interface EnrichmentEntry {
  label?: string;
  tier?: string;
  production?: boolean;
  reasonSuggestion?: string;
  db?: { database?: string; schema?: string; user?: string };
}

export function enrichmentPath(): string {
  return join(homedir(), ".rt", "sdm", "enrichment.jsonc");
}

// Re-exported for existing importers; the implementation moved to
// lib/jsonc.ts when the validate-farm overlay files needed a string-aware
// version (origin URLs contain `//`, which the old regex ate).
export { stripJsonc } from "../jsonc.ts";

export function loadEnrichment(path = enrichmentPath()): Record<string, EnrichmentEntry> {
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
