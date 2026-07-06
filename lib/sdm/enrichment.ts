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

/**
 * Strips comments and trailing commas so the result parses as plain JSON.
 * The `//` stripping is a plain regex, not a tokenizer, so a `//` occurring
 * inside a string value (e.g. a label) would be misread as a comment. This
 * is an accepted limitation: enrichment labels are not expected to contain
 * `//`.
 */
export function stripJsonc(text: string): string {
  const noBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLineComments = noBlockComments.replace(/\/\/.*$/gm, "");
  return noLineComments.replace(/,(\s*[}\]])/g, "$1");
}

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
