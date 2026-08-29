/**
 * Discussions fetch + cache + diff for the daemon.
 *
 * Shared by `handlers/discussions.ts` (on-demand reads from the UI) and
 * `discussions-poller.ts` (periodic sweep that surfaces new comments as
 * notifications).
 *
 * Snapshots live in `~/.mattstack/rt/discussions.json` (see `discussions-file-store.ts`),
 * keyed `repo:iid` — not on the branch-cache entry, so a teammate's MR (no
 * branch entry of its own) still has a home. MR metadata for titles/webUrl/
 * author/terminal-state resolves branch entry first, then the project store.
 *
 * On every refresh this module:
 *   1. Captures the previously-stored note IDs for the MR.
 *   2. Fetches the current discussions snapshot from GitLab.
 *   3. Writes the snapshot to the discussions file store.
 *   4. Broadcasts `discussions:update`.
 *   5. If any new non-system notes appeared from someone other than the
 *      current user, broadcasts `discussions:new-comments` with per-note
 *      metadata AND a generic `notification` event so any connected tray
 *      / desktop surface can pick it up.
 */

import type { Discussion, Note } from "@mattstack/glance";
import { getRepoContext, getCurrentUserId } from "./freshness.ts";
import { getDiscussionsFileStore, type DiscussionsFileStore } from "./discussions-file-store.ts";
import { getProjectMRs, type ProjectMRs } from "./project-mrs-store.ts";
import type { HandlerContext } from "./handlers/types.ts";
import { notifyEnabled } from "../notifier.ts";
import { numericUserId, MR_TERMINAL_STATES } from "../enrich.ts";

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

export interface MRMeta {
  title:           string;
  webUrl:          string | null;
  authorNumericId: number | null;
  terminal:        boolean;
}

const BOT_USERNAME = /^(?:project|group)_\d+_bot_/;
const isBot = (n: Note) => BOT_USERNAME.test(n.author.username ?? "");

/**
 * MR metadata for notifications and terminal-state checks: branch entry
 * first (it carries the enriched mr-info shape), then the project store
 * (raw PullRequest shape). Null when the MR is in neither store — callers
 * refuse rather than blind-fetch, so ungranted repos can't leak API calls.
 */
export function resolveMRMeta(
  ctx: HandlerContext,
  repoName: string,
  iid: number,
  projectStore: ProjectMRs = getProjectMRs(),
): MRMeta | null {
  for (const entry of Object.values(ctx.cache.entries)) {
    if (entry.repoName === repoName && entry.mr?.iid === iid) {
      return {
        title:           entry.mr.title ?? `!${iid}`,
        webUrl:          entry.mr.webUrl ?? null,
        authorNumericId: numericUserId(entry.mr.author?.id),
        terminal:        MR_TERMINAL_STATES.has(entry.mr.status),
      };
    }
  }
  const rec = projectStore.read(repoName)?.mrs[iid];
  if (rec) {
    return {
      title:           rec.pr.title ?? `!${iid}`,
      webUrl:          rec.pr.webUrl ?? null,
      authorNumericId: numericUserId(rec.pr.author?.id),
      terminal:        MR_TERMINAL_STATES.has(rec.pr.state),
    };
  }
  return null;
}

export interface RefreshOverrides {
  fetchDiscussions?: (repoName: string, iid: number) => Promise<Discussion[]>;
  fileStore?:        DiscussionsFileStore;
  projectStore?:     ProjectMRs;
  currentUserId?:    number | null;
  /** Test seam: the real emitter queues to disk and pokes the tray socket. */
  notify?:           (category: string, title: string, message: string, url?: string) => void;
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
  isMrAuthor: boolean,
): NewCommentNote[] {
  // Compare numeric tails, not raw strings: note authors arrive scoped as
  // "gitlab:user:N" while currentUserId is bare numeric.
  const isSelf = (n: Note) =>
    currentUserId !== null && numericUserId(n.author.id) === currentUserId;
  const out: NewCommentNote[] = [];
  for (const d of nextDiscussions) {
    // Only surface comments on MRs I authored, or in threads I'm a participant
    // in (I've posted at least one note). A teammate's MR pulled down for
    // review is in this cache too — its unrelated threads must stay silent.
    const involved = d.notes.some(isSelf);
    if (!isMrAuthor && !involved) continue;
    for (const n of d.notes) {
      if (n.system) continue;
      if (prev.has(n.id)) continue;
      if (isSelf(n)) continue;
      if (isBot(n)) continue;
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
 * Fetch discussions for a single MR, persist to the discussions file store,
 * broadcast update, and return a diff describing any new non-user notes.
 * The branch cache is NOT written and NOT flushed here — discussions live
 * only in the file store now.
 *
 * The first-ever fetch for an MR is silent — otherwise every MR would fire a
 * storm of "new comment" events on daemon startup.
 */
export async function refreshDiscussions(
  deps: RefreshDeps,
  repoName: string,
  iid: number,
  overrides: RefreshOverrides = {},
): Promise<RefreshResult> {
  const fileStore = overrides.fileStore ?? getDiscussionsFileStore();
  const meta = resolveMRMeta(deps.ctx, repoName, iid, overrides.projectStore);
  if (!meta) throw new Error(`MR not cached: ${repoName}#${iid}`);

  const prevEntry = fileStore.read(repoName, iid);
  const isFirstFetch = prevEntry === undefined;
  const prevIds = collectNoteIds(prevEntry?.discussions);

  const fetchDiscussions = overrides.fetchDiscussions ?? (async (repo: string, mrIid: number) => {
    const repoPath = deps.ctx.repoIndex()[repo];
    const repoCtx = await getRepoContext(repo, repoPath);
    const detail = await repoCtx.provider.fetchMRDiscussions(`gitlab:${repoCtx.projectId}`, mrIid);
    return detail.discussions;
  });
  const discussions = await fetchDiscussions(repoName, iid);

  const fetchedAt = Date.now();
  fileStore.write(repoName, iid, { discussions, fetchedAt });

  deps.broadcast("discussions:update", {
    repoName,
    iid,
    discussions,
    fetchedAt,
  });

  const currentUserId = overrides.currentUserId !== undefined ? overrides.currentUserId : getCurrentUserId();
  const isMrAuthor = currentUserId !== null && meta.authorNumericId === currentUserId;
  const newNotes = isFirstFetch
    ? []
    : collectNewNotes(prevIds, discussions, currentUserId, isMrAuthor);

  if (newNotes.length > 0) {
    const mrTitle = meta.title;
    const webUrl  = meta.webUrl;

    deps.broadcast("discussions:new-comments", {
      repoName,
      iid,
      mrTitle,
      webUrl,
      newNotes,
    });

    // Companion generic notification event for any tray/desktop surface.
    // Routed through notify() rather than broadcast directly: that is what
    // puts it in the durable queue, on the tray socket, and under a
    // preference key. A bare broadcast reached WebSocket clients only, in a
    // payload shape no other notification used.
    const first = newNotes[0]!;
    const preview = first.body.split("\n")[0]!.slice(0, 140);
    const extra = newNotes.length > 1 ? ` (+${newNotes.length - 1} more)` : "";
    (overrides.notify ?? notifyEnabled)(
      "new_comment",
      `New comment on !${iid}`,
      `@${first.authorUser}: ${preview}${extra}`,
      webUrl ?? undefined,
    );
  }

  return { discussions, fetchedAt, newNotes };
}

export const __test__ = { MR_TERMINAL_STATES };
