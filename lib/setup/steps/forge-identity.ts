/**
 * Resolving "which forge is this person on, and with which token" is the same
 * question for every step that needs the operator's own forge account, and
 * the answer has three sources in a fixed precedence: the team's declared
 * forge, the forge implied by the team's remote, then the host the operator
 * confirmed for themselves during `rt setup <id> connect`. The last is all a
 * machine with no team has.
 */

import type { ApplyContext } from "../apply.ts";
import { isValidHostname } from "../host-validate.ts";
import { forgeFromHost, forgeFromRemote, readUserIntegrationOverrides } from "../team-settings.ts";
import { forgeTokenFor } from "./forge-token.ts";

export interface ResolvedForge {
  host: string;
  provider: "github" | "gitlab";
  token: string | null;
}

/**
 * `forgeTokenFor` derives the token's key from the host inside a full remote
 * URL, and a bare `https://host/` does not parse as one. The path segment is
 * inert: only the host decides which token rt holds.
 */
function tokenRemoteFor(host: string): string {
  return `https://${host}/mattstack/identity`;
}

/**
 * Hostname-validated: nothing but a real host may reach `gh`/`glab`.
 */
function connectedForge(): { host: string; provider: "github" | "gitlab" } | null {
  const host = readUserIntegrationOverrides().forgeHost;
  return host && isValidHostname(host) ? forgeFromHost(host) : null;
}

/** Null when no forge is connected at all. Redacts the token it resolves. */
export async function resolveForge(ctx: ApplyContext): Promise<ResolvedForge | null> {
  const forge =
    ctx.snapshot?.integrations.forge ??
    (ctx.snapshot?.remote ? forgeFromRemote(ctx.snapshot.remote) : null) ??
    connectedForge();
  if (!forge) return null;

  const token = await forgeTokenFor(ctx, tokenRemoteFor(forge.host));
  if (token) ctx.redact(token);
  return { host: forge.host, provider: forge.provider, token };
}
