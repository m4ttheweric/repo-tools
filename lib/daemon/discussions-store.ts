/**
 * Discussions fetch + cache + diff for the daemon.
 *
 * Shared by `handlers/discussions.ts` (on-demand reads from the UI) and
 * `discussions-poller.ts` (periodic sweep that surfaces new comments as
 * notifications).
 *
 * On every refresh this module:
 *   1. Captures the previously-cached note IDs for the MR.
 *   2. Fetches the current discussions snapshot from GitLab.
 *   3. Writes the snapshot to the cache entry + flushes to disk.
 *   4. Broadcasts `discussions:update`.
 *   5. If any new non-system notes appeared from someone other than the
 *      current user, broadcasts `discussions:new-comments` with per-note
 *      metadata AND a generic `notification` event so any connected tray
 *      / desktop surface can pick it up.
 */

import type { Discussion, Note } from "@workforge/glance-sdk";
import { getRepoContext, getCurrentUserId } from "./mr-subscriptions.ts";
import type { HandlerContext, CacheEntry } from "./handlers/types.ts";

export type BroadcastFn = (type: string, data: any) => void;

export interface RefreshDeps {
  ctx:       HandlerContext;
  broadcast: BroadcastFn;
}

export interface NewCommentNote {
  noteId:     number;
  authorName: string;
  authorUser: string;
  body:       string;
  createdAt:  string;
}

export interface RefreshResult {
  discussions: Discussion[];
  fetchedAt:   number;
  newNotes:    NewCommentNote[];
}

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

/**
 * Collect the set of non-system note IDs across a discussion list so we can
 * compare two snapshots.
 */
function collectNoteIds(discussions: Discussion[] | undefined): Set<number> {
  const ids = new Set<number>();
  if (!discussions) return ids;
  for (const d of discussions) {
    for (const n of d.notes) {
      if (!n.system) ids.add(n.id);
    }
  }
  return ids;
}

/**
 * Flatten notes into the (note, thread) pairs the poller cares about, with
 * the thread retained so callers can deep-link.
 */
function collectNewNotes(
  prev: Set<number>,
  nextDiscussions: Discussion[],
  currentUserId: number | null,
): NewCommentNote[] {
  const selfAuthorId = currentUserId !== null ? `gitlab:${currentUserId}` : null;
  const out: NewCommentNote[] = [];
  for (const d of nextDiscussions) {
    for (const n of d.notes) {
      if (n.system) continue;
      if (prev.has(n.id)) continue;
      if (selfAuthorId && n.author.id === selfAuthorId) continue;
      out.push(buildNewNote(n));
    }
  }
  return out;
}

function buildNewNote(n: Note): NewCommentNote {
  return {
    noteId:     n.id,
    authorName: n.author.name,
    authorUser: n.author.username,
    body:       n.body,
    createdAt:  n.createdAt,
  };
}

/**
 * Fetch discussions for a single MR, persist to cache, broadcast update, and
 * return a diff describing any new non-user notes.
 *
 * `silentFirstFetch` suppresses new-comment notifications when this is the
 * first time we've ever seen discussions for the MR — otherwise every MR
 * would fire a storm of "new comment" events on daemon startup.
 */
export async function refreshDiscussions(
  deps: RefreshDeps,
  repoName: string,
  iid: number,
): Promise<RefreshResult> {
  const hit = findEntry(deps.ctx, repoName, iid);
  if (!hit) throw new Error(`no cache entry for ${repoName}#${iid}`);

  const repoPath = deps.ctx.repoIndex()[repoName];
  const repoCtx = await getRepoContext(repoName, repoPath);

  const isFirstFetch = hit.entry.discussions === undefined;
  const prevIds = collectNoteIds(hit.entry.discussions);

  const scopedRepoId = `gitlab:${repoCtx.projectId}`;
  const detail = await repoCtx.provider.fetchMRDiscussions(scopedRepoId, iid);

  const fetchedAt = Date.now();
  deps.ctx.cache.entries[hit.branch] = {
    ...hit.entry,
    discussions: detail.discussions,
    discussionsFetchedAt: fetchedAt,
  };
  deps.ctx.flushCache();

  deps.broadcast("discussions:update", {
    repoName,
    iid,
    discussions: detail.discussions,
    fetchedAt,
  });

  const newNotes = isFirstFetch
    ? []
    : collectNewNotes(prevIds, detail.discussions, getCurrentUserId());

  if (newNotes.length > 0) {
    const mrTitle = hit.entry.mr?.title ?? `!${iid}`;
    const webUrl  = hit.entry.mr?.webUrl ?? null;

    deps.broadcast("discussions:new-comments", {
      repoName,
      iid,
      mrTitle,
      webUrl,
      newNotes,
    });

    // Companion generic notification event for any tray/desktop surface.
    const first = newNotes[0]!;
    const preview = first.body.split("\n")[0]!.slice(0, 140);
    const extra = newNotes.length > 1 ? ` (+${newNotes.length - 1} more)` : "";
    deps.broadcast("notification", {
      title: `New comment on !${iid}`,
      body:  `@${first.authorUser}: ${preview}${extra}`,
      webUrl,
      mrId:  `gitlab:mr:${iid}`,
    });
  }

  return { discussions: detail.discussions, fetchedAt, newNotes };
}
