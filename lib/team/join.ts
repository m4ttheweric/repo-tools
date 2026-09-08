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
 *
 * The decoded pointer is ATTACKER-CONTROLLED: anyone can POST their own
 * ciphertext to the public relay and hand a victim the resulting code, so a
 * successful decrypt only proves the blob wasn't tampered with in transit —
 * it proves nothing about the CONTENT. `validatePointer` runs immediately
 * after every `open()`/intent-read, before `team`/`remote` reach a path join
 * or a git invocation.
 */

import { join } from "path";
import { type AgeKeySeam, createRealAgeKeySeam, ensureAgeKey } from "../home/age-key.ts";
import { validateSlug } from "../secrets/store.ts";
import type { SecretsSeams } from "../secrets/store.ts";
import { readTeamSecret } from "../secrets/team-store.ts";
import { UserActionableError } from "../setup/errors.ts";
import { clearIntent, readIntent, writeIntent, type InvitePointer } from "../setup/intent.ts";
import type { ExecResult, Probes } from "../setup/probes.ts";
import { forgeFromRemote, parseOriginUrl, readTeamSnapshot, stripUserinfo, type SettingsReader } from "../setup/team-settings.ts";
import { getSetting } from "../settings/resolve.ts";
import { forgeLogin } from "./forge.ts";
import { gitWithToken } from "./git-credential.ts";
import { decodeCode, open, sealReply } from "./invite-crypto.ts";
import { AUTH_FAILURE_PATTERN } from "./publish.ts";
import { withoutUrls } from "./redact.ts";
import type { RelayClient } from "./relay-client.ts";
import { storedForgeToken } from "./stored-forge-token.ts";
import { forgeLabel, probeTeamRepoAccess, type RepoAccessVerdict } from "./repo-access.ts";
import { forgeTokenLookupReal } from "./forge-token.ts";

export interface JoinResult {
  team: { slug: string; name: string; owner: string };
  access: "ok" | "deferred" | "no-account" | "denied" | "unreachable" | "undetermined";
  peering: "applied" | "idle" | "unavailable";
  message: string;
  intent: "written" | "not-written";
}

/** Raised only after the clone and the relay redeem have already succeeded — the join is real, but the local age key could not be read. Deliberately NOT a `UserActionableError`: the CLI reports it and exits 1 (a machine/environment problem), never 2 (a dead invite). */
export class JoinKeyExchangeError extends Error {}

const NO_TEAM: JoinResult["team"] = { slug: "", name: "", owner: "" };

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_PROTOCOL_FROM_USER: "0" };

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
    intent: "written",
  };
}

function unreachableResult(team: JoinResult["team"], message: string): JoinResult {
  return { team, access: "unreachable", peering: "idle", message, intent: "written" };
}

// A real hostname/IP[:port] — starts and ends alnum, `.`/`-` in between, an
// optional port. Anchoring the CAPTURE (not just the overall pattern) to this
// charset is what keeps a `\n`/`\r`/control-char host from ever reaching a
// message built from `remote` (see gitFailureMessage's "network" case) — `.`
// in a non-dotAll regex already excludes literal newlines from the PATH
// portion, so the host class was the only gap.
const HOST = "[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?";
const USERINFO = "(?:[^@/\\s]+@)?";

/**
 * Every scp-like/URL remote form git accepts, restricted to the three
 * transports rt ever needs — deliberately excludes `ext::`, `file://`, and
 * anything else git's transport helpers understand, since the pointer this
 * validates is attacker-controlled. Whitespace is rejected outright rather
 * than special-casing flag-shaped substrings like `--upload-pack=`: `p.exec`
 * is `Bun.spawn(argv)` (no shell, no word splitting), so `remote` is always
 * ONE argv element regardless of what it contains — the only reason a
 * flag-shaped tail was ever worth naming was symmetry, so reject the whole
 * class in one rule instead of enumerating flag names.
 */
