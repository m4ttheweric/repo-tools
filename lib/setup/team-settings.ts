/**
 * The only place plan/apply read team-scoped settings keys — every other
 * setup module gets team facts through the `TeamSnapshot` this produces,
 * never by calling `getSetting` itself. `getSetting` reads real files on
 * disk directly (it has no `Probes` seam of its own); `p.readFile` is used
 * only for the one value that isn't a registered setting, the team clone's
 * git remote.
 */

import { join } from "path";
import { getSetting } from "../settings/resolve.ts";
import { parseRemoteUrl } from "../enrich.ts";
import type { Probes } from "./probes.ts";

export interface TeamIntegrations {
  forge?: { host: string; provider: "github" | "gitlab" };
  slack?: { appId?: string; clientId?: string; channel?: string; callbackPort?: number };
  linear?: { teamKey: string };
  switchboard?: { url: string };
}

export interface TeamSnapshot {
  slug: string;
  integrations: TeamIntegrations;
  trackingIdentities: string[];
  marketplaces: string[];
  plugins: string[];
  remote: string | null;
}

/** getSetting throws only for an unregistered key (a caller bug) — every key read here is registered, but a resolver-layer throw still degrades to "unset" rather than taking down the whole plan. */
function safeSetting<T>(key: string): T | undefined {
  try {
    return getSetting<T>(key).value;
  } catch (err) {
    console.warn(`rt: ${key} could not be resolved (${err instanceof Error ? err.message : String(err)}) — treated as unset`);
    return undefined;
  }
}

/** `[remote "origin"]`'s `url =` line, scoped to that section (stops at the next `[` header) so a later `[remote "upstream"]` block can never be mistaken for origin's. */
function parseOriginUrl(gitConfig: string): string | null {
  const match = gitConfig.match(/\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/);
  return match ? match[1]! : null;
}

export function readTeamSnapshot(p: Probes, slug: string): TeamSnapshot {
  const integrations = safeSetting<TeamIntegrations>("mattstack.integrations") ?? {};
  const tracking = safeSetting<{ repos?: Record<string, unknown> }>("mattstack.tracking");
  const marketplaces = safeSetting<unknown>("claude.marketplaces");
  const plugins = safeSetting<unknown>("claude.plugins");

  const gitConfig = p.readFile(join(p.home, ".mattstack", "teams", slug, ".git", "config"));
  const remote = gitConfig !== null ? parseOriginUrl(gitConfig) : null;

  return {
    slug,
    integrations,
    trackingIdentities: Object.keys(tracking?.repos ?? {}),
    marketplaces: Array.isArray(marketplaces) ? (marketplaces as string[]) : [],
    plugins: Array.isArray(plugins) ? (plugins as string[]) : [],
    remote,
  };
}

/** github.com is the only hosted GitHub; every other host is assumed self-hosted GitLab (rt has no other forge integration to fall back to). */
export function forgeFromRemote(remote: string): { host: string; provider: "github" | "gitlab" } | null {
  const parsed = parseRemoteUrl(remote);
  if (!parsed) return null;
  const host = parsed.host.replace(/^https?:\/\//, "");
  return { host, provider: host === "github.com" ? "github" : "gitlab" };
}
