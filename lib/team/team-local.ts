/**
 * Per-team facts that are true of THIS MACHINE, not of the team — kept beside
 * the mint records at ~/.mattstack/rt/teams/<slug>.json (0600) and never
 * synced anywhere.
 *
 * `rtMayManageMembership` is the reason this file exists, and the reason it is
 * local. It is a permission the operator grants, so it must not be readable
 * from the team repo: that repo is other-party content for everyone except its
 * owner, and a synced flag would let a team's author turn on a privileged
 * capability on a member's machine — the precise bug the permission exists to
 * prevent (MAT-387).
 */

import { dirname, join } from "path";
import type { Probes } from "../setup/probes.ts";

export interface TeamLocalRecord {
  /**
   * rt created this team's remote itself (`gh repo create`), rather than being
   * pointed at one that already existed.
   *
   * Confers no rights. It only decides whether the membership permission is
   * OFFERED, so rt never asks "shall I manage membership on
   * <someone-else's-repo>?" — a question that should not be answerable yes.
   */
  createdByRt: boolean;
  /**
   * The operator has asked rt to add and remove people on this team's remote
   * when teammates are added or removed.
   *
   * Absent means false: a permission that was never granted is not held. Every
   * team that predates this file is therefore off, with no migration.
   */
  rtMayManageMembership: boolean;
}

const RECORD_MODE = 0o600;
const RECORD_DIR_MODE = 0o700;

export function teamLocalPath(home: string, slug: string): string {
  return join(home, ".mattstack", "rt", "teams", `${slug}.json`);
}

const EMPTY: TeamLocalRecord = { createdByRt: false, rtMayManageMembership: false };

/** Unreadable, absent, or malformed all yield the same all-false record: a machine that cannot prove it holds a permission does not hold it. */
export function readTeamLocal(p: Pick<Probes, "readFile" | "home">, slug: string): TeamLocalRecord {
  const raw = p.readFile(teamLocalPath(p.home, slug));
  if (raw === null) return { ...EMPTY };
  try {
    const parsed = JSON.parse(raw) as Partial<TeamLocalRecord>;
    return {
      createdByRt: parsed.createdByRt === true,
      rtMayManageMembership: parsed.rtMayManageMembership === true,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function writeTeamLocal(
  p: Pick<Probes, "home" | "mkdirp" | "writeFile" | "chmod">,
  slug: string,
  record: TeamLocalRecord,
): void {
  const path = teamLocalPath(p.home, slug);
  p.mkdirp(dirname(path));
  p.chmod(dirname(path), RECORD_DIR_MODE);
  p.writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  p.chmod(path, RECORD_MODE);
}

/** Merges one field without clobbering the rest — callers set `createdByRt` and the operator sets the permission, at different times. */
export function updateTeamLocal(
  p: Pick<Probes, "readFile" | "home" | "mkdirp" | "writeFile" | "chmod">,
  slug: string,
  patch: Partial<TeamLocalRecord>,
): TeamLocalRecord {
  const next = { ...readTeamLocal(p, slug), ...patch };
  writeTeamLocal(p, slug, next);
  return next;
}
