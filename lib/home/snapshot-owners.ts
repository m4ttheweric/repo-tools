/**
 * snapshot-owners.jsonc — the claimed-zone registry the snapshot daemon
 * consults before auto-committing (Task 2) and `rt home claim/release`
 * write directly (Task 3). Reads and writes are comment-preserving: the
 * settings writer's `modify`/`applyEdits` pattern (packages/rt-client/src/
 * settings/write.ts) isn't reusable here — it's coupled to the settings
 * registry (key lookup, scope stores) — so this is a thin, single-file
 * version of the same write-temp-then-rename + jsonc-parser `modify` idiom,
 * including its "refuse rather than edit around damage" editability guard.
 *
 * Malformed input fails CLOSED, not open: a zone whose protection can't be
 * trusted (an unparseable file, a `zones` that isn't an object, a duplicate
 * `zones` key, a hand-edited zone key that doesn't survive normalization)
 * throws rather than silently degrading to "no zones claimed" — the daemon
 * (Task 2) must skip the cycle on that throw instead of auto-committing
 * over a zone whose claim it couldn't actually read.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { dirname } from "path";
import { applyEdits, modify, parse, parseTree, type Node, type ParseError } from "jsonc-parser";
import { renderOwnersFile } from "./init-plan.ts";

export interface OwnerEntry {
  owner: string;
  claimedAt: string;
  note?: string;
}

export interface Owners {
  zones: Record<string, OwnerEntry>;
}

export class InvalidZoneError extends Error {
  constructor(zone: string) {
    super(`"${zone}" is not a valid snapshot zone (must be non-empty, no leading "/", no backslash, no "." or ".." segment)`);
  }
}

const FORMAT = { tabSize: 2, insertSpaces: true, eol: "\n" };

/** "prefs" -> "prefs/"; throws InvalidZoneError on an empty zone, a leading "/", a backslash, or any "."/".." segment. */
export function normalizeZone(zone: string): string {
  if (zone.length === 0 || zone.startsWith("/") || zone.includes("\\")) throw new InvalidZoneError(zone);
  const segments = zone.split("/").filter((s) => s.length > 0);
  if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) throw new InvalidZoneError(zone);
  return zone.endsWith("/") ? zone : `${zone}/`;
}

/**
 * Reads the owners file, tolerant of a missing file and a whitespace-only
 * one. Every zone key is re-run through `normalizeZone` so a hand-edited
 * key ("prefs" with no trailing slash, "./prefs/") converges on the same
 * startsWith-anchored form the planner and claimZone/releaseZone use — an
 * un-normalized key would either swallow an unrelated sibling ("prefs"
 * matching "prefs-old/…") or match nothing at all. Throws (fails closed —
 * see module doc) on malformed jsonc, a non-object `zones`, a non-object
 * zone entry, or a zone key that fails normalization.
 */
export function readOwners(path: string): Owners {
  if (!existsSync(path)) return { zones: {} };

  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) return { zones: {} };

  assertEditableJsonc(path, text);

  const parsed = parse(text, [], { allowTrailingComma: true }) as Record<string, unknown>;
  if (!("zones" in parsed)) return { zones: {} };

  const zonesRaw = parsed.zones;
  if (typeof zonesRaw !== "object" || zonesRaw === null || Array.isArray(zonesRaw)) {
    throw new Error(`${path}: "zones" must be an object`);
  }

  const zones: Record<string, OwnerEntry> = {};
  for (const [rawZone, rawEntry] of Object.entries(zonesRaw as Record<string, unknown>)) {
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
      throw new Error(`${path}: zone "${rawZone}" entry must be an object`);
    }
    zones[normalizeZone(rawZone)] = rawEntry as OwnerEntry;
  }

  return { zones };
}

/** Claims `zone` for `owner`, comment-preserving. Throws InvalidZoneError before touching the file. */
export function claimZone(path: string, zone: string, owner: string, note?: string): void {
  const normalized = normalizeZone(zone);
  const entry: OwnerEntry = note === undefined ? { owner, claimedAt: new Date().toISOString() } : { owner, claimedAt: new Date().toISOString(), note };
  writeIntoOwnersFile(path, ["zones", normalized], entry);
}

/** Releases `zone`, comment-preserving. A no-op (file untouched) if the zone was never claimed. */
export function releaseZone(path: string, zone: string): void {
  const normalized = normalizeZone(zone);
  const current = readOwners(path);
  if (current.zones[normalized] === undefined) return;
  writeIntoOwnersFile(path, ["zones", normalized], undefined);
}

function writeIntoOwnersFile(path: string, jsonPath: (string | number)[], value: unknown): void {
  const onDisk = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const content = onDisk === undefined || onDisk.trim().length === 0 ? renderOwnersFile() : onDisk;

  assertEditableJsonc(path, content);

  const edits = modify(content, jsonPath, value, { formattingOptions: FORMAT });
  const next = applyEdits(content, edits);
  const finalText = next.endsWith("\n") ? next : `${next}\n`;

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, finalText);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp file never got created, or was already cleaned up — nothing to do
    }
    throw err;
  }
}

/**
 * Refuses to read or edit a document that isn't a single well-formed jsonc
 * object: real parse errors, a non-object root, or a duplicate key anywhere
 * in the tree (jsonc-parser's `modify` edits the FIRST occurrence by
 * offset, while `parse` returns the LAST — a naive edit would report
 * success while the effective value never changed). Mirrors
 * packages/rt-client/src/settings/write.ts's assertEditableJsonc; not
 * imported from there because that module is coupled to the settings
 * registry store-resolution path, not reusable for an arbitrary file.
 */
function assertEditableJsonc(path: string, content: string): void {
  const errors: ParseError[] = [];
  const tree = parseTree(content, errors, { allowTrailingComma: true });

  const malformed =
    errors.length > 0 || tree === undefined || tree.type !== "object" || findDuplicateKey(tree) !== undefined;

  if (malformed) {
    throw new Error(`${path}: malformed jsonc — refusing to read/edit (parse error, non-object root, or a duplicate key)`);
  }
}

/** Depth-first search for the first duplicate property name in any object in the tree. */
function findDuplicateKey(node: Node): string | undefined {
  if (node.type === "object" && node.children) {
    const seen = new Set<string>();
    for (const property of node.children) {
      const keyNode = property.children?.[0];
      if (keyNode !== undefined && typeof keyNode.value === "string") {
        if (seen.has(keyNode.value)) return keyNode.value;
        seen.add(keyNode.value);
      }
      const valueNode = property.children?.[1];
      if (valueNode !== undefined) {
        const nested = findDuplicateKey(valueNode);
        if (nested !== undefined) return nested;
      }
    }
    return undefined;
  }
  if (node.type === "array" && node.children) {
    for (const child of node.children) {
      const nested = findDuplicateKey(child);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}
