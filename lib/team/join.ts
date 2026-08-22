/**
 * `rt team join` — the joiner side of `rt team invite`: turns a pasted code
 * into a working team clone. `joinDryRun` only validates (decodes the code,
 * opens the sealed pointer, probes forge access) and persists a resumable
 * intent; `joinRedeem` does the real work (clone, redeem the invite,
 * attempt switchboard peering, post a reply blob carrying the joiner's age
 * key back to the inviter).
 *
 * `access`/`peering` are report fields, not exceptions: a denied or
 * unreachable outcome is a normal, successful call (exit 0) — only a code
 * that can never be redeemed (malformed, or the relay has no record of it)
 * throws, since that's the one case with nothing left to retry.
 */

import { join } from "path";
import { type AgeKeySeam, createRealAgeKeySeam, ensureAgeKey } from "../home/age-key.ts";
import type { SecretsSeams } from "../secrets/store.ts";
import { createRealTeamSecretsSeams, readTeamSecret } from "../secrets/team-store.ts";
import { UserActionableError } from "../setup/errors.ts";
import { clearIntent, readIntent, writeIntent, type InvitePointer } from "../setup/intent.ts";
import type { ExecResult, Probes } from "../setup/probes.ts";
import { forgeFromRemote, parseOriginUrl, readTeamSnapshot, stripUserinfo, type SettingsReader } from "../setup/team-settings.ts";
import { getSetting } from "../settings/resolve.ts";
import { forgeLogin } from "./forge.ts";
import { decodeCode, open, sealReply } from "./invite-crypto.ts";
import { AUTH_FAILURE_PATTERN } from "./publish.ts";
import type { RelayClient } from "./relay-client.ts";

export interface JoinResult {
  team: { slug: string; name: string; owner: string };
  access: "ok" | "denied" | "unreachable";
  peering: "applied" | "idle" | "unavailable";
  message: string;
}

const NO_TEAM: JoinResult["team"] = { slug: "", name: "", owner: "" };

function inviteUnknownError(message = "invite not recognized or expired: ask the team owner for a new one"): UserActionableError {
  return new UserActionableError("invite-unknown", message);
}

function teamRefFrom(pointer: InvitePointer): JoinResult["team"] {
  return { slug: pointer.team, name: pointer.name, owner: pointer.owner };
}

function deniedResult(pointer: InvitePointer): JoinResult {
  return {
    team: teamRefFrom(pointer),
    access: "denied",
    peering: "idle",
    message: `you don't have access yet: ask ${pointer.owner} to grant you access to ${pointer.name}`,
  };
}

function unreachableResult(team: JoinResult["team"], message: string): JoinResult {
  return { team, access: "unreachable", peering: "idle", message };
}

/**
 * A "gone" invite and an undecodable blob (wrong key, tampered ciphertext)
 * look identical from the joiner's side — both mean this code no longer
 * opens anything — so both collapse to the same invite-unknown error.
 * Returns null (not a throw) for a relay CONNECTIVITY failure, which is a
 * retryable, exit-0 outcome rather than a dead code.
 */
async function fetchPointer(relay: RelayClient, idHex: string, key: Uint8Array): Promise<InvitePointer | null> {
  let ciphertext: string;
  try {
    const fetched = await relay.fetch(idHex);
    if (fetched === "gone") throw inviteUnknownError();
    ciphertext = fetched.ciphertext;
  } catch (err) {
    if (err instanceof UserActionableError && err.code === "invite-unknown") throw err;
    return null;
  }
  try {
    return await open(ciphertext, key, idHex);
  } catch {
    throw inviteUnknownError();
  }
}

function classifyGitAccessFailure(result: ExecResult): "denied" | "unreachable" {
  return AUTH_FAILURE_PATTERN.test(`${result.stdout}\n${result.stderr}`) ? "denied" : "unreachable";
}

export async function joinDryRun(p: Probes, relay: RelayClient, code: string): Promise<JoinResult> {
  const { idHex, key } = decodeCode(code);

  const pointer = await fetchPointer(relay, idHex, key);
  if (pointer === null) {
    return unreachableResult(NO_TEAM, "could not reach the invite relay — check your network and try again");
  }

  // --exit-code turns "repo reachable but HEAD doesn't resolve" (a brand new,
  // still-empty team repo) into exit 2, not a failure — both 0 and 2 mean the
  // joiner can read the repo.
  const lsRemote = await p.exec(["git", "ls-remote", "--exit-code", pointer.remote, "HEAD"], { env: { GIT_TERMINAL_PROMPT: "0" } });
  if (lsRemote.code !== 0 && lsRemote.code !== 2) {
    const kind = classifyGitAccessFailure(lsRemote);
    return kind === "denied"
      ? deniedResult(pointer)
      : unreachableResult(teamRefFrom(pointer), `could not reach ${stripUserinfo(pointer.remote)} — check your network and try again`);
  }

  writeIntent(p, { v: 1, at: p.now().toISOString(), mode: "join", join: { id: idHex, keyB64: Buffer.from(key).toString("base64"), pointer } });
  return { team: teamRefFrom(pointer), access: "ok", peering: "idle", message: `Joining ${pointer.name} (owner ${pointer.owner})` };
}

export interface JoinRedeemOpts {
  code?: string;
  /** Only the apply pipeline's own `team.join` step passes this — the interactive CLI form clears the intent itself once this call returns. */
  fromApply?: boolean;
}

