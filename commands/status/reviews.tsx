/**
 * Reviews sub-view and per-reviewer comment threads — reviewer summaries
 * (assigned + drive-by commenters), file-grouped discussion threads, the
 * split-pane comment view, and the inline reply composer.
 */

import { Box, Text } from "ink";
import { Spinner, StatusMessage } from "@inkjs/ui";
import type { Discussion, MRDashboardProps, Reviewer, ReviewerSummary } from "@mattstack/glance";
import { getReviewDisplayState, getReviewerSummaries } from "@mattstack/glance";
import { timeAgo } from "../../lib/tui/utils/label.ts";
import type { ActionState } from "./types.ts";
import { Markdown } from "./markdown.tsx";

// ─── Reviews Sub-View ───────────────────────────────────────────────────────

export interface DiscussionsState {
  /** iid this snapshot is for, so cross-MR stale data can't leak into the view. */
  iid:         number | null;
  loading:     boolean;
  error:       string | null;
  discussions: Discussion[] | null;
  fetchedAt:   number | null;
}

export const INITIAL_DISCUSSIONS_STATE: DiscussionsState = {
  iid: null,
  loading: false,
  error: null,
  discussions: null,
  fetchedAt: null,
};

/**
 * Combine assigned reviewers with anyone else who authored a comment thread.
 * The sdk's `getReviewerSummaries` only covers assigned reviewers; we add
 * synthesized rows for drive-by commenters (a GitLab reality — any participant
 * can leave review comments without being formally assigned).
 *
 * Threads with no human notes (pure GitLab system actions like resolve toggles
 * or label changes) are filtered out — they aren't comments.
 *
 * MR author is excluded — their own notes aren't reviews.
 */
/**
 * GitLab SDK uses two scoped ID formats:
 *   MRDashboardProps.author.id  → "gitlab:<numeric>"
 *   NoteAuthor.id (discussions) → "gitlab:user:<numeric>"
 * Strip everything except the trailing numeric segment for comparisons.
 */
function numericGitLabId(id: string): string {
  return id.split(":").pop() ?? id;
}

export function buildAllCommenterSummaries(
  mr: MRDashboardProps,
  discussions: Discussion[],
): ReviewerSummary[] {
  const userDiscussions = discussions.filter((d) => d.notes.some((n) => !n.system));

  const assigned = getReviewerSummaries({ reviewers: mr.reviews.reviewers }, userDiscussions);
  const assignedNums = new Set(assigned.map((s) => numericGitLabId(s.reviewer.id)));
  const authorNum = numericGitLabId(mr.author.id);

  const extras = new Map<string, { reviewer: Reviewer; threads: Discussion[] }>();
  for (const disc of userDiscussions) {
    for (const note of disc.notes) {
      if (note.system) continue;
      const num = numericGitLabId(note.author.id);
      if (assignedNums.has(num)) continue;
      if (num === authorNum) continue;
      if (/^group_\d+_bot_/.test(note.author.username)) continue;

      let entry = extras.get(num);
      if (!entry) {
        entry = {
          reviewer: {
            id:           note.author.id,
            username:     note.author.username,
            name:         note.author.name,
            avatarUrl:    note.author.avatarUrl,
            reviewState:  null,
          },
          threads: [],
        };
        extras.set(num, entry);
      }
      if (!entry.threads.some((t) => t.id === disc.id)) entry.threads.push(disc);
    }
  }

  const extraSummaries: ReviewerSummary[] = [];
  for (const { reviewer, threads } of extras.values()) {
    extraSummaries.push({ reviewer, commentCount: threads.length, discussions: threads });
  }

  return [...assigned, ...extraSummaries];
}

const REVIEW_STATE_LABEL: Record<string, string> = {
  approved:          "Approved",
  commented:         "Commented",
  changes_requested: "Requested changes",
  reviewing:         "Reviewing",
  awaiting_review:   "Awaiting",
};

const REVIEW_STATE_COLOR: Record<string, string> = {
  approved:          "green",
  commented:         "cyan",
  changes_requested: "red",
  reviewing:         "yellow",
  awaiting_review:   "gray",
};

function reviewerStateText(summary: ReviewerSummary): { label: string; color: string } {
  // Assigned reviewers have a reviewState; drive-by commenters get "Commented".
  if (summary.reviewer.reviewState) {
    const display = getReviewDisplayState(summary.reviewer.reviewState);
    return { label: REVIEW_STATE_LABEL[display] ?? display, color: REVIEW_STATE_COLOR[display] ?? "gray" };
  }
  return { label: "Commented", color: "cyan" };
}

