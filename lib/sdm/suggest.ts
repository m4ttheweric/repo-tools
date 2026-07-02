/**
 * LLM suggest pass for `rt sdm refresh --suggest`. The ONLY place an LLM
 * participates in sdm, and it stays off the connect/resolve hot path: this
 * drafts suggestions for a connector's `unresolved` gaps into
 * ~/.rt/sdm/suggestions.json for a human to review before pinning any of
 * them as overrides.
 *
 * Honesty guard: the model may only pick among a gap's own `candidates` (the
 * live catalog); a reply that doesn't exactly match one is coerced to null
 * rather than trusted, mirroring the "never fabricate a resource name" rule
 * that governs the rest of sdm resolution.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { rtDir } from "../rt-paths.ts";
import { LlmEmptyResponseError, LlmUnavailableError } from "../llm.ts";
import type { UnresolvedGap } from "./connectors.ts";
import type { EnvKey } from "./protocol.ts";

export interface SuggestionRecord {
  key: string;
  slug: string;
  env: EnvKey;
  resource: string | null;
  reasoning: string;
}

export interface SuggestDeps {
  llm: (system: string, user: string) => Promise<string>;
}

const SYSTEM_PROMPT =
  "You pick the read-write primary Postgres resource for a deployment, or reply null. " +
  "Reply ONLY compact JSON {\"resource\":string|null,\"reasoning\":string}.";

function buildUserPrompt(gap: UnresolvedGap): string {
  const lines = [
    `slug: ${gap.slug}`,
    `env: ${gap.env}`,
  ];
  if (gap.url) lines.push(`url: ${gap.url}`);
  if (gap.tier) lines.push(`tier: ${gap.tier}`);
  if (gap.note) lines.push(`note: ${gap.note}`);
  lines.push(`candidates: ${gap.candidates.join(", ")}`);
  if (gap.readOnlyAlt) lines.push(`read-only alt (never pick this): ${gap.readOnlyAlt}`);
  return lines.join("\n");
}

interface ParsedReply {
  resource: string | null;
  reasoning: string;
}

/**
 * Defensive JSON parse: the prompt asks for compact bare JSON, but models
 * sometimes wrap it in prose or a code fence anyway. Try the raw text first,
 * then fall back to the first {...} substring. Never throws; a reply that
 * still doesn't parse or match the expected shape yields null.
 */
function parseReply(raw: string): ParsedReply | null {
  const tryParse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  let parsed = tryParse(raw.trim());
  if (parsed === undefined) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) parsed = tryParse(match[0]);
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const resource = obj.resource;
  const reasoning = obj.reasoning;
  if (resource !== null && typeof resource !== "string") return null;
  if (typeof reasoning !== "string") return null;

  return { resource, reasoning };
}

/**
 * Draft one suggestion per gap. A gap with no candidates has nothing to
 * choose among, so it is recorded without ever calling the LLM. Every other
 * gap gets a strict system+user prompt; an unreachable/empty LLM or an
 * unparseable reply skips just that gap (per-gap isolation, mirroring
 * connectors.ts: one bad gap must never sink the rest of the pass).
 */
export async function suggestForGaps(gaps: UnresolvedGap[], deps: SuggestDeps): Promise<SuggestionRecord[]> {
  const records: SuggestionRecord[] = [];

  for (const gap of gaps) {
    if (gap.candidates.length === 0) {
      records.push({ key: gap.key, slug: gap.slug, env: gap.env, resource: null, reasoning: "no candidates" });
      continue;
    }

    let raw: string;
    try {
      raw = await deps.llm(SYSTEM_PROMPT, buildUserPrompt(gap));
    } catch (err) {
      if (err instanceof LlmUnavailableError || err instanceof LlmEmptyResponseError) continue;
      throw err;
    }

    const parsed = parseReply(raw);
    if (!parsed) continue; // malformed/unparseable reply... skip this gap

    // Honesty guard: the model may not invent a resource name. Only an exact
    // match against this gap's own candidates is trusted.
    const resource = parsed.resource !== null && gap.candidates.includes(parsed.resource) ? parsed.resource : null;

    records.push({ key: gap.key, slug: gap.slug, env: gap.env, resource, reasoning: parsed.reasoning });
  }

  return records;
}

/** ~/.rt/sdm/suggestions.json: written by `rt sdm refresh --suggest`, read by a human. */
export function suggestionsPath(): string {
  return join(rtDir(), "sdm", "suggestions.json");
}

export function writeSuggestions(records: SuggestionRecord[], path = suggestionsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(records, null, 2) + "\n");
}

function isSuggestionRecord(v: unknown): v is SuggestionRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.key === "string" &&
    typeof r.slug === "string" &&
    typeof r.env === "string" &&
    (r.resource === null || typeof r.resource === "string") &&
    typeof r.reasoning === "string"
  );
}

/**
 * Guarded read of suggestions.json, same convention as loadSdmState: a
 * missing file, corrupt JSON, or a shape that doesn't look like
 * SuggestionRecord[] all fall back to no suggestions rather than throwing.
 * Individual malformed entries are dropped rather than sinking the rest.
 */
export function readSuggestions(path = suggestionsPath()): SuggestionRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(parsed)) return parsed.filter(isSuggestionRecord);
  } catch {
    // Missing or corrupt suggestions file: suggestions are best-effort.
  }
  return [];
}
