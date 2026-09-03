/**
 * `rt team members sync|remove` — the owner side of the invite loop: sync
 * turns each outstanding invite record with a posted reply into a sops
 * recipient and a roster entry; remove drops the roster entry and re-encrypts
 * every domain file without that member's key. It revokes forge access only
 * when this machine holds `rtMayManageMembership` for the team (MAT-387);
 * otherwise it says so, because removal fails OPEN.
 *
 * Every reply blob crossing `relay.readReply` is attacker-controlled (the
 * relay itself, or anyone who intercepted the invite code, could have
 * posted it) — `openReply` only proves the blob decrypted under THIS
 * invite's key/AAD, not that its `agePublicKey` is actually a usable age
 * recipient, and not that it is a NEW recipient rather than an echo of one
 * that already exists. `.sops.yaml` is committed to the team repo and an
 * invitee necessarily has forge read before they can redeem at all (whoever
 * administers the repo granted it; since MAT-387 that is no longer rt), so the
 * owner's own public key is readable by any invitee before they ever reply — a reply that echoes an
 * existing recipient's key back is checked for and refused (first-claim-wins:
 * a key belongs to exactly one handle), and `membersRemove` separately
 * refuses outright to remove whatever key this machine's own age identity
 * resolves to (read-only — never minted for this check; a machine with no
 * key yet cannot be removing its own), regardless of which roster entry it
 * was filed under. Either guard alone closes the owner-lockout path; both
 * are kept so one is never load-bearing for the other.
 */

import { ensureAgeKey, readAgeKey } from "../home/age-key.ts";
import { teamSettingsPath } from "../rt-paths.ts";
import type { SecretsSeams } from "../secrets/store.ts";
import { addTeamRecipient, readTeamRecipients, removeTeamRecipient } from "../secrets/team-store.ts";
import { readStore } from "../settings/stores.ts";
import { setSetting } from "../settings/write.ts";
import { UserActionableError } from "../setup/errors.ts";
import type { Probes } from "../setup/probes.ts";
import { parseOriginUrl } from "../setup/team-settings.ts";
import { revokeRead, type RevokeAccess } from "./forge.ts";
import { storedForgeToken } from "./stored-forge-token.ts";
import { readTeamLocal } from "./team-local.ts";
import { openReply } from "./invite-crypto.ts";
import { readInviteRecords, removeInviteRecord } from "./invite-records.ts";
import type { RelayClient } from "./relay-client.ts";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const AGE_HRP = "age";
// A real age X25519 recipient is HRP "age" + a fixed 32-byte payload, bech32-encoded
// as 52 five-bit data groups plus a 6-character checksum — always exactly 58
// characters after "age1", never fewer or more.
const AGE_DATA_CHARS = 58;

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const lead = [...hrp].map((c) => c.charCodeAt(0) >>> 5);
  const tail = [...hrp].map((c) => c.charCodeAt(0) & 31);
  return [...lead, 0, ...tail];
}

/**
 * Real bech32 (BIP-173) validation — not a charset/length sniff. Rejects
 * mixed case, decodes every data character against the bech32 charset, pins
 * the exact length a real age recipient always has, verifies the
 * 6-character checksum against the "age" HRP, AND checks BIP-173's
 * non-zero-padding rule: the payload is a 32-byte (256-bit) key packed into
 * 52 five-bit groups (260 bits), so the final payload group's low 4 bits
 * carry no real data and `age-keygen` always zeros them — a forged key can
 * carry a valid checksum over a DIRTY final group, which real `age` rejects
 * ("non-zero padding") but a checksum-only check would happily accept. A
 * charset-valid, length-valid, checksum-valid string that fails either of
 * these two structural checks was never produced by `age-keygen` and is
 * rejected here, before it can ever reach `addTeamRecipient`/`.sops.yaml` —
 * the fresh-team path has no other gate, since `reencryptTeamSecrets` is a
 * no-op with zero domain files.
 */