export type SecretsSeamsFactory = (slug: string) => SecretsSeams;

export interface JoinRedeemSeams {
  ageKeySeam: AgeKeySeam;
  read: SettingsReader;
  readTeamSecret: typeof readTeamSecret;
  forgeLogin: typeof forgeLogin;
  warn: (message: string) => void;
}

/** Degrades to `undefined` on a resolver-layer throw rather than taking the redeem down with it — mirrors invite.ts's own default reader. */
function defaultRead(): SettingsReader {
  return <T>(key: string): T | undefined => {
    try {
      return getSetting<T>(key).value;
    } catch {
      return undefined;
    }
  };
}

function defaultWarn(message: string): void {
  console.error(message);
}

export function realJoinRedeemSeams(): JoinRedeemSeams {
  return { ageKeySeam: createRealAgeKeySeam(), read: defaultRead(), readTeamSecret, forgeLogin, warn: defaultWarn };
}

interface JoinSource {
  idHex: string;
  key: Uint8Array;
  pointer: InvitePointer;
}

function base64ToKey(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function isJoinSource(v: JoinSource | JoinResult): v is JoinSource {
  return "idHex" in v;
}

async function resolveSource(p: Probes, relay: RelayClient, code: string | undefined): Promise<JoinSource | JoinResult> {
  if (code) {
    const { idHex, key } = decodeCode(code);
    const pointer = await fetchPointer(relay, idHex, key);
    if (pointer === null) return unreachableResult(NO_TEAM, "could not reach the invite relay — check your network and try again");
    return { idHex, key, pointer };
  }

  const intent = readIntent(p);
  if (intent?.mode !== "join" || !intent.join) {
    throw new UserActionableError("no-join-intent", "no invite in progress — pass a code, or run `rt team join --dry-run` first to save one");
  }
  return { idHex: intent.join.id, key: base64ToKey(intent.join.keyB64), pointer: intent.join.pointer };
}

function readOrigin(p: Probes, dir: string): string | null {
  const raw = p.readFile(join(dir, ".git", "config"));
  return raw !== null ? parseOriginUrl(raw) : null;
}

export async function joinRedeem(
  p: Probes,
  relay: RelayClient,
  secrets: SecretsSeamsFactory,
  opts: JoinRedeemOpts,
  seams: JoinRedeemSeams = realJoinRedeemSeams(),
): Promise<JoinResult> {
  const resolved = await resolveSource(p, relay, opts.code);
  if (!isJoinSource(resolved)) return resolved;
  const { idHex, key, pointer } = resolved;

  const dir = join(p.home, ".mattstack", "teams", pointer.team);
  const existingOrigin = p.exists(dir) ? readOrigin(p, dir) : null;
  let alreadyCloned = false;

  if (existingOrigin !== null) {
    if (stripUserinfo(existingOrigin) !== stripUserinfo(pointer.remote)) {
      throw new UserActionableError(
        "team-remote-mismatch",
        `"${pointer.team}" is already cloned at ${dir} with a different remote — remove it to rejoin, or resolve by hand`,
      );
    }
    alreadyCloned = true;
  } else {
    p.mkdirp(join(p.home, ".mattstack", "teams"));
    const clone = await p.exec(["git", "clone", pointer.remote, dir], { env: { GIT_TERMINAL_PROMPT: "0" } });
    if (clone.code !== 0) {
      const kind = classifyGitAccessFailure(clone);
      return kind === "denied"
        ? deniedResult(pointer)
        : unreachableResult(teamRefFrom(pointer), `could not reach ${stripUserinfo(pointer.remote)} — check your network and try again`);
    }
  }

  const redeemed = await relay.redeem(idHex);
  // A resumed run whose clone already landed already won the redeem race on
  // a prior attempt — "already" here is the crash-recovery signal, not a
  // real conflict, so only a FRESH clone treats it as one.
  if (redeemed === "already" && !alreadyCloned) {
    throw inviteUnknownError(`this invite was already used: ask ${pointer.owner} for a new one`);
  }

  const snapshot = readTeamSnapshot(p, pointer.team, { read: seams.read, warn: seams.warn });
  const forge = snapshot.integrations.forge ?? forgeFromRemote(pointer.remote) ?? undefined;
  const handle = (forge ? await seams.forgeLogin(p, forge.provider, forge.host) : null) ?? p.env.USER ?? "unknown";

  let peering: JoinResult["peering"] = "idle";
  const switchboardUrl = snapshot.integrations.switchboard?.url;
  if (switchboardUrl) {
    const adminToken = await seams.readTeamSecret(pointer.team, "rt", "switchboardAdminToken", secrets(pointer.team));
    if (adminToken) {
      const res = await p.fetch(`${switchboardUrl}/peer/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ member: handle }),
      });
      peering = res.status >= 200 && res.status < 300 ? "applied" : "unavailable";
    }
  }

  const { publicKey } = await ensureAgeKey(seams.ageKeySeam);
  const blob = await sealReply({ v: 1, agePublicKey: publicKey, handle }, key, idHex);
  await relay.reply(idHex, blob);

  if (opts.fromApply) clearIntent(p);

  return { team: teamRefFrom(pointer), access: "ok", peering, message: `Joined ${pointer.name} (owner ${pointer.owner})` };
}
