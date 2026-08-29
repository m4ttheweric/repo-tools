/**
 * secrets:forge-token — the forge token for one tracked repo (MAT-33).
 *
 * Exists so consumers (gitq first) stop opening ~/.mattstack/rt/secrets.json
 * themselves: the direct file read depended on a format rt owns and walked
 * around the per-repo grant model in repo-tracking.json entirely. Going
 * through the daemon puts token access behind the same tracking grant every
 * other repo-scoped read uses, and gives it a log line.
 *
 * Deliberately narrow (a token for one forge for one tracked repo) rather
 * than a general secrets:read: the narrow verb leaks nothing a caller did
 * not name.
 *
 * secrets:read (RT-32) is a second, differently-scoped exception to that
 * same narrowness rule: the VS Code extension needs a couple of raw values
 * (not a repo-scoped token), so it whitelists exactly the fields
 * extensions/vscode/rt-context/src/secrets.ts reads — linearApiKey and
 * gitlabToken — and nothing else `Secrets` carries.
 *
 * secrets:read is deliberately TOKEN-gated and GRANT-EXEMPT — the opposite
 * split from secrets:forge-token above. It serves the user's own editor
 * extension (a single local, already-trusted client), not per-repo
 * automation, so a repo-tracking grant check would be the wrong gate; the
 * local API token (api-auth.ts) is the right one. That gate is enforced
 * HERE, in the handler, not only at the HTTP layer: the unix-socket
 * transport (socket-server.ts) has no auth of its own, so a handler-only
 * check would leave that transport wide open. `payload.token` carries the
 * proof for BOTH transports — api-server.ts forwards its already-verified
 * X-RT-Token header into the payload so HTTP callers (the extension) don't
 * need to change; a socket caller must read ~/.mattstack/rt/api-token
 * itself and pass it the same way.
 *
 * `payload.scope` adds further whitelists alongside the extension's, each
 * reading its own encrypted domain(s) — "extension" (default, so existing
 * callers need no change) reads the `rt` domain's linearApiKey/gitlabToken;
 * "deck" reads the `deck` domain's cfApiToken/cfZoneId; "board" is
 * CROSS-DOMAIN, reading slackToken/slackClientSecret/slackSigningSecret
 * from the `board` domain and gitlabToken/switchboardToken/
 * switchboardAdminToken from the `rt` domain. The token gate above applies
 * identically to every scope; scope is checked only after it passes, and an
 * unknown scope is refused before any domain reader runs — the whitelists
 * must never blend into one combined read, even where board's rt-domain
 * entries overlap a key name (gitlabToken) extension's whitelist also uses.
 */

import { loadSecrets } from "../../linear.ts";
import { parseIdentity } from "../../settings/identity.ts";
import { loadMachineRepoTracking, grants, type RepoTracking } from "../../repo-tracking.ts";
import { getApiToken, tokenOk } from "../api-auth.ts";
import { readSecret, createRealSecretsExecSeam, type SecretsSeams } from "../../secrets/store.ts";
import { createRealAgeKeySeam } from "../../home/age-key.ts";
import type { Commands, ForgeSlug } from "../../../packages/rt-client/src/commands.ts";
import type { CommandResult, HandlerContext } from "./types.ts";

const DECK_SECRET_DOMAIN = "deck";
const DECK_SECRET_KEYS = ["cfApiToken", "cfZoneId"] as const;

/** Cross-domain whitelist for the "board" scope — explicit (domain, key) pairs rather than one domain's key list, since board draws from both `board` and `rt`. */
const BOARD_SECRET_ENTRIES = [
  ["board", "slackToken"],
  ["board", "slackClientSecret"],
  ["board", "slackSigningSecret"],
  ["rt", "gitlabToken"],
  ["rt", "switchboardToken"],
  ["rt", "switchboardAdminToken"],
] as const;

let realSecretsSeamsSingleton: SecretsSeams | null = null;

