/**
 * Owner-side mint records — the only place `rt members sync` can recover an
 * outstanding invite's creatorSecret to poll the relay for a reply. Never
 * leaves the machine: ~/.mattstack/rt/invites/<slug>.json (0600).
 */

import { dirname, join } from "path";
import type { Probes } from "../setup/probes.ts";

export interface InviteRecord {
  id: string;
  creatorSecret: string;
  keyB64: string;
  expiresAt: string;
}

export type InviteRecords = Record<string, InviteRecord>;

const RECORDS_MODE = 0o600;

export function inviteRecordsPath(home: string, slug: string): string {
  return join(home, ".mattstack", "rt", "invites", `${slug}.json`);
}

export function readInviteRecords(p: Pick<Probes, "readFile" | "home">, slug: string): InviteRecords {
  const raw = p.readFile(inviteRecordsPath(p.home, slug));
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as InviteRecords;
  } catch {
    return {};
  }
}

export function upsertInviteRecord(
  p: Pick<Probes, "readFile" | "writeFile" | "mkdirp" | "home">,
  slug: string,
  handle: string,
  rec: InviteRecord,
): void {
  const records = readInviteRecords(p, slug);
  records[handle] = rec;
  const path = inviteRecordsPath(p.home, slug);
  p.mkdirp(dirname(path));
  p.writeFile(path, JSON.stringify(records), RECORDS_MODE);
}

export function removeInviteRecord(
  p: Pick<Probes, "readFile" | "writeFile" | "mkdirp" | "home">,
  slug: string,
  handle: string,
): void {
  const records = readInviteRecords(p, slug);
  if (!(handle in records)) return;
  delete records[handle];
  const path = inviteRecordsPath(p.home, slug);
  p.mkdirp(dirname(path));
  p.writeFile(path, JSON.stringify(records), RECORDS_MODE);
}
