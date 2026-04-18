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

export function createCacheHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "cache:read": async (payload) => {
      const branches = payload?.branches as string[] | undefined;
      if (!branches) return { ok: true, data: ctx.cache.entries };
      const filtered: Record<string, CacheEntry> = {};
      for (const b of branches) {
        if (ctx.cache.entries[b]) filtered[b] = ctx.cache.entries[b];
      }
      return { ok: true, data: filtered };
    },

    "cache:refresh": async () => {
      ctx.refreshCache().catch(() => {});
      return { ok: true, message: "refresh started" };
    },

    "branch:enrich": async (payload) => {
      const branch    = payload?.branch    as string;
      const repoPath  = payload?.repoPath  as string;
      const remoteUrl = payload?.remoteUrl as string | undefined;

      if (!branch) return { ok: false, error: "missing branch" };

      if (ctx.cache.entries[branch]) {
        return { ok: true, data: ctx.cache.entries[branch], source: "cache" };
      }

      if (!repoPath) return { ok: false, error: "missing repoPath for cold enrichment" };

      try {
        const { enrichBranches } = await import("../../enrich.ts");
        await enrichBranches([{ path: repoPath, branch }], remoteUrl, { silent: true });

        ctx.loadCache();

        if (ctx.cache.entries[branch]) {
          return { ok: true, data: ctx.cache.entries[branch], source: "fresh" };
        }
        return { ok: true, data: null, source: "empty" };
      } catch (err) {
        return { ok: false, error: `enrichment failed: ${err}` };
      }
    },
  };
}
