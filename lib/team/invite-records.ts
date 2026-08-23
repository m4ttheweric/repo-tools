/**
 * Owner-side mint records — the only place `rt members sync` can recover an
 * outstanding invite's creatorSecret to poll the relay for a reply. Never
 * leaves the machine: ~/.mattstack/rt/invites/<slug>.json (0600).
 */

import { dirname, join } from "path";
import type { Probes } from "../setup/probes.ts";
import { UserActionableError } from "../setup/errors.ts";

export interface InviteRecord {
  id: string;
  creatorSecret: string;
  keyB64: string;
  expiresAt: string;
}

export type InviteRecords = Record<string, InviteRecord>;

const RECORDS_MODE = 0o600;
const RECORDS_DIR_MODE = 0o700;

export function inviteRecordsPath(home: string, slug: string): string {
  return join(home, ".mattstack", "rt", "invites", `${slug}.json`);
}

/**
 * A null-prototype result: `records[handle] = rec` runs later with
 * arbitrary user-supplied handles, and on a normal object a handle of
 * "__proto__" hits Object.prototype's setter instead of creating an own
 * property, silently discarding the record.
 */
function emptyRecords(): InviteRecords {
  return Object.create(null) as InviteRecords;
}

export function readInviteRecords(p: Pick<Probes, "readFile" | "home">, slug: string): InviteRecords {
  const raw = p.readFile(inviteRecordsPath(p.home, slug));
  if (raw === null) return emptyRecords();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyRecords();
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UserActionableError("unreadable-records", "invite records file is not a valid records map");
  }

  const records = emptyRecords();
  for (const [handle, rec] of Object.entries(parsed as Record<string, unknown>)) {
    records[handle] = rec as InviteRecord;
  }
  return records;
}

function isExpired(rec: InviteRecord, now: Date): boolean {
  return !(Date.parse(rec.expiresAt) >= now.getTime());
}

function writeRecords(
  p: Pick<Probes, "writeFile" | "mkdirp" | "chmod" | "home" | "now">,
  slug: string,
  records: InviteRecords,
): void {
  const pruned = emptyRecords();
  for (const [handle, rec] of Object.entries(records)) {
    if (!isExpired(rec, p.now())) pruned[handle] = rec;
  }

  const path = inviteRecordsPath(p.home, slug);
  p.mkdirp(dirname(path), RECORDS_DIR_MODE);
  p.writeFile(path, JSON.stringify(pruned), RECORDS_MODE);
  // writeFile's mode only takes effect on a freshly-created inode; chmod
  // re-asserts 0600 on a file that already existed looser (restored from a
  // backup, rsynced from another machine, hand-created).
  p.chmod(path, RECORDS_MODE);
}

export function upsertInviteRecord(
  p: Pick<Probes, "readFile" | "writeFile" | "mkdirp" | "chmod" | "home" | "now">,
  slug: string,
  handle: string,
  rec: InviteRecord,
): void {
  const records = readInviteRecords(p, slug);
  records[handle] = rec;
  writeRecords(p, slug, records);
}

export function removeInviteRecord(
  p: Pick<Probes, "readFile" | "writeFile" | "mkdirp" | "chmod" | "home" | "now">,
  slug: string,
  handle: string,
): void {
  const records = readInviteRecords(p, slug);
  if (!(handle in records)) return;
  delete records[handle];
  writeRecords(p, slug, records);
}
