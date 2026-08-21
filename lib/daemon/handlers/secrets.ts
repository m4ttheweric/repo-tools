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
 * gitlabToken — and nothing else `Secrets` carries. Gated behind the local
 * API token at the HTTP layer (api-auth.ts's needsToken), unlike the other
 * read-only :9401 routes, because unlike branch/MR metadata this response
 * body IS the credential.
 */

import { loadSecrets } from "../../linear.ts";
import { loadRepoTracking, grants, type RepoTracking } from "../../repo-tracking.ts";
import type { Commands, ForgeSlug } from "../../../packages/rt-client/src/commands.ts";
import type { HandlerContext, HandlerMap, TypedHandlers } from "./types.ts";

const SECRETS_KEY: Record<ForgeSlug, "gitlabToken" | "githubToken"> = {
  gitlab: "gitlabToken",
  github: "githubToken",
};

export interface SecretsHandlerOverrides {
  tracking?: () => RepoTracking;
  secrets?: () => { gitlabToken?: string; githubToken?: string } | Promise<{ gitlabToken?: string; githubToken?: string }>;
  /** Defaults to `loadSecrets` (the full encrypted-store + plaintext-fallback loader) for secrets:read. */
  extensionSecrets?: () => Promise<{ linearApiKey?: string; gitlabToken?: string }>;
}

export function createSecretsHandlers(
  ctx: HandlerContext,
  overrides: SecretsHandlerOverrides = {},
): Pick<TypedHandlers, "secrets:forge-token" | "secrets:read"> & HandlerMap {
  const tracking = overrides.tracking ?? loadRepoTracking;
  const secrets = overrides.secrets ?? loadSecrets;
  const extensionSecrets = overrides.extensionSecrets ?? loadSecrets;

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

    "secrets:read": async () => {
      const all = await extensionSecrets();
      const data: Commands["secrets:read"]["data"] = {};
      if (all.linearApiKey) data.linearApiKey = all.linearApiKey;
      if (all.gitlabToken) data.gitlabToken = all.gitlabToken;
      ctx.log.info({ keys: Object.keys(data) }, "secrets:read");
      return { ok: true as const, data };
    },
  };
}
