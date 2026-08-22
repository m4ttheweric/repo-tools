/**
 * `rt team members sync|remove` — the owner side of the invite loop: sync
 * turns each outstanding invite record with a posted reply into a sops
 * recipient and a roster entry; remove revokes forge access, drops the
 * roster entry, and re-encrypts every domain file without that member's key.
 *
 * Every reply blob crossing `relay.readReply` is attacker-controlled (the
 * relay itself, or anyone who intercepted the invite code, could have
 * posted it) — `openReply` only proves the blob decrypted under THIS
 * invite's key/AAD, not that its `agePublicKey` is actually a usable age
 * recipient. That shape is checked again here before the key ever reaches
 * `addTeamRecipient` (and so `.sops.yaml`): a malformed value stays pending
 * for the next sync rather than poisoning the recipient list.
 */

import { ensureAgeKey } from "../home/age-key.ts";
import { teamSettingsPath } from "../rt-paths.ts";
import type { SecretsSeams } from "../secrets/store.ts";
import { addTeamRecipient, removeTeamRecipient } from "../secrets/team-store.ts";
import { readStore } from "../settings/stores.ts";
import { setSetting } from "../settings/write.ts";
import type { Probes } from "../setup/probes.ts";
import { parseOriginUrl, type SettingsReader } from "../setup/team-settings.ts";
import { revokeRead, type RevokeAccess } from "./forge.ts";
import { openReply } from "./invite-crypto.ts";
import { readInviteRecords, removeInviteRecord } from "./invite-records.ts";
import type { RelayClient } from "./relay-client.ts";

// Real age1 recipients are bech32 (lowercase, digits, excluding 1/b/i/o in
// the data portion) after the fixed "age1" prefix — a plain typeof-string
// check (openReply's own shape guard) would let a joiner's reply carry
// arbitrary bytes (including YAML-breaking characters) straight into
// .sops.yaml's `age:` line.
const AGE_PUBLIC_KEY_PATTERN = /^age1[023456789acdefghjklmnpqrstuvwxyz]{50,}$/;

function isValidAgePublicKey(key: string): boolean {
  return AGE_PUBLIC_KEY_PATTERN.test(key);
}