function resolvedSummary(threads: Discussion[]): string | null {
  const resolvable = threads.filter((t) => t.resolvable);
  if (resolvable.length === 0) return null;
  const resolved = resolvable.filter((t) => t.resolved).length;
  if (resolved === resolvable.length) return "all resolved";
  return `${resolved}/${resolvable.length} resolved`;
}

function ReviewerRow({
  summary,
  focused,
}: {
  summary: ReviewerSummary;
  focused: boolean;
}) {
  const { label, color } = reviewerStateText(summary);
  const n = summary.commentCount;
  const commentLabel = n === 0 ? "No comments" : `${n} comment${n === 1 ? "" : "s"}`;
  const resolved = resolvedSummary(summary.discussions);

  return (
    <Box gap={1}>
      <Text color={focused ? "cyan" : undefined}>{focused ? "▸" : " "}</Text>
      <Text bold={focused}>{summary.reviewer.username || summary.reviewer.name}</Text>
      <Text dimColor>/</Text>
      <Text color={color}>{label}</Text>
      <Text dimColor>/</Text>
      <Text dimColor>{commentLabel}</Text>
      {resolved && (
        <>
          <Text dimColor>·</Text>
          <Text dimColor>({resolved})</Text>
        </>
      )}
    </Box>
  );
}

export function ReviewsView({
  mr,
  state,
  focusedReviewerIndex,
  summaries,
}: {
  mr: MRDashboardProps;
  state: DiscussionsState;
  focusedReviewerIndex: number;
  summaries: ReviewerSummary[];
}) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* Header */}
      <Box gap={1} marginBottom={1}>
        <Text dimColor>!{mr.iid}</Text>
        <Text dimColor>·</Text>
        <Text bold>Reviews</Text>
        {state.loading && <Spinner label="loading discussions" />}
      </Box>

      {state.error && (
        <Box marginBottom={1}>
          <StatusMessage variant="error">{state.error}</StatusMessage>
        </Box>
      )}

      {!state.loading && !state.error && summaries.length === 0 && (
        <Text dimColor>No reviewers or comments yet.</Text>
      )}

      {summaries.map((s, i) => (
        <ReviewerRow
          key={s.reviewer.id}
          summary={s}
          focused={i === focusedReviewerIndex}
        />
      ))}
    </Box>
  );
}

// ─── Inline reply input ──────────────────────────────────────────────────────

function ReplyInputBox({ value }: { value: string }) {
  const lines = (value + "█").split("\n");
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderColor="cyan">
      <Text dimColor>enter send · ctrl+j newline · esc cancel</Text>
      {lines.map((line, i) => <Text key={i}>{line}</Text>)}
    </Box>
  );
}

// ─── Diff hunk view ──────────────────────────────────────────────────────────

function DiffHunkView({ hunk }: { hunk: string }) {
  const lines = hunk.split("\n");
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginBottom={1}>
      {lines.map((line, i) => {
        const color = line.startsWith("+") ? "green"
          : line.startsWith("-") ? "red"
          : line.startsWith("@@") ? "cyan"
          : undefined;
        const dim = line.startsWith("@@");
        return <Text key={i} color={color} dimColor={dim}>{line}</Text>;
      })}
    </Box>
  );
}

// ─── Comment Thread View ────────────────────────────────────────────────────

export interface FileGroup {
  /** Display label — file path or "General" for un-anchored threads. */
  path:    string;
  threads: Discussion[];
}

/**
 * Group the discussions authored by one reviewer by file path. Threads whose
 * first note has no position land in a synthetic "General" bucket at the top,
 * matching how GitLab surfaces MR-level vs. line-anchored comments.
 */
export function groupThreadsByFile(threads: Discussion[]): FileGroup[] {
  const general: Discussion[] = [];
  const byFile = new Map<string, Discussion[]>();

  for (const thread of threads) {
    const firstWithPos = thread.notes.find((n) => n.position);
    const path = firstWithPos?.position?.newPath ?? firstWithPos?.position?.oldPath ?? null;
    if (!path) {
      general.push(thread);
      continue;
    }
    const list = byFile.get(path) ?? [];
    list.push(thread);
    byFile.set(path, list);
  }

  const groups: FileGroup[] = [];
  if (general.length > 0) groups.push({ path: "General", threads: general });
  for (const [path, threads] of byFile) groups.push({ path, threads });
  return groups;
}

/**
 * Collapse long paths to their last few segments so the sidebar stays readable.
 * Returns the original string for "General" or paths already short enough.
 */
function shortenPath(p: string, maxSegments = 2): string {
  if (!p.includes("/")) return p;
  const parts = p.split("/");
  if (parts.length <= maxSegments) return p;
  return `…/${parts.slice(-maxSegments).join("/")}`;
}