function isValidAgePublicKey(key: string): boolean {
  if (key.length !== AGE_HRP.length + 1 + AGE_DATA_CHARS) return false;
  if (key !== key.toLowerCase()) return false;
  if (!key.startsWith(`${AGE_HRP}1`)) return false;

  const dataPart = key.slice(AGE_HRP.length + 1);
  const values: number[] = [];
  for (const ch of dataPart) {
    const idx = BECH32_CHARSET.indexOf(ch);
    if (idx === -1) return false;
    values.push(idx);
  }

  // 58 data characters = 52 payload groups + 6 checksum groups; the last
  // payload group is index length-7 (58-7 = 51, the 52nd and final payload
  // group before the checksum begins).
  if ((values[values.length - 7]! & 0b1111) !== 0) return false;

  return bech32Polymod([...bech32HrpExpand(AGE_HRP), ...values]) === 1;
}

function base64ToKey(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * The read-only half of `ensureAgeKey`'s "key already exists" branch —
 * derives this machine's own public key from whatever private key is
 * already in the keychain, WITHOUT ever minting one. `membersRemove`'s
 * own-key guard must never provision a keychain item as a side effect of a
 * removal: a machine with no key yet cannot possibly be the one removing
 * its own key, so `null` here means "skip the comparison," not "go mint one
 * and compare against that."
 */
async function readOwnPublicKeyIfPresent(secrets: SecretsSeams): Promise<string | null> {
  const existing = await readAgeKey(secrets.ageKeySeam);
  if (!("key" in existing)) return null;
  const derived = await secrets.ageKeySeam.run(["age-keygen", "-y"], { input: existing.key, sensitive: true });
  if (derived.code !== 0) {
    throw new Error(`age-keygen -y: could not derive the public key from the stored private key\n${derived.stderr}`);
  }
  return derived.stdout.trim();
}

interface RosterMember {
  username: string;
  agePublicKey?: string;
  [key: string]: unknown;
}

/** The two roster keys a membership change touches: board.members is the board's own list, mattstack.roster the cross-app successor, mirroring invite.ts's addToRoster. */
const ROSTER_KEYS = ["board.members", "mattstack.roster"] as const;
type RosterKey = (typeof ROSTER_KEYS)[number];

function readRoster(seams: MembersSeams, slug: string, key: RosterKey = "board.members"): RosterMember[] {
  const store = seams.readTeamStore(slug);
  return Array.isArray(store[key]) ? (store[key] as RosterMember[]) : [];
}

/** Sets (or overwrites) one roster entry's `agePublicKey` on both roster keys: the sync-time record of which sops recipient a handle maps to, so `membersRemove` can find it later without a `--key` argument. Each key is read and written on its own contents, matching `addToRoster` in invite.ts. */
function recordRosterKey(seams: MembersSeams, slug: string, handle: string, agePublicKey: string): void {
  for (const key of ROSTER_KEYS) {
    const existing = readRoster(seams, slug, key);
    const updated = existing.some((m) => m.username === handle)
      ? existing.map((m) => (m.username === handle ? { ...m, agePublicKey } : m))
      : [...existing, { username: handle, agePublicKey }];
    seams.writeSetting(key, updated, "team", { team: slug });
  }
}

export interface MembersSeams {
  /** The ONE team's own store, unmixed with the resolver's multi-team overlay — mirrors invite.ts's own `readTeamStore` for the same reason: a roster read/write must target the team it's about, not the union of every locally-cloned team. */
  readTeamStore: (slug: string) => Record<string, unknown>;
  writeSetting: typeof setSetting;
  revokeRead: typeof revokeRead;
  /** Local, per-machine team record — carries the membership permission. Seamed like invite.ts's, so a test grants it explicitly rather than by writing a real home. */
  readTeamLocal: typeof readTeamLocal;
  /** The forge token rt holds for the team remote's host, or null. */
  forgeToken: typeof storedForgeToken;
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
  return { readTeamStore: defaultReadTeamStore, writeSetting: setSetting, revokeRead, readTeamLocal, forgeToken: storedForgeToken, warn: defaultWarn };
}

export function teamRemote(p: Probes, slug: string): string | null {
  const raw = p.readFile(`${p.home}/.mattstack/teams/${slug}/.git/config`);
  return raw !== null ? parseOriginUrl(raw) : null;
}

export interface MembersSyncResult {
  added: string[];
  pending: string[];
  reencrypted: string[];
}

/**
 * Thrown when an infrastructure failure (a re-encryption rollback, a
 * keychain error) aborts a sync partway through. `added`/`pending` are
 * exactly what the caller would have received had the sync succeeded up to
 * this point — `.sops.yaml` itself is already consistent (every completed
 * add's rollback already ran inside `addTeamRecipient`); this error only
 * carries forward what a bare rethrow would otherwise lose from the report.
 */
export class MembersSyncAbortedError extends Error {
  constructor(
    public readonly added: string[],
    public readonly pending: string[],
    causeMessage: string,
  ) {
    super(
      `rt team members sync: aborted after adding ${added.length} key(s)${added.length ? ` (${added.join(", ")})` : ""}` +
        `${pending.length ? `, ${pending.length} still pending (${pending.join(", ")})` : ""} — ${causeMessage}`,
    );
  }
}

/**
 * Ensures the owner's own key is a recipient (a fresh team has zero
 * recipients until this runs), then walks every outstanding invite record: a
 * posted reply becomes a sops recipient and a roster entry; no reply yet, a
 * malformed/undecryptable reply, or a reply echoing a key that is ALREADY a
 * recipient (first-claim-wins — see the module doc) all leave the handle
 * pending with the invite record retained for a retry. A hostile/malformed
 * reply is deliberately never fatal to the whole sync (the relay's reply
 * endpoint is unauthenticated, so one poisoned blob must not deny every
 * other honest joiner); an infrastructure failure from `addTeamRecipient`
 * itself IS fatal (throws `MembersSyncAbortedError`), since `.sops.yaml`'s
 * consistency is what's in question then, not one member's input.
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

  try {
    const { publicKey: ownerPublicKey } = await ensureAgeKey(secrets.ageKeySeam);
    const ownerResult = await addTeamRecipient(slug, ownerPublicKey, secrets);
    for (const f of ownerResult.reencrypted) reencrypted.add(f);
    if (ownerResult.added) added.push(ownerPublicKey);

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
          throw new Error("reply's age public key is not a well-formed age1 recipient (bech32 checksum failed)");
        }
        agePublicKey = opened.agePublicKey;
      } catch (err) {
        seams.warn(
          `rt team members sync: the reply for "${handle}" could not be used (${err instanceof Error ? err.message : String(err)}) — leaving the invite in place to retry`,
        );
        pending.push(handle);
        continue;
      }

      if (readTeamRecipients(slug, secrets).includes(agePublicKey)) {
        seams.warn(
          `rt team members sync: the reply for "${handle}" claims an age key that is already a recipient (a key belongs to exactly one handle) — treating as suspect and leaving the invite in place; investigate before re-syncing`,
        );
        pending.push(handle);
        continue;
      }

      const result = await addTeamRecipient(slug, agePublicKey, secrets);
      for (const f of result.reencrypted) reencrypted.add(f);
      if (!result.added) {
        // Lost a race against a concurrent sync, or the duplicate check above
        // was somehow stale — either way, nothing was actually added, so this
        // must not be reported as a success.
        seams.warn(`rt team members sync: "${handle}"'s key turned out to already be a recipient — leaving the invite in place`);
        pending.push(handle);
        continue;
      }

      recordRosterKey(seams, slug, handle, agePublicKey);
      removeInviteRecord(p, slug, handle);
      added.push(agePublicKey);
    }
  } catch (err) {
    // A usage-shaped refusal (a corrupt invite-records file, an invalid
    // slug) already carries its own exit-2 contract identity — only an
    // infrastructure failure from addTeamRecipient/ensureAgeKey gets
    // wrapped, since that's the one class this error exists to enrich.
    if (err instanceof MembersSyncAbortedError || err instanceof UserActionableError) throw err;
    throw new MembersSyncAbortedError(added, pending, err instanceof Error ? err.message : String(err));
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
 * explicitly is how a recipient with no roster entry (a hostile add, a
 * hand-edited store, a roster lost to a bad merge) can still be removed.
 *
 * Refuses outright — before revoking access or touching the roster — when
 * the key resolved for removal (explicit or roster-recorded) matches this
 * machine's OWN age key: a reply that echoed the owner's public key (the
 * exact attack the duplicate-recipient check in `membersSync` also guards
 * against) would otherwise let a routine removal strip the owner's own
 * recipient entry, and `sops updatekeys` needs that exact key to decrypt
 * before it can re-encrypt to anyone else — an unrecoverable lockout. This
 * check reads the keychain (`readOwnPublicKeyIfPresent`) but never mints:
 * a removal is not a provisioning verb, and a machine with no key yet
 * cannot be the one removing its own, so the comparison is simply skipped.
 */
export async function membersRemove(
  p: Probes,
  secrets: SecretsSeams,
  slug: string,
  handle: string,
  agePublicKey?: string,
  seams: MembersSeams = realMembersSeams(),
): Promise<MembersRemoveResult> {
  if (agePublicKey !== undefined && !isValidAgePublicKey(agePublicKey)) {
    throw new UserActionableError(
      "invalid-age-key",
      `"${agePublicKey}" is not a well-formed age1 recipient (bech32 checksum failed) — pass the exact key from \`rt team status\` or the roster`,
    );
  }

  const existing = readRoster(seams, slug);
  const existingEntry = existing.find((m) => m.username === handle);
  const keyToRemove = agePublicKey ?? (typeof existingEntry?.agePublicKey === "string" ? existingEntry.agePublicKey : undefined);

  if (keyToRemove) {
    const ownerPublicKey = await readOwnPublicKeyIfPresent(secrets);
    if (ownerPublicKey !== null && keyToRemove === ownerPublicKey) {
      throw new UserActionableError(
        "own-key-removal-refused",
        `refusing to remove "${handle}" — the key on record for them is this machine's OWN age key, so removing it would lock this operator out of every team secret. ` +
          `If "${handle}" genuinely echoed your key back in their invite reply, fix the roster by hand (it never should have been recorded as theirs) rather than removing it here.`,
      );
    }
  }

  // Mirrors the mint side (MAT-387): rt does not administer membership on a
  // repo it was merely pointed at. The asymmetry that matters is that removal
  // FAILS OPEN — the person keeps their access — so when rt is not permitted to
  // revoke, the caller is told plainly rather than in a footnote. Silence here
  // would read as "removed", and they would still be able to clone.
  const remote = teamRemote(p, slug);
  const mayManage = seams.readTeamLocal(p, slug).rtMayManageMembership;
  const revoke =
    remote !== null && mayManage
      ? await seams.revokeRead(p, remote, handle, await seams.forgeToken(p, remote))
      : {
          access: "skipped" as RevokeAccess,
          manualSteps:
            remote === null
              ? ([] as string[])
              : [`"${handle}" still has access to ${remote} — remove them there too; mattstack does not manage membership on this repo`],
        };

  const rosterRemoved = existingEntry !== undefined;
  if (rosterRemoved) {
    seams.writeSetting(
      "board.members",
      existing.filter((m) => m.username !== handle),
      "team",
      { team: slug },
    );
  }

  // mattstack.roster is judged on its own contents, independent of
  // board.members: a store can carry one roster without the other.
  const crossAppRoster = readRoster(seams, slug, "mattstack.roster");
  if (crossAppRoster.some((m) => m.username === handle)) {
    seams.writeSetting(
      "mattstack.roster",
      crossAppRoster.filter((m) => m.username !== handle),
      "team",
      { team: slug },
    );
  }

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