/** Lazily-built real seams, private to this module — a separate instance from lib/linear.ts's own singleton only because module scope doesn't let this file reuse that one, not because the seams themselves are domain-bound (`readSecret` takes `domain` as a parameter). Shared by every scope's loader below. */
function defaultSecretsSeams(): SecretsSeams {
  return realSecretsSeamsSingleton ??= {
    ageKeySeam: createRealAgeKeySeam(),
    execSeam: createRealSecretsExecSeam(),
  };
}

async function loadDeckSecrets(): Promise<{ cfApiToken?: string; cfZoneId?: string }> {
  const seams = defaultSecretsSeams();
  const out: { cfApiToken?: string; cfZoneId?: string } = {};
  for (const key of DECK_SECRET_KEYS) {
    const value = await readSecret(DECK_SECRET_DOMAIN, key, seams);
    if (value !== null) out[key] = value;
  }
  return out;
}

export interface BoardSecretsData {
  slackToken?: string;
  slackClientSecret?: string;
  slackSigningSecret?: string;
  gitlabToken?: string;
  switchboardToken?: string;
  switchboardAdminToken?: string;
}

/** `readSecret` injected as a plain (domain, key) -> value|null function, not the full `SecretsSeams` — lets a test exercise the real per-entry read sequence and partial-failure ordering without faking sops/age-key exec plumbing. */
export type ReadSecretFn = (domain: string, key: string) => Promise<string | null>;

function defaultReadSecret(domain: string, key: string): Promise<string | null> {
  return readSecret(domain, key, defaultSecretsSeams());
}

/** Reads BOARD_SECRET_ENTRIES in order; a throw on any entry (e.g. the first `rt`-domain read after `board`'s three succeed) rejects the whole call with nothing partial returned — callers see either every readable key or an error, never a half-populated object. */
export async function loadBoardSecrets(readSecretFn: ReadSecretFn = defaultReadSecret): Promise<BoardSecretsData> {
  const out: BoardSecretsData = {};
  for (const [domain, key] of BOARD_SECRET_ENTRIES) {
    const value = await readSecretFn(domain, key);
    if (value !== null) out[key] = value;
  }
  return out;
}

const SECRETS_KEY: Record<ForgeSlug, "gitlabToken" | "githubToken"> = {
  gitlab: "gitlabToken",
  github: "githubToken",
};

export interface SecretsHandlerOverrides {
  tracking?: () => RepoTracking;
  secrets?: () => { gitlabToken?: string; githubToken?: string } | Promise<{ gitlabToken?: string; githubToken?: string }>;
  /** Defaults to `loadSecrets` (the `rt` encrypted domain) for secrets:read's "extension" scope. */
  extensionSecrets?: () => Promise<{ linearApiKey?: string; gitlabToken?: string }>;
  /** Defaults to `loadDeckSecrets` (the `deck` encrypted domain) for secrets:read's "deck" scope. */
  deckSecrets?: () => Promise<{ cfApiToken?: string; cfZoneId?: string }>;
  /** Defaults to `loadBoardSecrets` (cross-domain: `board` + `rt`) for secrets:read's "board" scope. */
  boardSecrets?: () => Promise<BoardSecretsData>;
  /** Defaults to `getApiToken` (the real ~/.mattstack/rt/api-token, shared with api-auth.ts and api-server.ts). */
  apiToken?: () => string;
}

