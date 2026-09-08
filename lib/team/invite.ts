/**
 * `rt team invite` — mints an opaque relay invite for a handle: pointer
 * (team/name/remote/owner/forge) sealed under a fresh key and a
 * client-generated id, stored on the relay as ciphertext only, and handed
 * back as a short paste-able code.
 *
 * It does NOT grant the invitee access to the team's repo. Membership is a
 * precondition administered by whoever owns that repo (MAT-387); rt touches it
 * only when the operator has explicitly granted `rtMayManageMembership` for
 * this team, which defaults to off.
 */

import { teamSettingsPath } from "../rt-paths.ts";
import { readStore } from "../settings/stores.ts";
import { UserActionableError } from "../setup/errors.ts";
import type { InvitePointer } from "../setup/intent.ts";
import type { Probes } from "../setup/probes.ts";
import { forgeFromRemote, readTeamSnapshot, type SettingsReader } from "../setup/team-settings.ts";
import { getSetting } from "../settings/resolve.ts";
import { setSetting } from "../settings/write.ts";
import { forgeLogin, grantRead, type ForgeAccess } from "./forge.ts";
import { storedForgeToken } from "./stored-forge-token.ts";
import { readTeamLocal } from "./team-local.ts";
import { encodeCode, generateId, generateKey, seal } from "./invite-crypto.ts";
import { readInviteRecords, upsertInviteRecord } from "./invite-records.ts";
import type { RelayClient } from "./relay-client.ts";

export const INVITE_TTL_DAYS = 7;

/** Forge usernames only (letters, digits, `.`, `_`, `-`; must start alphanumeric) — this handle also becomes a `board.members` entry and a mint-record key, so it is checked before anything downstream trusts it. */
const HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;

export const DEFAULT_JOIN_BASE_URL = "https://mattstack.dev/join";

/** Mirrors DEFAULT_INVITE_RELAY_URL/RT_INVITE_RELAY_URL in relay-client.ts: same class of value, read only by rt, and the VM harness needs to point it elsewhere without a team store. */
export function joinLinkBase(env: Record<string, string | undefined>): string {
  return env.RT_JOIN_BASE_URL || DEFAULT_JOIN_BASE_URL;
}

/** The code lives in the fragment, so it never reaches the page's server. */
export function joinLink(base: string, code: string): string {
  return `${base}#${code}`;
}

export function pasteBlock(code: string, opts: { link: string; teamName: string; downloadUrl?: string }): string {
  const downloadUrl = opts.downloadUrl ?? "https://github.com/m4ttstack/rt/releases/latest";
  return [
    `You have been invited to the ${opts.teamName} mattstack team.`,
    "",
    `  ${opts.link}`,
    "",
    "That page installs mattstack and hands the invite to the app.",
    `Already have mattstack? Open mattstack://join/${code}, or paste this code`,
    "into Setup -> Join a team:",
    "",
    code,
    "",
    `Download by hand: ${downloadUrl}`,
  ].join("\n");
}

export interface InviteResult {
  code: string;
  link: string;
  expiresAt: string;
  pasteBlock: string;
  forgeAccess: ForgeAccess;
  manualSteps: string[];
}

export interface MintInviteOpts {
  slug: string;
  handle: string;
  now: Date;
}

export interface MintInviteSeams {
  read: SettingsReader;
  /** The ONE team's own store, unmixed with the resolver's multi-team overlay — `addToRoster` must read-modify-write the team it is about to push a value into, not the union of every locally-cloned team's roster. */
  readTeamStore: (slug: string) => Record<string, unknown>;
  writeSetting: typeof setSetting;
  grantRead: typeof grantRead;
  /** Local, per-machine team record — carries the membership permission. Seamed so a test can grant it without writing to a real home. */
  readTeamLocal: typeof readTeamLocal;
  forgeLogin: typeof forgeLogin;
  /** The forge token rt holds for the team remote's host, or null. */
  forgeToken: typeof storedForgeToken;
  warn: (message: string) => void;
}

/** Degrades to `undefined` on a resolver-layer throw rather than taking the mint down with it — mirrors team-settings.ts's own default reader. */
function defaultRead(): SettingsReader {
  return <T>(key: string): T | undefined => {
    try {
      return getSetting<T>(key).value;
    } catch {
      return undefined;
    }
  };
}

function defaultReadTeamStore(slug: string): Record<string, unknown> {
  return readStore(teamSettingsPath(slug)).global;
}

/** stderr only, so a `--json` command's stdout envelope stays uncorrupted — mirrors team-settings.ts's own default warn. */
function defaultWarn(message: string): void {
  console.error(message);
}

export function realMintInviteSeams(): MintInviteSeams {
  return { read: defaultRead(), readTeamStore: defaultReadTeamStore, writeSetting: setSetting, grantRead, readTeamLocal, forgeLogin, forgeToken: storedForgeToken, warn: defaultWarn };
}