function isAllowedRemote(remote: string): boolean {
  if (remote.length === 0 || remote.startsWith("-") || /\s/.test(remote)) return false;
  if (/^ext::/i.test(remote)) return false;
  if (/^file:\/\//i.test(remote)) return false;

  if (new RegExp(`^https:\\/\\/${USERINFO}${HOST}\\/.+$`).test(remote)) return true;
  if (new RegExp(`^ssh:\\/\\/${USERINFO}${HOST}\\/.+$`).test(remote)) return true;
  // scp-like: user@host:path
  if (new RegExp(`^[A-Za-z0-9_][A-Za-z0-9_.-]*@${HOST}:.+$`).test(remote)) return true;

  return false;
}

/** Strips C0 controls and DEL — defangs an ANSI escape (which opens with ESC, 0x1b) and CR/LF line-injection from an attacker-controlled display string before it ever reaches a human-readable message. `--json` needed no such treatment (`JSON.stringify` already escapes C0), but the plain-text `rt team join: <message>` line does not. */
function sanitizeDisplay(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * The one place `team`/`remote`/`name`/`owner` are trusted enough to reach a
 * path join, a git argv, or a human-readable message — every pointer,
 * however obtained (a fresh decode or a saved intent), passes through here
 * first, and every caller uses the RETURNED pointer (name/owner sanitized),
 * never the raw one `open()`/the intent handed back.
 */
function validatePointer(pointer: InvitePointer): InvitePointer {
  try {
    validateSlug(pointer.team);
  } catch {
    throw new UserActionableError("invite-malformed", "invite pointer names an invalid team slug");
  }
  if (!isAllowedRemote(pointer.remote)) {
    throw new UserActionableError("invite-malformed", "invite pointer's remote is not a recognized git URL");
  }
  return { ...pointer, name: sanitizeDisplay(pointer.name), owner: sanitizeDisplay(pointer.owner) };
}

function isRelayConnectivityError(err: unknown): err is UserActionableError {
  return err instanceof UserActionableError && (err.code === "relay-unreachable" || err.code === "relay-error");
}

/**
 * A "gone" invite and an undecodable blob (wrong key, tampered ciphertext)
 * look identical from the joiner's side — both mean this code no longer
 * opens anything — so both collapse to the same invite-unknown error.
 * Returns null (not a throw) for a relay CONNECTIVITY failure, which is a
 * retryable, exit-0 outcome rather than a dead code. Anything else — a
 * programming error, not a documented relay-client failure mode — propagates
 * unchanged rather than being folded into "check your network".
 */
async function fetchPointer(relay: RelayClient, idHex: string, key: Uint8Array): Promise<InvitePointer | null> {
  let ciphertext: string;
  try {
    const fetched = await relay.fetch(idHex);
    if (fetched === "gone") throw inviteUnknownError();
    ciphertext = fetched.ciphertext;
  } catch (err) {
    if (err instanceof UserActionableError && err.code === "invite-unknown") throw err;
    if (isRelayConnectivityError(err)) return null;
    throw err;
  }
  let pointer: InvitePointer;
  try {
    pointer = await open(ciphertext, key, idHex);
  } catch {
    throw inviteUnknownError();
  }
  return validatePointer(pointer);
}

type GitFailureKind = "denied" | "network" | "missing-binary" | "disk-full" | "exists" | "local";

function classifyGitFailure(result: ExecResult): GitFailureKind {
  if (result.code === 127) return "missing-binary";
  const text = `${result.stdout}\n${result.stderr}`;
  if (AUTH_FAILURE_PATTERN.test(text)) return "denied";
  if (/no space left on device/i.test(text)) return "disk-full";
  if (/already exists and is not an empty directory/i.test(text)) return "exists";
  if (/could not resolve host|connection refused|connection timed out|network is unreachable|couldn't connect to server|ssl connect error|operation timed out|temporary failure in name resolution/i.test(text)) {
    return "network";
  }
  return "local";
}

/** "unreachable" is the only access value left once `denied` is ruled out, so every non-auth failure lands there — but the MESSAGE still says what actually happened; "check your network" is reserved for the one kind that is. */
function gitFailureMessage(kind: Exclude<GitFailureKind, "denied">, remote: string, result: ExecResult): string {
  switch (kind) {
    case "missing-binary":
      return "git is not installed (or not on PATH) — install git and try again";
    case "disk-full":
      return "no space left on this machine — free up disk space and try again";
    case "exists":
      return "the destination already exists and isn't empty — remove it and try again";
    case "network":
      return `could not reach ${stripUserinfo(remote)} — check your network and try again`;
    case "local":
      return `git failed (exit ${result.code}): ${withoutUrls(`${result.stdout}\n${result.stderr}`.trim())}`;
  }
}

function gitAccessResult(pointer: InvitePointer, result: ExecResult): JoinResult {
  const kind = classifyGitFailure(result);
  if (kind === "denied") return deniedResult(pointer);
  return unreachableResult(teamRefFrom(pointer), gitFailureMessage(kind, pointer.remote, result));
}

function accessFromVerdict(v: RepoAccessVerdict, pointer: InvitePointer): { access: JoinResult["access"]; message: string } {
  const joining = `Joining ${pointer.name} (owner ${pointer.owner})`;
  const forge = forgeLabel(forgeFromRemote(pointer.remote)?.provider);
  const repo = stripUserinfo(pointer.remote);
  switch (v.kind) {
    case "ok":
      return { access: "ok", message: joining };
    case "no-clt":
      return { access: "deferred", message: `${joining} - access to the team repo is checked on the next screen` };
    case "no-account":
      return { access: "no-account", message: `${joining}. Connect your ${forge} account on the next screen so rt can reach ${repo}.` };
    case "denied":
      return { access: "denied", message: `${joining}. Your ${forge} account cannot see ${repo} yet: ask ${pointer.owner} or your org admin to grant read access.` };
    case "unreachable":
      return { access: "unreachable", message: `${joining}. Could not reach ${repo}: ${v.detail}. The next screen re-checks it.` };
    default:
      return { access: "undetermined", message: `${joining}. Could not determine access to ${repo} yet: ${v.detail}. The next screen re-checks it.` };
  }
}

export async function joinDryRun(p: Probes, relay: RelayClient, code: string): Promise<JoinResult> {
  const { idHex, key } = decodeCode(code);

  const pointer = await fetchPointer(relay, idHex, key);
  if (pointer === null) {
    return { ...unreachableResult(NO_TEAM, "could not reach the invite relay - check your network and try again"), intent: "not-written" };
  }

  const verdict = await probeTeamRepoAccess(p, pointer.remote, await forgeTokenLookupReal(p, pointer.remote));
  writeIntent(p, { v: 1, at: p.now().toISOString(), mode: "join", join: { id: idHex, keyB64: Buffer.from(key).toString("base64"), pointer } });
  return { team: teamRefFrom(pointer), ...accessFromVerdict(verdict, pointer), peering: "idle", intent: "written" };
}

export interface JoinRedeemOpts {
  code?: string;
}

export type SecretsSeamsFactory = (slug: string) => SecretsSeams;

export interface JoinRedeemSeams {
  ageKeySeam: AgeKeySeam;
  read: SettingsReader;
  readTeamSecret: typeof readTeamSecret;
  forgeLogin: typeof forgeLogin;
  /** The forge token rt holds for `remote`'s host, or null: a fresh machine's git and gh/glab have nothing of their own to offer a private team repo. */
  forgeToken: (p: Probes, remote: string) => Promise<string | null>;
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
  return { ageKeySeam: createRealAgeKeySeam(), read: defaultRead(), readTeamSecret, forgeLogin, forgeToken: storedForgeToken, warn: defaultWarn };
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

/** The saved intent as a resume anchor for THIS exact invite — matched on id, not merely on presence, so an unrelated stale intent can never be mistaken for the one currently being redeemed. */
function matchingJoinIntent(p: Probes, idHex: string): JoinSource | undefined {
  const intent = readIntent(p);
  if (intent?.mode !== "join" || !intent.join || intent.join.id !== idHex) return undefined;
  return { idHex, key: base64ToKey(intent.join.keyB64), pointer: intent.join.pointer };
}

async function resolveSource(p: Probes, relay: RelayClient, code: string | undefined): Promise<JoinSource | JoinResult> {
  if (code) {
    const { idHex, key } = decodeCode(code);
    let pointer: InvitePointer | null;
    try {
      pointer = await fetchPointer(relay, idHex, key);
    } catch (err) {
      // The relay already marked this exact invite redeemed on a PRIOR run of
      // this same join (a reply-post or key-exchange failure after redeem
      // succeeded) — re-typing the same code must resume, not dead-end on a
      // code that is only "gone" because it already worked once.
      const resumed = err instanceof UserActionableError && err.code === "invite-unknown" ? matchingJoinIntent(p, idHex) : undefined;
      if (resumed) {
        return { ...resumed, pointer: validatePointer(resumed.pointer) };
      }
      throw err;
    }
    if (pointer === null) return unreachableResult(NO_TEAM, "could not reach the invite relay — check your network and try again");
    return { idHex, key, pointer };
  }

  const intent = readIntent(p);
  if (intent?.mode !== "join" || !intent.join) {
    throw new UserActionableError("no-join-intent", "no invite in progress — pass a code, or run `rt team join --dry-run` first to save one");
  }
  const pointer = validatePointer(intent.join.pointer);
  return { idHex: intent.join.id, key: base64ToKey(intent.join.keyB64), pointer };
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

  // Checkpointed BEFORE any clone/redeem attempt (not just on the dry-run
  // path) so a mid-flow failure below — relay unreachable, reply failed, the
  // keychain locked — leaves something a bare `rt team join` (no code) can
  // resume from, since the relay will no longer serve this code once
  // `relay.redeem` succeeds.
  writeIntent(p, { v: 1, at: p.now().toISOString(), mode: "join", join: { id: idHex, keyB64: Buffer.from(key).toString("base64"), pointer } });

  const dir = join(p.home, ".mattstack", "teams", pointer.team);
  const token = await seams.forgeToken(p, pointer.remote);
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
    const git = gitWithToken(["clone", pointer.remote, dir], token, GIT_ENV);
    const clone = await p.exec(git.argv, { env: git.env });
    if (clone.code !== 0) return gitAccessResult(pointer, clone);
  }

  // Identity resolution runs BEFORE relay.redeem, deliberately: this is the
  // one precondition that can only be checked once the team is cloned
  // (it reads the just-cloned settings file), so it has to happen here rather
  // than earlier — but it must still happen before the invite is consumed.
  // An unresolvable forge login is refused while the code is still redeemable
  // (a genuine pre-flight failure, exit 2 per R-T18-d), never after — that
  // would be the exact half-state R-T18-b exists to prevent.
  const snapshot = readTeamSnapshot(p, pointer.team, { read: seams.read, warn: seams.warn });
  const forge = snapshot.integrations.forge ?? forgeFromRemote(pointer.remote) ?? undefined;
  const handle = forge ? await seams.forgeLogin(p, forge.provider, forge.host, token) : null;
  if (!handle) {
    const cli = forge?.provider === "gitlab" ? "glab" : "gh";
    throw new UserActionableError(
      "forge-login-unknown",
      `the team is cloned at ${dir}, but your forge username could not be determined to redeem the invite — authenticate the ${cli} CLI and run \`rt team join\` again (the invite has not been used yet)`,
    );
  }

  let redeemed: "redeemed" | "already";
  try {
    redeemed = await relay.redeem(idHex);
  } catch (err) {
    if (isRelayConnectivityError(err)) {
      return unreachableResult(
        teamRefFrom(pointer),
        `could not reach the invite relay to finish redeeming — the team is already cloned at ${dir}; run \`rt team join\` again once the relay is reachable`,
      );
    }
    throw err;
  }
  // A resumed run whose clone already landed already won the redeem race on
  // a prior attempt — "already" here is the crash-recovery signal, not a
  // real conflict, so only a FRESH clone treats it as one.
  if (redeemed === "already" && !alreadyCloned) {
    throw inviteUnknownError(`this invite was already used: ask ${pointer.owner} for a new one`);
  }

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
    } else {
      peering = "unavailable";
    }
  }

  let publicKey: string;
  try {
    ({ publicKey } = await ensureAgeKey(seams.ageKeySeam));
  } catch (err) {
    throw new JoinKeyExchangeError(
      `joined ${pointer.name} and redeemed the invite, but could not read your local age key (${err instanceof Error ? err.message : String(err)}) — fix keychain access and run \`rt team join\` again to finish (no new code needed)`,
    );
  }

  const blob = await sealReply({ v: 1, agePublicKey: publicKey, handle }, key, idHex);
  try {
    await relay.reply(idHex, blob);
  } catch (err) {
    if (isRelayConnectivityError(err)) {
      return {
        team: teamRefFrom(pointer),
        access: "ok",
        peering,
        message: `joined ${pointer.name}, but could not send your key back to ${pointer.owner} — run \`rt team join\` again once the relay is reachable to finish (no new code needed)`,
        intent: "written",
      };
    }
    throw err;
  }

  clearIntent(p);
  return { team: teamRefFrom(pointer), access: "ok", peering, message: `Joined ${pointer.name} (owner ${pointer.owner})`, intent: "written" };
}
