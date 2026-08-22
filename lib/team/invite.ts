/**
 * `rt team invite` — mints an opaque relay invite for a handle: pointer
 * (team/name/remote/owner/forge) sealed under a fresh key and a
 * client-generated id, stored on the relay as ciphertext only, and handed
 * back as a short paste-able code. Also grants forge read access at mint
 * time so the invitee can clone the moment they redeem.
 */

import { UserActionableError } from "../setup/errors.ts";
import type { InvitePointer } from "../setup/intent.ts";
import type { Probes } from "../setup/probes.ts";
import { readTeamSnapshot, type SettingsReader } from "../setup/team-settings.ts";
import { getSetting } from "../settings/resolve.ts";
import { setSetting } from "../settings/write.ts";
import { forgeLogin, grantRead, type ForgeAccess } from "./forge.ts";
import { encodeCode, generateKey, seal, INVITE_ID_BYTES } from "./invite-crypto.ts";
import { readInviteRecords, upsertInviteRecord } from "./invite-records.ts";
import type { RelayClient } from "./relay-client.ts";

export const INVITE_TTL_DAYS = 7;

export function pasteBlock(code: string, downloadUrl = "https://github.com/m4ttstack/rt/releases/latest"): string {
  return `Install mattstack from ${downloadUrl}, then open mattstack://join/${code} or paste the code into Setup → Join a team.\n\nInvite code:\n${code}`;
}

export interface InviteResult {
  code: string;
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
  writeSetting: typeof setSetting;
  grantRead: typeof grantRead;
  forgeLogin: typeof forgeLogin;
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

export function realMintInviteSeams(): MintInviteSeams {
  return { read: defaultRead(), writeSetting: setSetting, grantRead, forgeLogin };
}

function generateIdHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_ID_BYTES));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface BoardMember {
  username: string;
  [key: string]: unknown;
}

function addToRoster(seams: MintInviteSeams, slug: string, handle: string): void {
  const existing = seams.read<BoardMember[]>("board.members") ?? [];
  if (existing.some((m) => m.username === handle)) return;
  seams.writeSetting("board.members", [...existing, { username: handle }], "team", { team: slug });
}

export async function mintInvite(p: Probes, relay: RelayClient, opts: MintInviteOpts, seams: MintInviteSeams = realMintInviteSeams()): Promise<InviteResult> {
  const snapshot = readTeamSnapshot(p, opts.slug, { read: seams.read, warn: () => {} });
  if (!snapshot.remote) {
    throw new UserActionableError("no-team-remote", `team "${opts.slug}" has no git remote configured yet — run \`rt team create\` or \`rt team publish\` first`);
  }
  const remote = snapshot.remote;
  const forge = snapshot.integrations.forge;
  const owner = (forge ? await seams.forgeLogin(p, forge.provider, forge.host) : null) ?? p.env.USER ?? "unknown";

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

  const records = readInviteRecords(p, opts.slug);
  const existing = records[opts.handle];
  if (existing) {
    await relay.delete(existing.id, existing.creatorSecret);
  }

  const key = generateKey();
  const idHex = generateIdHex();
  const ciphertext = await seal(pointer, key, idHex);
  const expiresAt = new Date(opts.now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const created = await relay.create(ciphertext, expiresAt, idHex);
  if (created.id !== idHex) {
    throw new UserActionableError("relay-id-mismatch", "the invite relay did not honor the requested invite id — this invite cannot be safely opened");
  }

  const { access: forgeAccess, manualSteps } = await seams.grantRead(p, remote, opts.handle);

  addToRoster(seams, opts.slug, opts.handle);

  upsertInviteRecord(p, opts.slug, opts.handle, {
    id: created.id,
    creatorSecret: created.creatorSecret,
    keyB64: Buffer.from(key).toString("base64"),
    expiresAt,
  });

  const code = encodeCode(created.id, key);
  return { code, expiresAt, pasteBlock: pasteBlock(code), forgeAccess, manualSteps };
}
