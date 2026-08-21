/**
 * The snapshot daemon's pure planner. Turns a git-status snapshot + the
 * owners file + persisted first-seen-dirty state into a SnapshotPlan. No
 * I/O — Task 2's daemon module runs git and applies this plan.
 */

import type { Owners } from "../home/snapshot-owners.ts";

export interface PlanSnapshotInput {
  /** `git status --porcelain=v1 -z` (or `-uall`) lines, one status entry per string. */
  statusLines: string[];
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

/** Extracts the path from one porcelain status line ("XY path", or "XY old -> new" for a rename — the destination is "the path"). */
function pathFromStatusLine(line: string): string {
  const rest = line.slice(3);
  const arrow = rest.indexOf(" -> ");
  return arrow === -1 ? rest : rest.slice(arrow + 4);
}

function isUnderZone(path: string, zone: string): boolean {
  return path.startsWith(zone);
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
  const paths = input.statusLines.map(pathFromStatusLine);
  const zones = Object.keys(input.owners.zones);

  const autoPaths = paths.filter((path) => !zones.some((zone) => isUnderZone(path, zone)));
  const excludedZones = [...zones];

  const nextFirstSeenDirty: Record<string, number> = {};
  const janitorZones: JanitorZone[] = [];
  for (const zone of zones) {
    const dirty = paths.some((path) => isUnderZone(path, zone));
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