function base64ToKey(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

interface RosterMember {
  username: string;
  agePublicKey?: string;
  [key: string]: unknown;
}

function readRoster(seams: MembersSeams, slug: string): RosterMember[] {
  const store = seams.readTeamStore(slug);
  return Array.isArray(store["board.members"]) ? (store["board.members"] as RosterMember[]) : [];
}

/** Sets (or overwrites) one roster entry's `agePublicKey` — the sync-time record of which sops recipient a handle maps to, so `membersRemove` can find it later without a `--age-public-key` argument. */
function recordRosterKey(seams: MembersSeams, slug: string, handle: string, agePublicKey: string): void {
  const existing = readRoster(seams, slug);
  const updated = existing.some((m) => m.username === handle)
    ? existing.map((m) => (m.username === handle ? { ...m, agePublicKey } : m))
    : [...existing, { username: handle, agePublicKey }];
  seams.writeSetting("board.members", updated, "team", { team: slug });
}

export interface MembersSeams {
  /** The ONE team's own store, unmixed with the resolver's multi-team overlay — mirrors invite.ts's own `readTeamStore` for the same reason: a roster read/write must target the team it's about, not the union of every locally-cloned team. */
  readTeamStore: (slug: string) => Record<string, unknown>;
  writeSetting: typeof setSetting;
  revokeRead: typeof revokeRead;
  warn: (message: string) => void;
}

function defaultReadTeamStore(slug: string): Record<string, unknown> {
  return readStore(teamSettingsPath(slug)).global;
}

/** stderr only, so a `--json` command's stdout envelope stays uncorrupted. */
function defaultWarn(message: string): void {
  console.error(message);
}

export function realMembersSeams(): MembersSeams {
  return { readTeamStore: defaultReadTeamStore, writeSetting: setSetting, revokeRead, warn: defaultWarn };
}

function teamRemote(p: Probes, slug: string): string | null {
  const raw = p.readFile(`${p.home}/.mattstack/teams/${slug}/.git/config`);
  return raw !== null ? parseOriginUrl(raw) : null;
}

export interface MembersSyncResult {
  added: string[];
  pending: string[];
  reencrypted: string[];
}

/**
 * Ensures the owner's own key is a recipient (a fresh team has zero
 * recipients until this runs), then walks every outstanding invite record:
 * a posted reply becomes a sops recipient and a roster entry; no reply yet
 * leaves the record in place and reports the handle as pending.
 */
export async function membersSync(
  p: Probes,
  relay: RelayClient,
  secrets: SecretsSeams,
  slug: string,
  seams: MembersSeams = realMembersSeams(),
): Promise<MembersSyncResult> {
  const added: string[] = [];
  const pending: string[] = [];
  const reencrypted = new Set<string>();

  const { publicKey: ownerPublicKey } = await ensureAgeKey(secrets.ageKeySeam);
  const ownerResult = await addTeamRecipient(slug, ownerPublicKey, secrets);
  for (const f of ownerResult.reencrypted) reencrypted.add(f);

  const records = readInviteRecords(p, slug);
  for (const [handle, rec] of Object.entries(records)) {
    const reply = await relay.readReply(rec.id, rec.creatorSecret);
    if (reply === "none") {
      pending.push(handle);
      continue;
    }

    let agePublicKey: string;
    try {
      const opened = await openReply(reply.blob, base64ToKey(rec.keyB64), rec.id);
      if (!isValidAgePublicKey(opened.agePublicKey)) {
        throw new Error("reply's age public key is not a recognizable age1 recipient");
      }
      agePublicKey = opened.agePublicKey;
    } catch (err) {
      seams.warn(
        `rt team members sync: the reply for "${handle}" could not be used (${err instanceof Error ? err.message : String(err)}) — leaving the invite in place to retry`,
      );
      pending.push(handle);
      continue;
    }

    const result = await addTeamRecipient(slug, agePublicKey, secrets);
    for (const f of result.reencrypted) reencrypted.add(f);

    recordRosterKey(seams, slug, handle, agePublicKey);
    removeInviteRecord(p, slug, handle);
    added.push(agePublicKey);
  }

  return { added, pending, reencrypted: [...reencrypted].sort() };
}

export interface MembersRemoveResult {
  forgeAccess: RevokeAccess;
  manualSteps: string[];
  reencrypted: string[];
  rosterRemoved: boolean;
  residueNote: string;
}

const RESIDUE_NOTE =
  "Removed members keep any secrets they already decrypted; rotate the values themselves with `rt secrets rotate --team <slug> <domain> <key>`.";

/**
 * Revokes forge read access, drops the roster entry, and re-encrypts every
 * domain file without the member's key. `agePublicKey` is optional because
 * `membersSync` already recorded it on the roster entry — passing it
 * explicitly only matters for a member who was removed before ever syncing.
 */
export async function membersRemove(
  p: Probes,
  secrets: SecretsSeams,
  slug: string,
  handle: string,
  agePublicKey?: string,
  seams: MembersSeams = realMembersSeams(),
): Promise<MembersRemoveResult> {
  const remote = teamRemote(p, slug);
  const revoke = remote !== null ? await seams.revokeRead(p, remote, handle) : { access: "skipped" as RevokeAccess, manualSteps: [] as string[] };

  const existing = readRoster(seams, slug);
  const existingEntry = existing.find((m) => m.username === handle);
  const rosterRemoved = existingEntry !== undefined;
  if (rosterRemoved) {
    seams.writeSetting(
      "board.members",
      existing.filter((m) => m.username !== handle),
      "team",
      { team: slug },
    );
  }

  const keyToRemove = agePublicKey ?? (typeof existingEntry?.agePublicKey === "string" ? existingEntry.agePublicKey : undefined);
  let reencrypted: string[] = [];
  if (keyToRemove) {
    const result = await removeTeamRecipient(slug, keyToRemove, secrets);
    reencrypted = result.reencrypted;
  }

  return {
    forgeAccess: revoke.access,
    manualSteps: revoke.manualSteps,
    reencrypted,
    rosterRemoved,
    residueNote: RESIDUE_NOTE,
  };
}
