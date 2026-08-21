/**
 * snapshot-owners.jsonc — the claimed-zone registry the snapshot daemon
 * consults before auto-committing (Task 2) and `rt home claim/release`
 * write directly (Task 3). Reads and writes are comment-preserving: the
 * settings writer's `modify`/`applyEdits` pattern (packages/rt-client/src/
 * settings/write.ts) isn't reusable here — it's coupled to the settings
 * registry (key lookup, scope stores) — so this is a thin, single-file
 * version of the same write-temp-then-rename + jsonc-parser `modify` idiom.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { dirname } from "path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

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
    super(`"${zone}" is not a valid snapshot zone (must be non-empty, no leading "/", no ".." segment)`);
  }
}

const FORMAT = { tabSize: 2, insertSpaces: true, eol: "\n" };

const EMPTY_TEMPLATE =
  "{\n  // snapshot-owners.jsonc — claimed zones the snapshot daemon must never\n  // auto-commit. Empty until a zone is claimed.\n}\n";

/** "prefs" -> "prefs/"; throws InvalidZoneError on an empty zone, a leading "/", or any ".." segment. */
export function normalizeZone(zone: string): string {
  if (zone.length === 0 || zone.startsWith("/")) throw new InvalidZoneError(zone);
  const segments = zone.split("/").filter((s) => s.length > 0);
  if (segments.length === 0 || segments.includes("..")) throw new InvalidZoneError(zone);
  return zone.endsWith("/") ? zone : `${zone}/`;
}

/** Reads the owners file, tolerant of a missing file and the empty (comment-only) template. Throws on genuinely malformed jsonc. */
export function readOwners(path: string): Owners {
  if (!existsSync(path)) return { zones: {} };

  const text = readFileSync(path, "utf8");
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    throw new Error(`${path}: malformed jsonc`);
  }
  if (parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { zones: {} };
  }

  const zones = (parsed as { zones?: unknown }).zones;
  if (zones === undefined || typeof zones !== "object" || Array.isArray(zones)) {
    return { zones: {} };
  }

  return { zones: zones as Record<string, OwnerEntry> };
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
  const content = existsSync(path) ? readFileSync(path, "utf8") : EMPTY_TEMPLATE;

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
