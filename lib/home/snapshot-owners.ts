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

/** Thrown by claimZone when `zone` is already claimed by a DIFFERENT owner and the caller didn't pass `force: true`. */
export class ZoneOwnedByOthersError extends Error {
  constructor(public readonly zone: string, public readonly existingOwner: string) {
    super(`"${zone}" is already claimed by ${existingOwner} — pass force to reassign it`);
  }
}

/**
 * A zone is either a DIRECTORY (claims itself and everything under it) or a
 * FILE (claims exactly that one path). The trailing slash on the STORED key
 * is the only marker distinguishing the two — "prefs/" is a dir zone,
 * "scripts/deploy.sh" is a file zone — so `normalizeZone`'s `kind` argument
 * controls whether one gets appended, and every reader downstream (the
 * planner's `isUnderZone`, the daemon's `:(exclude)` pathspec) trusts that
 * convention rather than re-deriving it. Claiming a FILE with a dir-zone
 * key was the original bug this fixes: `startsWith("scripts/deploy.sh/")`
 * never matches the file "scripts/deploy.sh" itself, so the zone claimed
 * nothing — verified against real git, `:(exclude)scripts/deploy.sh/` also
 * matches nothing.
 */
export type ZoneKind = "dir" | "file";

const FORMAT = { tabSize: 2, insertSpaces: true, eol: "\n" };

/**
 * `kind: "dir"` (the default): "prefs" -> "prefs/". `kind: "file"`:
 * "scripts/deploy.sh" stays exactly "scripts/deploy.sh" — no trailing
 * slash is ever appended for a file zone, since that slash is what the
 * rest of this module reads back as "this is a directory prefix, not an
 * exact path". Throws InvalidZoneError on an empty zone, a leading "/", a
 * backslash, or any "."/".." segment (checked identically for both kinds).
 */
export function normalizeZone(zone: string, kind: ZoneKind = "dir"): string {
  if (zone.length === 0 || zone.startsWith("/") || zone.includes("\\")) throw new InvalidZoneError(zone);
  const segments = zone.split("/").filter((s) => s.length > 0);
  if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) throw new InvalidZoneError(zone);
  const bare = segments.join("/");
  return kind === "file" ? bare : `${bare}/`;
}

/**
 * Reads the owners file, tolerant of a missing file and a whitespace-only
 * one. Every zone key is re-run through `normalizeZone`, with `kind`
 * derived from whether the RAW stored key already ends with "/" (a
 * hand-edited "prefs" with no trailing slash still converges on the dir
 * form "prefs/"; a file zone key never carries one to begin with) — an
 * un-normalized dir key would either swallow an unrelated sibling ("prefs"
 * matching "prefs-old/…") or match nothing at all. Throws (fails closed —
 * see module doc) on malformed jsonc, a non-object `zones`, a non-object
 * zone entry, a zone key that fails normalization, or an entry whose
 * `owner` isn't a non-empty string — an unreadable owner is as dangerous
 * as an unreadable zone key, since the daemon's janitor message and the
 * CLI's "already claimed by X" refusal both trust it.
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
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.owner !== "string" || entry.owner.trim().length === 0) {
      throw new Error(`${path}: zone "${rawZone}" has no valid "owner" (must be a non-empty string)`);
    }
    const kind: ZoneKind = rawZone.endsWith("/") ? "dir" : "file";
    zones[normalizeZone(rawZone, kind)] = entry as unknown as OwnerEntry;
  }

  return { zones };
}

export interface ClaimOptions {
  note?: string;
  /** "dir" (default) claims the path and everything under it; "file" claims exactly that one path (no trailing slash). The caller decides — typically by stat'ing the real path — since a claim on a not-yet-created path can't tell the difference itself. */
  kind?: ZoneKind;
  /** Skip the already-claimed-by-someone-else check and overwrite it. */
  force?: boolean;
}

/**
 * Claims `zone` for `owner`, comment-preserving. Throws InvalidZoneError
 * before touching the file, or ZoneOwnedByOthersError if the zone is
 * already claimed by a DIFFERENT owner and `opts.force` isn't set —
 * reassigning someone else's claim is presumed a mistake, not routine.
 */
export function claimZone(path: string, zone: string, owner: string, opts: ClaimOptions = {}): void {
  const kind = opts.kind ?? "dir";
  const normalized = normalizeZone(zone, kind);

  if (!opts.force) {
    const existing = readOwners(path).zones[normalized];
    if (existing !== undefined && existing.owner !== owner) {
      throw new ZoneOwnedByOthersError(normalized, existing.owner);
    }
  }

  const entry: OwnerEntry = opts.note === undefined ? { owner, claimedAt: new Date().toISOString() } : { owner, claimedAt: new Date().toISOString(), note: opts.note };
  writeIntoOwnersFile(path, ["zones", normalized], entry);
}

export interface ReleaseResult {
  released: boolean;
  /** The actual stored key that was released (dir or file form) — only set when `released`. */
  zone?: string;
  owner?: string;
}

/**
 * Releases `zone`, comment-preserving. Tries BOTH the file form and the dir
 * form of `zone` (not a caller-supplied `kind`) and releases whichever is
 * actually claimed — release must work even when the underlying path no
 * longer exists (deleted after being claimed), so it can't rely on a fresh
 * stat the way claimZone does. A no-op (file untouched) if neither form was
 * claimed.
 */
export function releaseZone(path: string, zone: string): ReleaseResult {
  const current = readOwners(path);
  const fileForm = normalizeZone(zone, "file");
  const dirForm = normalizeZone(zone, "dir");

  const match = current.zones[fileForm] !== undefined ? fileForm : current.zones[dirForm] !== undefined ? dirForm : undefined;
  if (match === undefined) return { released: false };

  const owner = current.zones[match]!.owner;
  writeIntoOwnersFile(path, ["zones", match], undefined);
  return { released: true, zone: match, owner };
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
