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
 *
 * `repoName` is opaque here — it flows straight into `grants()`, the
 * discussions table, and `getRepoContext`. It becomes the serialized repo
 * identity once every caller sends one; this module makes no assumption
 * about its shape.
 */

import { NoteMutator } from "@mattstack/glance";
import { parseIdentity } from "../../settings/identity.ts";
import { getRepoContext, providerRequestHook } from "../freshness.ts";
import { loadSecrets } from "../../linear.ts";
import { refreshDiscussions, type BroadcastFn } from "../discussions-store.ts";
import { getDiscussionsFileStore } from "../discussions-file-store.ts";
import { grants, loadRepoTracking } from "../../repo-tracking.ts";
import type { HandlerContext, HandlerMap, TypedHandlers } from "./types.ts";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";

/** Discussions are stable per push; 2min TTL keeps reads fast without going stale. */
const DISCUSSIONS_TTL_MS = 2 * 60 * 1000;

/** GitLab's page size for this endpoint; a full page means there may be more. */
const DIFFS_PAGE_SIZE = 100;
const DIFFS_FETCH_TIMEOUT_MS = 30_000;

/**
 * Every other outbound fetch in the daemon carries a bound (linear.ts,
 * notifier.ts, park.ts); this one previously had none, so a stalled GitLab
 * connection left the promise (and the sops-decrypted token in its closure)
 * pending indefinitely. `reqSignal` is the client's own request signal
 * (handlers/types.ts's Handler(payload, signal?)) so a client giving up
 * actually cancels the in-flight GitLab request instead of orphaning it.
 * `truncated` reports a full page rather than silently dropping files past it.
 */
export async function fetchMrDiffs(
  baseURL: string,
  projectPath: string,
  iid: number,
  token: string,
  opts: { reqSignal?: AbortSignal; fetchFn?: typeof fetch } = {},
): Promise<{ diffs: Array<{ newPath: string; diff: string }>; truncated: boolean }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const encoded = encodeURIComponent(projectPath);
  const url = `${baseURL}/api/v4/projects/${encoded}/merge_requests/${iid}/diffs?per_page=${DIFFS_PAGE_SIZE}`;
  const timeout = AbortSignal.timeout(DIFFS_FETCH_TIMEOUT_MS);
  const signal = opts.reqSignal ? AbortSignal.any([timeout, opts.reqSignal]) : timeout;
  const res = await fetchFn(url, { headers: { "PRIVATE-TOKEN": token }, signal });
  if (!res.ok) throw new Error(`GitLab diffs API: ${res.status}`);
  const raw = (await res.json()) as Array<{ new_path: string; diff: string }>;
  return {
    diffs: raw.map((d) => ({ newPath: d.new_path, diff: d.diff })),
    truncated: raw.length >= DIFFS_PAGE_SIZE,
  };
}

export function createDiscussionHandlers(
  ctx: HandlerContext,
  broadcast: BroadcastFn,
): Pick<TypedHandlers, "discussions:read"> & HandlerMap {
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
      // Hard cutover: the discussions table is identity-keyed now;
      // a bare legacy name resolves nothing rather than reading a row that
      // no longer exists under that key.
      if (parseIdentity(repoName) === null) {
        return { ok: true, data: { discussions: [], fetchedAt: 0, stale: true } };
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
      if (parseIdentity(repoName) === null) {
        return { ok: false, error: "repo must be a serialized identity" };
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
      if (parseIdentity(repoName) === null) {
        return { ok: false, error: "repo must be a serialized identity" };
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

    "discussions:diffs": async (payload, signal) => {
      const repoName = payload?.repoName as string | undefined;
      const iid      = payload?.iid      as number | undefined;
      if (!repoName || typeof iid !== "number") {
        return { ok: false, error: "missing repoName/iid" };
      }
      if (parseIdentity(repoName) === null) {
        return { ok: false, error: "repo must be a serialized identity" };
      }

      const repoPath = ctx.repoIndex()[repoName];
      try {
        const repoCtx = await getRepoContext(repoName, repoPath);
        const secrets = await loadSecrets();
        if (!secrets.gitlabToken) return { ok: false, error: "no gitlabToken in secrets" };

        const { diffs, truncated } = await fetchMrDiffs(
          repoCtx.provider.baseURL,
          repoCtx.projectPath,
          iid,
          secrets.gitlabToken,
          { reqSignal: signal },
        );
        return { ok: true, data: { diffs, truncated } };
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
      if (parseIdentity(repoName) === null) {
        return { ok: false, error: "repo must be a serialized identity" };
      }

      const repoPath = ctx.repoIndex()[repoName];
      try {
        const repoCtx = await getRepoContext(repoName, repoPath);
        const secrets = await loadSecrets();
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
