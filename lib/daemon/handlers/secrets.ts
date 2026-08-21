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
 * `payload.scope` (Task 3, deck lane) adds a second whitelist alongside the
 * extension's, each reading its own encrypted domain — "extension" (default,
 * so existing callers need no change) reads the `rt` domain's linearApiKey/
 * gitlabToken; "deck" reads the `deck` domain's cfApiToken/cfZoneId. The
 * token gate above applies identically to both; scope is checked only after
 * it passes, and an unknown scope is refused before either domain reader
 * runs — the two whitelists must never blend into one combined read.
 */

import { loadSecrets } from "../../linear.ts";
import { loadMachineRepoTracking, grants, type RepoTracking } from "../../repo-tracking.ts";
import { loadOrCreateApiToken, tokenOk } from "../api-auth.ts";
import { readSecret, createRealSecretsExecSeam, type SecretsSeams } from "../../secrets/store.ts";
import { createRealAgeKeySeam } from "../../home/age-key.ts";
import type { Commands, ForgeSlug } from "../../../packages/rt-client/src/commands.ts";
import type { HandlerContext, HandlerMap, TypedHandlers } from "./types.ts";

const DECK_SECRET_DOMAIN = "deck";
const DECK_SECRET_KEYS = ["cfApiToken", "cfZoneId"] as const;

let realDeckSecretsSeamsSingleton: SecretsSeams | null = null;

/** Lazily-built real seams, separate from lib/linear.ts's `rt`-domain singleton since this reads a different domain file. */
function defaultDeckSecretsSeams(): SecretsSeams {
  return realDeckSecretsSeamsSingleton ??= {
    ageKeySeam: createRealAgeKeySeam(),
    execSeam: createRealSecretsExecSeam(),
  };
}

async function loadDeckSecrets(): Promise<{ cfApiToken?: string; cfZoneId?: string }> {
  const seams = defaultDeckSecretsSeams();
  const out: { cfApiToken?: string; cfZoneId?: string } = {};
  for (const key of DECK_SECRET_KEYS) {
    const value = await readSecret(DECK_SECRET_DOMAIN, key, seams);
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
  /** Defaults to `loadSecrets` (the full encrypted-store + plaintext-fallback loader) for secrets:read's "extension" scope. */
  extensionSecrets?: () => Promise<{ linearApiKey?: string; gitlabToken?: string }>;
  /** Defaults to `loadDeckSecrets` (the `deck` encrypted domain) for secrets:read's "deck" scope. */
  deckSecrets?: () => Promise<{ cfApiToken?: string; cfZoneId?: string }>;
  /** Defaults to `loadOrCreateApiToken` (the real ~/.mattstack/rt/api-token, shared with api-auth.ts). */
  apiToken?: () => string;
}

export function createSecretsHandlers(
  ctx: HandlerContext,
  overrides: SecretsHandlerOverrides = {},
): Pick<TypedHandlers, "secrets:forge-token" | "secrets:read"> & HandlerMap {
  // Machine-only, deliberately: mattstack.tracking is a SHARED team file, and
  // a team-declared repo must not be enough on its own to unlock a token
  // read — that consent has to be local (a machine rt.repoTracking grant),
  // same as the "off" opt-out rule loadRepoTracking documents.
  const tracking = overrides.tracking ?? loadMachineRepoTracking;
  const secrets = overrides.secrets ?? loadSecrets;
  const extensionSecrets = overrides.extensionSecrets ?? loadSecrets;
  const deckSecrets = overrides.deckSecrets ?? loadDeckSecrets;
  const apiToken = overrides.apiToken ?? (() => loadOrCreateApiToken());

  return {
    "secrets:forge-token": async (payload: Commands["secrets:forge-token"]["payload"]) => {
      const repoName = payload?.repoName;
      const forge = payload?.forge;
      if (!repoName) return { ok: false as const, error: "missing repoName" };
      if (forge !== "gitlab" && forge !== "github") {
        return { ok: false as const, error: `unknown forge "${String(forge)}"; expected gitlab or github` };
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
        return { ok: false as const, error: `no ${forge} token in ~/.mattstack/rt/secrets.json (${SECRETS_KEY[forge]})` };
      }

      ctx.log.info({ repoName, forge }, "secrets:forge-token grant-gated read");
      return { ok: true as const, data: { token } };
    },

    "secrets:read": async (payload: Commands["secrets:read"]["payload"]) => {
      const provided = payload?.token;
      if (!provided) {
        return { ok: false as const, error: "missing-token" };
      }
      if (!tokenOk(provided, apiToken())) {
        return { ok: false as const, error: "bad-token" };
      }

      const scope = payload?.scope ?? "extension";
      const data: Commands["secrets:read"]["data"] = {};
      if (scope === "extension") {
        const all = await extensionSecrets();
        if (all.linearApiKey) data.linearApiKey = all.linearApiKey;
        if (all.gitlabToken) data.gitlabToken = all.gitlabToken;
      } else if (scope === "deck") {
        const all = await deckSecrets();
        if (all.cfApiToken) data.cfApiToken = all.cfApiToken;
        if (all.cfZoneId) data.cfZoneId = all.cfZoneId;
      } else {
        return { ok: false as const, error: "bad-scope" };
      }
      ctx.log.debug({ scope, keys: Object.keys(data) }, "secrets:read");
      return { ok: true as const, data };
    },
  };
}
