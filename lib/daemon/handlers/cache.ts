/**
 * Cache & branch-enrichment IPC handlers.
 *
 *   cache:read      — return cache entries, optionally filtered by branch list
 *   cache:refresh   — kick off a background refresh (fire-and-forget)
 *   branch:enrich   — serve cached, else on-demand enrich via ./enrich.ts
 *
 * Cache reads go through `ctx.cache.entries` (live reference) rather than a
 * captured variable, so disk reloads performed elsewhere remain visible.
 */

import type { HandlerContext, HandlerMap, CacheEntry } from "./types.ts";
import { branchOf, composeKey, getByBranch } from "../../state/branch-cache.ts";

/** How long an entry that resolved a ticket id but never got the ticket is
    left alone before another lookup is spent on it. Short enough that a key
    that was missing at first write heals on the next read; long enough that a
    ticket id which genuinely resolves to nothing costs one lookup an hour,
    not one per request. */
const INCOMPLETE_RETRY_MS = 10 * 60 * 1000;

/**
 * A cached entry is INCOMPLETE, not a hit, when it extracted a ticket id but
 * carries no ticket: that pairing only happens when the lookup failed or was
 * skipped (no API key at write time), and the old code's plain existence
 * check meant such an entry never got another chance for the life of the
 * cache. Entries with no id at all are complete by definition — there is
 * nothing left to resolve, and retrying them would spend a lookup per read.
 */
function isIncomplete(entry: CacheEntry, now: number = Date.now()): boolean {
  if (!entry.linearId || entry.ticket) return false;
  return now - (entry.fetchedAt ?? 0) >= INCOMPLETE_RETRY_MS;
}

export function createCacheHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "cache:read": async (payload) => {
      const branches = payload?.branches as string[] | undefined;
      const maxAgeMs = payload?.maxAgeMs as number | undefined;
      // Optional exact scoping: an absent repoIdentity falls back to a
      // suffix match across repos (today's callers never pass this yet).
      const repoIdentity = payload?.repoIdentity as string | undefined;

      const lookup = (b: string): CacheEntry | undefined =>
        repoIdentity ? ctx.cache.entries[composeKey(repoIdentity, b)] : getByBranch(ctx.cache.entries, b);

      // Freshness gate: when the caller sets maxAgeMs, refresh first if the
      // oldest requested entry is older than that. Missing entries and an
      // empty cache count as infinitely stale. refreshCache is coalesced, so
      // concurrent stale readers share one refresh.
      if (typeof maxAgeMs === "number") {
        const pool = branches ?? Object.keys(ctx.cache.entries).map(branchOf);
        let oldestFetchedAt = 0;
        if (pool.length > 0) {
          oldestFetchedAt = Math.min(...pool.map((b) => lookup(b)?.fetchedAt ?? 0));
        }
        if (Date.now() - oldestFetchedAt >= maxAgeMs) {
          await ctx.refreshCache();
        }
      }

      // The output is always bare-branch keyed, never the store's internal
      // composite keys, so cache:read's contract to the CLI/board/tray
      // never changes underneath them.
      if (!branches) {
        const out: Record<string, CacheEntry> = {};
        for (const [k, v] of Object.entries(ctx.cache.entries)) out[branchOf(k)] = v;
        return { ok: true, data: out };
      }
      const filtered: Record<string, CacheEntry> = {};
      for (const b of branches) {
        const entry = lookup(b);
        if (entry) filtered[b] = entry;
      }
      return { ok: true, data: filtered };
    },

    "cache:refresh": async () => {
      ctx.refreshCache().catch(() => {});
      return { ok: true, message: "refresh started" };
    },

    "branch:enrich": async (payload) => {
      const branch      = payload?.branch      as string;
      const repoPath    = payload?.repoPath    as string;
      const remoteUrl   = payload?.remoteUrl   as string | undefined;
      const repoIdentity = payload?.repoIdentity as string | undefined;
      // Test seam: the enricher, so a test never reaches Linear or the forge.
      const inject    = payload?.enrich    as
        | ((b: unknown, r: unknown, o: unknown) => Promise<void>)
        | undefined;

      if (!branch) return { ok: false, error: "missing branch" };

      const lookupBranch = (): CacheEntry | undefined =>
        repoIdentity ? ctx.cache.entries[composeKey(repoIdentity, branch)] : getByBranch(ctx.cache.entries, branch);

      const cached = lookupBranch();
      const healing = !!cached;
      if (cached && !isIncomplete(cached)) {
        return { ok: true, data: cached, source: "cache" };
      }

      if (!repoPath) return { ok: false, error: "missing repoPath for cold enrichment" };

      try {
        // `forceRefresh` is load-bearing when healing: enrichBranches has its
        // own all-cached short-circuit keyed on mere presence, so without it
        // a re-enrich of a branch already in the store returns the same
        // incomplete entry and never reaches the ticket lookup.
        const opts = { silent: true, forceRefresh: healing };
        if (inject) {
          await inject([{ path: repoPath, branch }], remoteUrl, opts);
        } else {
          const { enrichBranches } = await import("../../enrich.ts");
          await enrichBranches([{ path: repoPath, branch }], remoteUrl, opts);
        }

        // enrichBranches wrote through the same singleton store in this
        // process, so the map is already current; reload() is kept because
        // it also picks up rows a racing CLI enrichment upserted.
        ctx.cache.reload();

        const fresh = lookupBranch();
        if (fresh) {
          return { ok: true, data: fresh, source: "fresh" };
        }
        return { ok: true, data: null, source: "empty" };
      } catch (err) {
        return { ok: false, error: `enrichment failed: ${err}` };
      }
    },
  };
}
