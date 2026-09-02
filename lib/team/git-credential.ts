/**
 * rt keeps forge tokens in its own store (or the setup stage before Install),
 * not in git's credential helper — so a fresh machine's git has nothing to
 * offer a private remote. This hands a token to git through an inline
 * credential helper that reads the environment: never argv (visible in ps),
 * never the URL (echoed into stderr and .git/config).
 */

import { forgeFromRemote } from "../setup/team-settings.ts";

const HELPER = "!f() { echo username=$RT_GIT_USER; echo password=$RT_GIT_TOKEN; }; f";

export interface GitWithToken {
  argv: string[];
  env: Record<string, string>;
}

/** `git <args>` with `token` offered for the remote; `env` merges over the caller's own. */
export function gitWithToken(args: string[], token: string | null, env: Record<string, string> = {}): GitWithToken {
  if (!token) return { argv: ["git", ...args], env };
  return {
    argv: ["git", "-c", "credential.helper=", "-c", `credential.helper=${HELPER}`, ...args],
    env: { ...env, RT_GIT_USER: "x-access-token", RT_GIT_TOKEN: token },
  };
}

/** The secret key holding the forge token for a remote's host, or null for a remote rt has no token concept for. */
export function forgeTokenKey(remote: string): "githubToken" | "gitlabToken" | null {
  const forge = forgeFromRemote(remote);
  if (!forge) return null;
  return forge.provider === "github" ? "githubToken" : "gitlabToken";
}
