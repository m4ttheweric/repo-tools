/**
 * The snapshot daemon's pure planner. Turns a git-status snapshot + the
 * owners file + persisted first-seen-dirty state into a SnapshotPlan. No
 * I/O — Task 2's daemon module runs `git status --porcelain=v1 -uall -z`,
 * parses it with `parsePorcelainZ` (below — same module, same encoding
 * contract), and applies the resulting plan.
 */

import type { Owners } from "../home/snapshot-owners.ts";

export interface StatusEntry {
  /** The 2-char porcelain status code (e.g. "??", " M", "R "). */
  xy: string;
  /** The current working-tree path. For a rename/copy this is the NEW path. */
  path: string;
  /** Present only for a rename/copy entry: the path it moved/copied FROM. */
  origPath?: string;
}

export interface PlanSnapshotInput {
  entries: StatusEntry[];
  owners: Owners;
  now: number;
  firstSeenDirty: Record<string, number>;
  thresholdMs: number;
}

export interface JanitorZone {
  zone: string;
  owner: string;
  dirtySinceMs: number;
}

export interface SnapshotPlan {
  autoPaths: string[];
  excludedZones: string[];
  janitorZones: JanitorZone[];
  message: string | null;
  nextFirstSeenDirty: Record<string, number>;
}

const TOP_LEVEL_LIMIT = 5;

/**
 * Parses `git status --porcelain=v1 -uall -z` output. Entries are
 * NUL-terminated, not newline-terminated: a trailing NUL leaves one empty
 * string at the end of the split, dropped here; a genuinely clean repo
 * produces an empty buffer (no output at all, not even one NUL), which
 * must parse to zero entries, not one empty-string entry. Unlike the
 * non-`-z` format, there is no " -> " arrow and no C-quoting of paths with
 * spaces or unicode — the raw NUL split already isolates each field, so
 * paths pass through untouched.
 *
 * A rename or copy occupies TWO consecutive raw entries: "XY newPath" then
 * a bare origPath with NO "XY " prefix of its own — consuming a second raw
 * entry unconditionally whenever the status code carries an 'R' or 'C' is
 * therefore required, not optional, or the parser desyncs on every entry
 * that follows.
 */
export function parsePorcelainZ(buffer: string): StatusEntry[] {
  if (buffer.length === 0) return [];

  const raw = buffer.split("\0");
  if (raw[raw.length - 1] === "") raw.pop();

  const entries: StatusEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i] as string;
    const xy = line.slice(0, 2);
    const path = line.slice(3);
    const isRenameOrCopy = xy.includes("R") || xy.includes("C");

    if (isRenameOrCopy) {
      i++;
      entries.push({ xy, path, origPath: raw[i] });
    } else {
      entries.push({ xy, path });
    }
  }
  return entries;
}

function isUnderZone(path: string, zone: string): boolean {
  return path.startsWith(zone);
}

/** True if `zone` claims either where the entry now lives or (for a rename/copy) where it moved from — a rename out of a claimed zone still dirties that zone. */
function entryTouchesZone(entry: StatusEntry, zone: string): boolean {
  return isUnderZone(entry.path, zone) || (entry.origPath !== undefined && isUnderZone(entry.origPath, zone));
}

/** The commit-message grouping key: the first path segment, or the whole path for a root-level file. */
function topLevelPath(path: string): string {
  const idx = path.indexOf("/");
  return idx === -1 ? path : path.slice(0, idx);
}

function buildMessage(autoPaths: string[]): string {
  const topLevels: string[] = [];
  for (const path of autoPaths) {
    const top = topLevelPath(path);
    if (!topLevels.includes(top)) topLevels.push(top);
  }
  const shown = topLevels.slice(0, TOP_LEVEL_LIMIT);
  const extra = topLevels.length - shown.length;
  return `snapshot: ${shown.join(", ")}${extra > 0 ? ` +${extra} more` : ""}`;
}

export function planSnapshot(input: PlanSnapshotInput): SnapshotPlan {
  const zones = Object.keys(input.owners.zones);

  const autoPaths = input.entries
    .filter((entry) => !zones.some((zone) => isUnderZone(entry.path, zone)))
    .map((entry) => entry.path);
  const excludedZones = [...zones];

  const nextFirstSeenDirty: Record<string, number> = {};
  const janitorZones: JanitorZone[] = [];
  for (const zone of zones) {
    const dirty = input.entries.some((entry) => entryTouchesZone(entry, zone));
    if (!dirty) continue;

    const firstSeen = input.firstSeenDirty[zone] ?? input.now;
    nextFirstSeenDirty[zone] = firstSeen;

    if (input.now - firstSeen >= input.thresholdMs) {
      janitorZones.push({ zone, owner: input.owners.zones[zone]!.owner, dirtySinceMs: firstSeen });
    }
  }

  return {
    autoPaths,
    excludedZones,
    janitorZones,
    message: autoPaths.length === 0 ? null : buildMessage(autoPaths),
    nextFirstSeenDirty,
  };
}
