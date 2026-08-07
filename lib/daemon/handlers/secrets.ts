/**
 * secrets:forge-token — the forge token for one tracked repo (MAT-33).
 *
 * Exists so consumers (gitq first) stop opening ~/.rt/secrets.json
 * themselves: the direct file read depended on a format rt owns and walked
 * around the per-repo grant model in repo-tracking.json entirely. Going
 * through the daemon puts token access behind the same tracking grant every
 * other repo-scoped read uses, and gives it a log line.
 *
 * Deliberately narrow (a token for one forge for one tracked repo) rather
 * than a general secrets:read: the narrow verb leaks nothing a caller did
 * not name.
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
  secrets?: () => { gitlabToken?: string; githubToken?: string };
}

export function createSecretsHandlers(
  ctx: HandlerContext,
  overrides: SecretsHandlerOverrides = {},
): Pick<TypedHandlers, "secrets:forge-token"> & HandlerMap {
  const tracking = overrides.tracking ?? loadRepoTracking;
  const secrets = overrides.secrets ?? loadSecrets;

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

      const token = secrets()[SECRETS_KEY[forge]];
      if (!token) {
        return { ok: false as const, error: `no ${forge} token in ~/.rt/secrets.json (${SECRETS_KEY[forge]})` };
      }

      ctx.log.info({ repoName, forge }, "secrets:forge-token grant-gated read");
      return { ok: true as const, data: { token } };
    },
  };
}
