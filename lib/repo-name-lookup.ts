/**
 * Reverse lookup from a human-typed repo NAME to the index key that owns it.
 *
 * Its own module, not part of repo-arg.ts, because the daemon needs this rule
 * too (the tray's ready-approve payload, the legacy re-key resolver) and
 * `lib/__tests__/no-eager-tui.test.ts` bans the daemon graph from reaching
 * repo-arg.ts / repo.ts -- they pull the CLI picker chain and sync `execSync`
 * onto a thread that must never block. Everything here is pure over the index
 * the caller passes: no index read, no git, nothing to ban.
 */

import { realpathSync } from "fs";
import { basename } from "path";
import { parseIdentity } from "./settings/identity.ts";

/**
 * Index rows whose basename or identity tail matches `name`, with each
 * legacy-name/identity pair the additive heal leaves behind collapsed to one
 * row (identity preferred) -- until `rt repos prune` collapses the pair for
 * real, both rows point at the same directory and a naive match count calls
 * every healed repo ambiguous.
 */
export function reverseLookupByName(name: string, index: Record<string, string>): [string, string][] {
  const matches = Object.entries(index).filter(
    ([id, path]) => basename(path) === name || parseIdentity(id)?.id.split("/").pop() === name,
  );
  const byRealpath = new Map<string, [string, string]>();
  for (const m of matches) {
    let real: string;
    try {
      real = realpathSync(m[1]);
    } catch {
      real = m[1];
    }
    const prev = byRealpath.get(real);
    if (!prev || (parseIdentity(m[0]) !== null && parseIdentity(prev[0]) === null)) byRealpath.set(real, m);
  }
  return [...byRealpath.values()];
}