function FileSidebar({
  groups,
  focusedFileIndex,
}: {
  groups: FileGroup[];
  focusedFileIndex: number;
}) {
  return (
    <Box flexDirection="column" width="30%" paddingRight={1} flexShrink={0}>
      <Text dimColor>Files</Text>
      {groups.map((g, i) => {
        const focused = i === focusedFileIndex;
        const count = g.threads.length;
        return (
          <Box key={g.path} gap={1}>
            <Text color={focused ? "cyan" : undefined}>{focused ? "▸" : " "}</Text>
            <Box flexGrow={1} overflow="hidden">
              <Text bold={focused} wrap="truncate-start">{shortenPath(g.path, 1)}</Text>
            </Box>
            <Text dimColor>[{count}]</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function ThreadBody({ thread }: { thread: Discussion }) {
  const nonSystem = thread.notes.filter((n) => !n.system);
  if (nonSystem.length === 0) {
    return <Text dimColor>System-only thread.</Text>;
  }
  return (
    <Box flexDirection="column">
      {nonSystem.map((note, i) => (
        <Box key={note.id} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
          <Box gap={1}>
            <Text bold color="cyan">@{note.author.username}</Text>
            <Text dimColor>·</Text>
            <Text dimColor>{timeAgo(note.createdAt)}</Text>
            {i === 0 && note.position?.newLine && (
              <>
                <Text dimColor>·</Text>
                <Text dimColor>L{note.position.newLine}</Text>
              </>
            )}
          </Box>
          <Markdown>{note.body}</Markdown>
        </Box>
      ))}
    </Box>
  );
}

export function CommentView({
  mr,
  reviewerName,
  groups,
  focusedFileIndex,
  focusedThreadIndex,
  actionState,
  replyDraft,
  diffHunk,
  diffsLoading,
}: {
  mr: MRDashboardProps;
  reviewerName: string;
  groups: FileGroup[];
  focusedFileIndex: number;
  focusedThreadIndex: number;
  actionState: ActionState;
  replyDraft: string | null;
  diffHunk: string | null;
  diffsLoading: boolean;
}) {
  const group = groups[focusedFileIndex];
  const thread = group?.threads[focusedThreadIndex];
  const threadCount = group?.threads.length ?? 0;
  const resolved = thread?.resolved === true;
  const resolvable = thread?.resolvable === true;

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* Header */}
      <Box gap={1} marginBottom={1}>
        <Text dimColor>!{mr.iid}</Text>
        <Text dimColor>·</Text>
        <Text bold>Comments from {reviewerName}</Text>
      </Box>

      {groups.length === 0 ? (
        <Text dimColor>No comments from this reviewer.</Text>
      ) : (
        <Box flexDirection="row">
          <FileSidebar groups={groups} focusedFileIndex={focusedFileIndex} />

          {/* Right pane */}
          <Box flexDirection="column" flexGrow={1} paddingLeft={1} borderStyle="single" borderLeft paddingRight={1} overflow="hidden">
            {/* Chrome */}
            <Box gap={1}>
              <Box flexGrow={1} overflow="hidden">
                <Text bold wrap="truncate-start">{group?.path}</Text>
              </Box>
              <Text dimColor>/</Text>
              <Text dimColor>💬 {threadCount > 0 ? focusedThreadIndex + 1 : 0}/{threadCount}</Text>
              {resolvable && (
                <>
                  <Text dimColor>·</Text>
                  <Text color={resolved ? "green" : "yellow"}>
                    {resolved ? "resolved" : "unresolved"}
                  </Text>
                </>
              )}
            </Box>

            {diffsLoading && (
              <Box marginTop={1}>
                <Text dimColor>loading diff…</Text>
              </Box>
            )}
            {!diffsLoading && diffHunk && (
              <Box marginTop={1}>
                <DiffHunkView hunk={diffHunk} />
              </Box>
            )}
            <Box marginTop={1}>
              {thread ? <ThreadBody thread={thread} /> : <Text dimColor>No thread.</Text>}
            </Box>

            {replyDraft !== null && <ReplyInputBox value={replyDraft} />}
            {actionState.loading && (
              <Box marginTop={1}>
                <Spinner label={actionState.loading} />
              </Box>
            )}
            {actionState.result && (
              <Box marginTop={1}>
                <StatusMessage variant={actionState.result.ok ? "success" : "error"}>
                  {actionState.result.message}
                </StatusMessage>
              </Box>
            )}
            {actionState.confirm && (
              <Box marginTop={1}>
                <Text color="yellow" bold>press [{actionState.confirm.key}] again to confirm</Text>
              </Box>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
