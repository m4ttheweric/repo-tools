/**
 * The only place plan/apply read team-scoped settings keys — every other
 * setup module gets team facts through the `TeamSnapshot` this produces,
 * never by calling `getSetting` itself. `getSetting` reads real files on
 * disk directly (it has no `Probes` seam of its own); `p.readFile` is used
 * only for the one value that isn't a registered setting, the team clone's
 * git remote.
 *
 * `mattstack.integrations`/`mattstack.tracking`/`claude.marketplaces`/
 * `claude.plugins` are TEAM-scoped keys, but the resolver's `readStores()`
 * overlays EVERY locally-cloned team's store, alphabetically ("wave 1:
 * overlay all" — multi-team precedence is explicitly out of scope until the
 * resolver adds it, per its own doc). `slug` therefore names whose git
 * remote this snapshot reads, not which team's settings values it returns —
 * those are today's single-cloned-team value regardless of `slug`. Accurate
 * only because exactly one team is ever cloned in the current design; a
 * multi-team snapshot needs the resolver to grow real per-team scoping
 * first, not a workaround here.
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

/** Reads one registered setting key, degrading to `undefined` on a resolver-layer throw rather than taking the whole plan down with it. Injectable so tests never touch the real resolver/disk. */
export type SettingsReader = <T>(key: string) => T | undefined;

/** Every reader default routes through here so a bad key/resolver state is reported once, through the caller's own warn seam — never a bare `console.*` call baked into library code. */
function defaultReader(warn: (message: string) => void): SettingsReader {
  return <T>(key: string): T | undefined => {
    try {
      return getSetting<T>(key).value;
    } catch (err) {
      warn(`rt: ${key} could not be resolved (${err instanceof Error ? err.message : String(err)}) — treated as unset`);
      return undefined;
    }
  };
}

/** stderr only, never stdout — keeps a `--json` command's envelope on stdout uncorrupted. A caller on a JSON path that wants total silence passes its own no-op via `readTeamSnapshot`'s `warn` param. */
function defaultWarn(message: string): void {
  console.error(message);
}

/** `[remote "origin"]`'s `url =` line, scoped to that section (stops at the next `[` header) so a later `[remote "upstream"]` block, or a `url =` line inside a `[branch]` section, can never be mistaken for origin's. `pushurl` is a distinct key and never matches `\burl\s*=`. Exported so lib/team's create/publish can read the same `.git/config` shape without a second regex. */
export function parseOriginUrl(gitConfig: string): string | null {
  const match = gitConfig.match(/\[remote "origin"\][^[]*?(?:^|\n)\s*url\s*=\s*(\S+)/m);
  return match ? match[1]! : null;
}

export function readTeamSnapshot(p: Probes, slug: string, opts: { read?: SettingsReader; warn?: (message: string) => void } = {}): TeamSnapshot {
  const warn = opts.warn ?? defaultWarn;
  const read = opts.read ?? defaultReader(warn);

  const integrations = read<TeamIntegrations>("mattstack.integrations") ?? {};
  const tracking = read<{ repos?: Record<string, unknown> }>("mattstack.tracking");
  const marketplaces = read<unknown>("claude.marketplaces");
  const plugins = read<unknown>("claude.plugins");

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

/** Strips `user:pass@`/`user@` userinfo that a credential-bearing URL (`https://token@host/...`) would otherwise leak into an integration's `host`. */
function stripUserinfo(hostWithScheme: string): string {
  return hostWithScheme.replace(/^(https?:\/\/)[^@/]+@/, "$1");
}

/** github.com is the only hosted GitHub; every other host is assumed self-hosted GitLab (rt has no other forge integration to fall back to). */
export function forgeFromRemote(remote: string): { host: string; provider: "github" | "gitlab" } | null {
  const parsed = parseRemoteUrl(remote);
  if (!parsed) return null;
  const host = stripUserinfo(parsed.host).replace(/^https?:\/\//, "");
  return { host, provider: host === "github.com" ? "github" : "gitlab" };
}
