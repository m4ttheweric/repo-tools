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

import { NoteMutator } from "@mattstack/glance";
import { getRepoContext, providerRequestHook } from "../freshness.ts";
import { loadSecrets } from "../../linear.ts";
import { refreshDiscussions, type BroadcastFn } from "../discussions-store.ts";
import { getDiscussionsFileStore } from "../discussions-file-store.ts";
import { grants, loadRepoTracking } from "../../repo-tracking.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";

/** Discussions are stable per push; 2min TTL keeps reads fast without going stale. */
const DISCUSSIONS_TTL_MS = 2 * 60 * 1000;

export function createDiscussionHandlers(
  ctx: HandlerContext,
  broadcast: BroadcastFn,
): HandlerMap {
  const deps = { ctx, broadcast };

  return {
    // `force` is a legacy daemon-client-only escape hatch (lib/daemon-client.ts),
    // not part of the typed rt-client catalog -- extended onto the base
    // payload type rather than added to Commands so the public contract
    // stays what rt-client actually sends.
    "discussions:read": async (
      payload: Commands["discussions:read"]["payload"] & { force?: boolean },
    ): Promise<{ ok: true; data: Commands["discussions:read"]["data"] } | { ok: false; error: string }> => {
      const repoName = payload?.repoName as string | undefined;
      const iid      = payload?.iid      as number | undefined;
      const force    = payload?.force === true;
      if (!repoName || typeof iid !== "number") {
        return { ok: false, error: "missing repoName/iid" };
      }

      const granted = grants(loadRepoTracking(), repoName).caches.has("discussions");
      const cached = getDiscussionsFileStore().read(repoName, iid);

      // Granted repos: events + sweep own freshness, a hit never refetches.
      // Ungranted repos: the 2-min TTL keeps on-demand reads honest.
      const fresh = !force && cached !== undefined &&
        (granted || Date.now() - cached.fetchedAt < DISCUSSIONS_TTL_MS);

      if (fresh) {
        return { ok: true, data: { discussions: cached.discussions, fetchedAt: cached.fetchedAt, stale: false } };
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

    "discussions:diffs": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const iid      = payload?.iid      as number | undefined;
      if (!repoName || typeof iid !== "number") {
        return { ok: false, error: "missing repoName/iid" };
      }

      const repoPath = ctx.repoIndex()[repoName];
      try {
        const repoCtx = await getRepoContext(repoName, repoPath);
        const secrets = loadSecrets();
        if (!secrets.gitlabToken) return { ok: false, error: "no gitlabToken in secrets" };

        const encoded = encodeURIComponent(repoCtx.projectPath);
        const url = `${repoCtx.provider.baseURL}/api/v4/projects/${encoded}/merge_requests/${iid}/diffs?per_page=100`;
        const res = await fetch(url, { headers: { "PRIVATE-TOKEN": secrets.gitlabToken } });
        if (!res.ok) return { ok: false, error: `GitLab diffs API: ${res.status}` };

        const raw = await res.json() as Array<{ new_path: string; diff: string }>;
        const diffs = raw.map((d) => ({ newPath: d.new_path, diff: d.diff }));
        return { ok: true, data: { diffs } };
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
        const mutator = new NoteMutator(repoCtx.provider.baseURL, secrets.gitlabToken, providerRequestHook());
        await mutator.createNote(repoCtx.projectId, iid, body, discussionId);
        const res = await refreshDiscussions(deps, repoName, iid);
        return { ok: true, data: { discussions: res.discussions, fetchedAt: res.fetchedAt } };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  };
}