interface BoardMember {
  username: string;
  [key: string]: unknown;
}

/** Both roster keys, each judged on its own contents: board.members is the board's own list, mattstack.roster the cross-app successor, and a store can legitimately carry one without the other. */
function addToRoster(seams: MintInviteSeams, slug: string, handle: string): void {
  const store = seams.readTeamStore(slug);
  for (const key of ["board.members", "mattstack.roster"] as const) {
    const existing = Array.isArray(store[key]) ? (store[key] as BoardMember[]) : [];
    if (existing.some((m) => m.username === handle)) continue;
    seams.writeSetting(key, [...existing, { username: handle }], "team", { team: slug });
  }
}

function assertValidHandle(handle: string): void {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new UserActionableError(
      "invalid-handle",
      `"${handle}" doesn't look like a forge username — letters, digits, ".", "_", "-" only, starting with a letter or digit`,
    );
  }
}

export async function mintInvite(p: Probes, relay: RelayClient, opts: MintInviteOpts, seams: MintInviteSeams = realMintInviteSeams()): Promise<InviteResult> {
  assertValidHandle(opts.handle);

  const snapshot = readTeamSnapshot(p, opts.slug, { read: seams.read, warn: seams.warn });
  if (!snapshot.remote) {
    throw new UserActionableError("no-team-remote", `team "${opts.slug}" has no git remote configured yet — run \`rt team create\` or \`rt team publish\` first`);
  }
  const remote = snapshot.remote;
  const forge = snapshot.integrations.forge ?? forgeFromRemote(remote) ?? undefined;
  const token = await seams.forgeToken(p, remote);
  const owner = (forge ? await seams.forgeLogin(p, forge.provider, forge.host, token) : null) ?? p.env.USER ?? "unknown";

  const title = seams.read<string>("board.title");
  const pointer: InvitePointer = {
    v: 1,
    team: opts.slug,
    name: title && title.length > 0 ? title : opts.slug,
    remote,
    owner,
    forge: forge?.host ?? "",
    createdAt: opts.now.toISOString(),
  };

  // Captured before this handle's new record is minted — replace-on-mint's revoke of THIS value runs last, after the new invite is safely live (finding: create-before-destroy).
  const priorRecord = readInviteRecords(p, opts.slug)[opts.handle];

  const key = generateKey();
  const idHex = generateId();
  const ciphertext = await seal(pointer, key, idHex);
  const expiresAt = new Date(opts.now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const created = await relay.create(ciphertext, expiresAt, idHex);
  if (created.id !== idHex) {
    throw new UserActionableError("relay-id-mismatch", "the invite relay did not honor the requested invite id — this invite cannot be safely opened");
  }

  const code = encodeCode(created.id, key);

  // The record is the ONLY copy of creatorSecret (revoke capability) and keyB64 (reply-read capability) — persist it before anything else fallible runs, and if the write itself fails, name the id/code so the invite is still recoverable by hand.
  try {
    upsertInviteRecord(p, opts.slug, opts.handle, {
      id: created.id,
      creatorSecret: created.creatorSecret,
      keyB64: Buffer.from(key).toString("base64"),
      expiresAt,
    });
  } catch (err) {
    throw new UserActionableError(
      "invite-record-write-failed",
      `minted invite ${created.id} (code ${code}) but could not save its local record, so it cannot be revoked or synced automatically — write the code down now: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Repo membership is a precondition, not something rt provisions (MAT-387):
  // you are added to a repo by whoever administers it, before mattstack is in
  // the picture. rt only reaches for the forge when the operator has explicitly
  // asked it to manage membership on THIS team — a permission that defaults to
  // off and is never derivable from the remote URL, which cannot distinguish a
  // repo rt created from an employer's.
  const { access: forgeAccess, manualSteps } = seams.readTeamLocal(p, opts.slug).rtMayManageMembership
    ? await seams.grantRead(p, remote, opts.handle, token)
    : { access: "skipped" as ForgeAccess, manualSteps: [`Ask whoever administers ${remote} to give ${opts.handle} read access — mattstack does not manage membership on this repo`] };

  addToRoster(seams, opts.slug, opts.handle);

  if (priorRecord) {
    try {
      await relay.delete(priorRecord.id, priorRecord.creatorSecret);
    } catch (err) {
      seams.warn(
        `rt team invite: minted a new invite for "${opts.handle}", but could not revoke the previous one (id ${priorRecord.id}) — ${err instanceof Error ? err.message : String(err)}; it will simply expire on its own.`,
      );
    }
  }

  const link = joinLink(joinLinkBase(p.env), code);
  return { code, link, expiresAt, pasteBlock: pasteBlock(code, { link, teamName: pointer.name }), forgeAccess, manualSteps };
}
