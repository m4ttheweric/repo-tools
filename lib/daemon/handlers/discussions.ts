/**
 * Discussion IPC handlers — thread/note reads and mutations for the MR
 * status sub-view. Like `mr:action`, every call routes through the daemon so
 * it owns the single authoritative GitLabProvider per repo.
 *
 *   discussions:read     — return cached discussions, lazy-fetch on miss/stale
 *   discussions:refresh  — force re-fetch from GitLab
 *   discussions:resolve  — toggle resolved state on a thread
 *   discussions:reply    — post a note into an existing thread
 *
 * All handlers take `{ repoName, iid }` and look up the cache entry whose
 * `mr.iid` matches. Writes go through `refreshDiscussions` in
 * `discussions-store.ts`, which also emits new-comment notifications.
 */

import { NoteMutator } from "@workforge/glance-sdk";
import { getRepoContext } from "../mr-subscriptions.ts";
import { loadSecrets } from "../../linear.ts";
import { refreshDiscussions, type BroadcastFn } from "../discussions-store.ts";
import type { HandlerContext, HandlerMap, CacheEntry } from "./types.ts";

/** Discussions are stable per push; 2min TTL keeps reads fast without going stale. */
const DISCUSSIONS_TTL_MS = 2 * 60 * 1000;

function findEntry(
  ctx: HandlerContext,
  repoName: string,
  iid: number,
): { branch: string; entry: CacheEntry } | null {
  for (const [branch, entry] of Object.entries(ctx.cache.entries)) {
    if (entry.repoName === repoName && entry.mr?.iid === iid) {
      return { branch, entry };
    }
  }
  return null;
}

export function createDiscussionHandlers(
  ctx: HandlerContext,
  broadcast: BroadcastFn,
): HandlerMap {
  const deps = { ctx, broadcast };

  return {
    "discussions:read": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const iid      = payload?.iid      as number | undefined;
      const force    = payload?.force === true;

      if (!repoName || typeof iid !== "number") {
        return { ok: false, error: "missing repoName/iid" };
      }

      const hit = findEntry(ctx, repoName, iid);
      if (!hit) return { ok: false, error: `no cache entry for ${repoName}#${iid}` };

      const fresh =
        !force &&
        hit.entry.discussions !== undefined &&
        hit.entry.discussionsFetchedAt !== undefined &&
        Date.now() - hit.entry.discussionsFetchedAt < DISCUSSIONS_TTL_MS;

      if (fresh) {
        return {
          ok: true,
          data: {
            discussions: hit.entry.discussions,
            fetchedAt:   hit.entry.discussionsFetchedAt,
            stale:       false,
          },
        };
      }

      try {
        const res = await refreshDiscussions(deps, repoName, iid);
        return { ok: true, data: { discussions: res.discussions, fetchedAt: res.fetchedAt, stale: false } };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    "discussions:refresh": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const iid      = payload?.iid      as number | undefined;
      if (!repoName || typeof iid !== "number") {
        return { ok: false, error: "missing repoName/iid" };
      }
      try {
        const res = await refreshDiscussions(deps, repoName, iid);
        return { ok: true, data: { discussions: res.discussions, fetchedAt: res.fetchedAt } };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    "discussions:resolve": async (payload) => {
      const repoName      = payload?.repoName      as string | undefined;
      const iid           = payload?.iid           as number | undefined;
      const discussionId  = payload?.discussionId  as string | undefined;
      const resolved      = payload?.resolved !== false; // default: mark resolved

      if (!repoName || typeof iid !== "number" || !discussionId) {
        return { ok: false, error: "missing repoName/iid/discussionId" };
      }

      const repoPath = ctx.repoIndex()[repoName];
      try {
        const repoCtx = await getRepoContext(repoName, repoPath);
        if (resolved) {
          await repoCtx.provider.resolveDiscussion(repoCtx.projectPath, iid, discussionId);
        } else {
          await repoCtx.provider.unresolveDiscussion(repoCtx.projectPath, iid, discussionId);
        }
        const res = await refreshDiscussions(deps, repoName, iid);
        return { ok: true, data: { discussions: res.discussions, fetchedAt: res.fetchedAt } };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    "discussions:reply": async (payload) => {
      const repoName     = payload?.repoName     as string | undefined;
      const iid          = payload?.iid          as number | undefined;
      const discussionId = payload?.discussionId as string | undefined;
      const body         = payload?.body         as string | undefined;

      if (!repoName || typeof iid !== "number" || !discussionId || !body?.trim()) {
        return { ok: false, error: "missing repoName/iid/discussionId/body" };
      }

      const repoPath = ctx.repoIndex()[repoName];
      try {
        const repoCtx = await getRepoContext(repoName, repoPath);
        const secrets = loadSecrets();
        if (!secrets.gitlabToken) return { ok: false, error: "no gitlabToken in secrets" };
        const mutator = new NoteMutator(repoCtx.provider.baseURL, secrets.gitlabToken);
        await mutator.createNote(repoCtx.projectId, iid, body, discussionId);
        const res = await refreshDiscussions(deps, repoName, iid);
        return { ok: true, data: { discussions: res.discussions, fetchedAt: res.fetchedAt } };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  };
}
