/**
 * One field of the machine-local team record, for the write guard. The record
 * itself is owned by repo-tools/lib/team/team-local.ts; this reads only what
 * the guard needs and never writes.
 */

import { readFileSync } from "fs";
import { teamLocalPath } from "./paths.ts";

/** Unreadable, absent or malformed all read as false, so nothing that predates the field is refused. */
export function isJoinedTeam(team: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(teamLocalPath(team), "utf8"));
    return typeof parsed === "object" && parsed !== null && (parsed as { joinedByRt?: unknown }).joinedByRt === true;
  } catch {
    return false;
  }
}