export function createSecretsHandlers(
  ctx: HandlerContext,
  overrides: SecretsHandlerOverrides = {},
): { "secrets:forge-token": (payload: unknown) => Promise<CommandResult<"secrets:forge-token">> }
  & { "secrets:read": (payload: unknown) => Promise<CommandResult<"secrets:read">> } {
  // Machine-only, deliberately: mattstack.tracking is a SHARED team file, and
  // a team-declared repo must not be enough on its own to unlock a token
  // read — that consent has to be local (a machine rt.repoTracking grant),
  // same as the "off" opt-out rule loadRepoTracking documents.
  const tracking = overrides.tracking ?? loadMachineRepoTracking;
  const secrets = overrides.secrets ?? loadSecrets;
  const extensionSecrets = overrides.extensionSecrets ?? loadSecrets;
  const deckSecrets = overrides.deckSecrets ?? loadDeckSecrets;
  const boardSecrets = overrides.boardSecrets ?? loadBoardSecrets;
  const apiToken = overrides.apiToken ?? (() => getApiToken());

  return {
    "secrets:forge-token": async (rawPayload: unknown) => {
      const payload = rawPayload as Commands["secrets:forge-token"]["payload"] | undefined;
      const repoName = payload?.repoName;
      const forge = payload?.forge;
      if (!repoName) return { ok: false as const, error: "missing repoName" };
      if (forge !== "gitlab" && forge !== "github") {
        return { ok: false as const, error: `unknown forge "${String(forge)}"; expected gitlab or github` };
      }
      // Hard cutover: grants() keys on identity now; a bare legacy
      // name is refused before it can be read as "not tracked".
      if (parseIdentity(repoName) === null) {
        return { ok: false as const, error: `repo ${repoName} is not tracked by rt; run: rt daemon track ${repoName} live branches` };
      }

      // The grant gate, and the whole point of the verb: an untracked repo
      // gets nothing, where the old direct file read handed every caller
      // every token.
      if (grants(tracking(), repoName).mode === "off") {
        return {
          ok: false as const,
          error: `repo ${repoName} is not tracked by rt; run: rt daemon track ${repoName} live branches`,
        };
      }

      const token = (await secrets())[SECRETS_KEY[forge]];
      if (!token) {
        return { ok: false as const, error: `no ${forge} token configured (run: rt secrets set rt ${SECRETS_KEY[forge]})` };
      }

      ctx.log.info({ repoName, forge }, "secrets:forge-token grant-gated read");
      return { ok: true as const, data: { token } };
    },

    "secrets:read": async (rawPayload: unknown) => {
      const payload = rawPayload as Commands["secrets:read"]["payload"] | undefined;
      const provided = payload?.token;
      if (!provided) {
        return { ok: false as const, error: "missing-token" };
      }
      if (!tokenOk(provided, apiToken())) {
        return { ok: false as const, error: "bad-token" };
      }

      const scope = payload?.scope ?? "extension";
      if (scope === "extension") {
        const all = await extensionSecrets();
        const data: { linearApiKey?: string; gitlabToken?: string } = {};
        if (all.linearApiKey) data.linearApiKey = all.linearApiKey;
        if (all.gitlabToken) data.gitlabToken = all.gitlabToken;
        ctx.log.debug({ scope, keys: Object.keys(data) }, "secrets:read");
        return { ok: true as const, data };
      }
      if (scope === "deck") {
        const all = await deckSecrets();
        const data: { cfApiToken?: string; cfZoneId?: string } = {};
        if (all.cfApiToken) data.cfApiToken = all.cfApiToken;
        if (all.cfZoneId) data.cfZoneId = all.cfZoneId;
        ctx.log.debug({ scope, keys: Object.keys(data) }, "secrets:read");
        return { ok: true as const, data };
      }
      if (scope === "board") {
        const all = await boardSecrets();
        const data: BoardSecretsData = {};
        if (all.slackToken) data.slackToken = all.slackToken;
        if (all.slackClientSecret) data.slackClientSecret = all.slackClientSecret;
        if (all.slackSigningSecret) data.slackSigningSecret = all.slackSigningSecret;
        if (all.gitlabToken) data.gitlabToken = all.gitlabToken;
        if (all.switchboardToken) data.switchboardToken = all.switchboardToken;
        if (all.switchboardAdminToken) data.switchboardAdminToken = all.switchboardAdminToken;
        ctx.log.debug({ scope, keys: Object.keys(data) }, "secrets:read");
        return { ok: true as const, data };
      }
      return { ok: false as const, error: "bad-scope" };
    },
  };
}
