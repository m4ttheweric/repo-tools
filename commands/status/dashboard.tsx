/**
 * LiveDashboard — the top-level stateful component. Owns all view state,
 * daemon WebSocket subscription, MR action execution, and view routing;
 * keyboard handling lives in use-dashboard-input.ts.
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text } from "ink";
import { Badge, Spinner, StatusMessage } from "@inkjs/ui";
import { ScrollableList } from "../../lib/ScrollableList.tsx";
import type { Discussion, MRDashboardProps, Pipeline } from "@workforge/glance-sdk";
import {
  mrActions,
  subscribeToDaemon,
  fetchMRDiffs,
  type DaemonMRActions,
} from "../../lib/daemon-client.ts";
import type { ActionState, CacheEntry, JobTraceState, SortMode, StatusData } from "./types.ts";
import { cleanTraceLine, extractHunk } from "./format.ts";
import { MRRowTUI, MRDetailView } from "./mr-views.tsx";
import {
  buildAllCommenterSummaries,
  groupThreadsByFile,
  ReviewsView,
  CommentView,
  INITIAL_DISCUSSIONS_STATE,
  type DiscussionsState,
} from "./reviews.tsx";
import { PipelineDetailView, JobLogView } from "./pipeline.tsx";
import { useDashboardInput } from "./use-dashboard-input.ts";

export const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "dev"]);

export function LiveDashboard({
  initialData,
  iidToBranch,
}: {
  initialData: StatusData;
  iidToBranch: Map<number, { branch: string; entry: CacheEntry }>;
}) {
  const [data, setData] = useState<StatusData>(initialData);
  const [connection, setConnection] = useState("connecting");
  const [hasLiveData, setHasLiveData] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [detailView, setDetailView] = useState(false);
  const [reviewsView, setReviewsView] = useState(false);
  const [focusedReviewerIndex, setFocusedReviewerIndex] = useState(0);
  const [discussionsState, setDiscussionsState] = useState<DiscussionsState>(INITIAL_DISCUSSIONS_STATE);
  const [commentView, setCommentView] = useState(false);
  const [focusedReviewerId, setFocusedReviewerId] = useState<string | null>(null);
  const [focusedFileIndex, setFocusedFileIndex] = useState(0);
  const [focusedThreadIndex, setFocusedThreadIndex] = useState(0);
  const [commentToast, setCommentToast] = useState<{
    iid:    number;
    text:   string;
    shownAt: number;
  } | null>(null);
  const [pipelineView, setPipelineView] = useState(false);
  const [pipelineFromList, setPipelineFromList] = useState(false); // entered via p from list, skip card on esc
  const [jobLogView, setJobLogView] = useState(false);
  const [focusedJobIndex, setFocusedJobIndex] = useState(0);
  // Stack for drilling into child/downstream pipelines
  const [childPipelineStack, setChildPipelineStack] = useState<Array<{ pipeline: Pipeline; parentJobIndex: number }>>([]);
  // Set of job IDs that are bridge/trigger jobs (fetched when entering pipeline view)
  const [bridgeJobIds, setBridgeJobIds] = useState<Set<string>>(new Set());
  const [jobTrace, setJobTrace] = useState<JobTraceState>({ loading: false, lines: [], allLines: [], displayedFrom: 0, hasMore: false, followTail: false, prependedCount: 0 });
  const [logScrollOffset, setLogScrollOffset] = useState(0);
  const [mergedDays, setMergedDays] = useState(0); // 0=off, 1, 3, 7
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [replyDraft, setReplyDraft] = useState<string | null>(null);
  // null = not fetched yet; diffs=Map means success; diffs=null means fetch failed (degrade silently)
  const [mrDiffs, setMrDiffs] = useState<{ iid: number; diffs: Map<string, string> | null } | null>(null);
  // Build per-iid action facades synchronously from cache entries. Each facade
  // is a thin wrapper that round-trips through the daemon's `mr:action` IPC,
  // so the daemon's GitLabProvider is the only thing talking to upstream.
  const actionsMap = React.useMemo(() => {
    const m = new Map<number, DaemonMRActions>();
    for (const [iid, { entry }] of iidToBranch) {
      if (entry.repoName) m.set(iid, mrActions(entry.repoName, iid));
    }
    return m;
  }, [iidToBranch]);

  // Action state: loading, result feedback, confirmation
  const [actionState, setActionState] = useState<ActionState>({
    loading: null,
    result: null,
    confirm: null,
  });

  // Clear result after 3s
  useEffect(() => {
    if (actionState.result) {
      const t = setTimeout(() => setActionState((s) => ({ ...s, result: null })), 3000);
      return () => clearTimeout(t);
    }
  }, [actionState.result]);

  // Auto-dismiss new-comment toasts after 8s
  useEffect(() => {
    if (commentToast) {
      const t = setTimeout(() => setCommentToast(null), 8000);
      return () => clearTimeout(t);
    }
  }, [commentToast]);

  // Clear confirmation after 3s of inactivity
  useEffect(() => {
    if (actionState.confirm) {
      const t = setTimeout(() => setActionState((s) => ({ ...s, confirm: null })), 3000);
      return () => clearTimeout(t);
    }
  }, [actionState.confirm]);

  // Get sorted active branches
  const mergedMs = mergedDays * 24 * 60 * 60 * 1000;
  const activeBranches: [string, CacheEntry][] = [];
  for (const [branch, entry] of Object.entries(data.branches)) {
    if (!entry.mr) continue;
    // Closed MRs are never shown — they're terminal and uninteresting.
    if (entry.mr.status === "closed") continue;
    if (entry.mr.status === "merged") {
      if (mergedDays === 0) continue;
      const ts = entry.mr.createdAt ? new Date(entry.mr.createdAt).getTime() : (entry.fetchedAt || 0);
      if (Date.now() - ts > mergedMs) continue;
    }
    activeBranches.push([branch, entry]);
  }
  const STATUS_PRIORITY: Record<string, number> = {
    blocked: 0, mergeable: 1, draft: 2, merged: 3, closed: 4,
  };
  const PIPELINE_PRIORITY: Record<string, number> = {
    failed: 0, running: 1, pending: 2, success: 3, canceled: 4,
  };

  activeBranches.sort((a, b) => {
    const aMr = a[1].mr!;
    const bMr = b[1].mr!;
    switch (sortMode) {
      case "status": {
        const aP = STATUS_PRIORITY[aMr.status] ?? 99;
        const bP = STATUS_PRIORITY[bMr.status] ?? 99;
        return aP - bP;
      }
      case "pipeline": {
        const aP = PIPELINE_PRIORITY[aMr.pipeline?.status ?? ""] ?? 99;
        const bP = PIPELINE_PRIORITY[bMr.pipeline?.status ?? ""] ?? 99;
        return aP - bP;
      }
      case "approved": {
        const aR = aMr.reviews.remaining;
        const bR = bMr.reviews.remaining;
        if (aR !== bR) return bR - aR;
        return (aMr.reviews.given) - (bMr.reviews.given);
      }
      case "oldest": {
        const aD = aMr.createdAt ? new Date(aMr.createdAt).getTime() : 0;
        const bD = bMr.createdAt ? new Date(bMr.createdAt).getTime() : 0;
        return aD - bD;
      }
      default: {
        const aD = aMr.createdAt ? new Date(aMr.createdAt).getTime() : 0;
        const bD = bMr.createdAt ? new Date(bMr.createdAt).getTime() : 0;
        return bD - aD;
      }
    }
  });

  const focusedEntry = activeBranches[focusedIndex];
  const focusedMR = focusedEntry?.[1]?.mr;
  const focusedIid = focusedMR?.iid;
  const focusedActions = focusedIid ? actionsMap.get(focusedIid) : undefined;

  // Execute action with confirmation + spinner
  const executeAction = useCallback(
    async (key: string, label: string, loadingLabel: string, fn: () => Promise<void>) => {
      // Already confirming this action? Execute it
      if (actionState.confirm?.key === key) {
        setActionState({ loading: loadingLabel, result: null, confirm: null });
        try {
          await fn();
          setActionState({ loading: null, result: { ok: true, message: `${label} succeeded` }, confirm: null });
        } catch (e: any) {
          setActionState({ loading: null, result: { ok: false, message: e.message || `${label} failed` }, confirm: null });
        }
        return;
      }
      // First press: set confirmation
      setActionState((s) => ({
        ...s,
        confirm: { key, label, action: fn },
      }));
    },
    [actionState.confirm],
  );

  // Fetch MR diffs when entering the comment view; clear when leaving.
  useEffect(() => {
    if (!commentView) { setMrDiffs(null); return; }
    const repoName = focusedEntry?.[1]?.repoName;
    if (!focusedMR || !repoName) return;
    const iid = focusedMR.iid;
    fetchMRDiffs(repoName, iid)
      .then((list) => {
        const map = new Map<string, string>();
        for (const { newPath, diff } of list) map.set(newPath, diff);
        setMrDiffs({ iid, diffs: map });
      })
      .catch(() => { setMrDiffs({ iid, diffs: null }); });
  }, [commentView, focusedMR?.iid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Input handling
  // Open pipeline view (clears child stack and bridge state)
  const openPipelineView = useCallback(() => {
    setPipelineView(true);
    setFocusedJobIndex(0);
    setChildPipelineStack([]);
    setBridgeJobIds(new Set());
    setActionState({ loading: null, result: null, confirm: null });
  }, []);

  // Helper to fetch job trace
  const fetchTrace = useCallback(async (jobId: string) => {
    const numericId = parseInt(jobId.split(":").pop() || "0", 10);
    setJobTrace({ loading: true, lines: [], allLines: [], displayedFrom: 0, hasMore: false, followTail: false, prependedCount: 0 });
    setLogScrollOffset(0);
    try {
      const raw = await focusedActions!.fetchJobTrace(numericId);
      const allLines = raw.split("\n").map(cleanTraceLine);
      const displayedFrom = Math.max(0, allLines.length - 200);
      setJobTrace({
        loading: false,
        lines: allLines.slice(displayedFrom),
        allLines,
        displayedFrom,
        hasMore: displayedFrom > 0,
        followTail: true,
        prependedCount: 0,
      });
    } catch (e: any) {
      setJobTrace({ loading: false, error: e.message || "Failed to load trace", lines: [], allLines: [], displayedFrom: 0, hasMore: false, followTail: false, prependedCount: 0 });
    }
  }, [focusedActions]);

  // Load 200 more lines above the current window (viewport-stable: offset shifts by delta)
  const loadMoreTraceLines = useCallback(() => {
    setJobTrace(prev => {
      if (prev.displayedFrom === 0 || prev.loading) return prev;
      const newFrom = Math.max(0, prev.displayedFrom - 200);
      const delta = prev.displayedFrom - newFrom;
      return {
        ...prev,
        lines: prev.allLines.slice(newFrom),
        displayedFrom: newFrom,
        hasMore: newFrom > 0,
        followTail: false, // don't jump to bottom after prepend
        prependedCount: prev.prependedCount + delta,
      };
    });
  }, []);

  useDashboardInput({
    actionState, setActionState,
    setData,
    activeBranches, setFocusedIndex,
    focusedEntry, focusedMR, focusedActions,
    detailView, setDetailView,
    reviewsView, setReviewsView,
    focusedReviewerIndex, setFocusedReviewerIndex,
    discussionsState, setDiscussionsState,
    commentView, setCommentView,
    focusedReviewerId, setFocusedReviewerId,
    focusedFileIndex, setFocusedFileIndex,
    focusedThreadIndex, setFocusedThreadIndex,
    pipelineView, setPipelineView,
    pipelineFromList, setPipelineFromList,
    jobLogView, setJobLogView,
    focusedJobIndex, setFocusedJobIndex,
    childPipelineStack, setChildPipelineStack,
    setJobTrace,
    replyDraft, setReplyDraft,
    setMergedDays, setSortMode,
    executeAction, openPipelineView,
  });

  // Daemon WS subscription — the daemon owns the glance-sdk connection; we
  // just consume `mr:update` broadcasts and the aggregated `mr:status` flag.
  useEffect(() => {
    const sub = subscribeToDaemon((ev) => {
      if (ev.type === "mr:update") {
        const mrs = ev.data?.mrs as Record<string, MRDashboardProps> | undefined;
        if (!mrs) return;
        setData((prev) => {
          // Bail out early if every incoming MR is byte-identical to what
          // we already have — avoids cloning `branches` and re-rendering the
          // whole tree on no-op broadcasts (which compound badly over hours).
          let newBranches: Record<string, CacheEntry> | null = null;
          for (const [iidStr, mrProps] of Object.entries(mrs)) {
            const iid = Number(iidStr);
            const info = iidToBranch.get(iid);
            if (!info) continue;
            const existing = prev.branches[info.branch]?.mr;
            if (existing && JSON.stringify(existing) === JSON.stringify(mrProps)) continue;
            if (!newBranches) newBranches = { ...prev.branches };
            newBranches[info.branch] = {
              ...(newBranches[info.branch] ?? info.entry),
              mr: mrProps,
              fetchedAt: Date.now(),
            };
          }
          if (!newBranches) return prev;
          return { ...prev, branches: newBranches, source: "live" as const };
        });
        setHasLiveData(true);
      } else if (ev.type === "mr:status") {
        const c = ev.data?.connection;
        if (c === "connected" || c === "connecting" || c === "disconnected") {
          setConnection(c);
        }
      } else if (ev.type === "discussions:update") {
        const iid = ev.data?.iid as number | undefined;
        const discussions = ev.data?.discussions as Discussion[] | undefined;
        const fetchedAt = ev.data?.fetchedAt as number | undefined;
        if (typeof iid !== "number" || !discussions || typeof fetchedAt !== "number") return;
        // Only overwrite if the broadcast is for the MR we're currently viewing.
        setDiscussionsState((s) => {
          if (s.iid !== iid) return s;
          return { iid, loading: false, error: null, discussions, fetchedAt };
        });
      } else if (ev.type === "discussions:new-comments") {
        const iid      = ev.data?.iid      as number | undefined;
        const mrTitle  = ev.data?.mrTitle  as string | undefined;
        const newNotes = ev.data?.newNotes as Array<{ authorUser: string; body: string }> | undefined;
        if (typeof iid !== "number" || !newNotes || newNotes.length === 0) return;
        const first = newNotes[0]!;
        const preview = first.body.split("\n")[0]!.slice(0, 60);
        const extra = newNotes.length > 1 ? ` (+${newNotes.length - 1})` : "";
        setCommentToast({
          iid,
          text: `💬 !${iid} ${mrTitle ? `(${mrTitle.slice(0, 40)}) ` : ""}— @${first.authorUser}: ${preview}${extra}`,
          shownAt: Date.now(),
        });
      }
    }, {
      onStatusChange: (s) => {
        // Transport-level status (WS to daemon). If we can't reach the daemon,
        // surface that — otherwise defer to the daemon's mr:status broadcast.
        if (s === "disconnected") setConnection("disconnected");
      },
    });

    return () => { sub.close(); };
  }, [iidToBranch]);

  // Count other branches
  const localCount = Object.values(data.branches).filter(
    (e) => !e.mr && !DEFAULT_BRANCHES.has(Object.keys(data.branches).find((k) => data.branches[k] === e) || ""),
  ).length;

  // Determine current view for header hints
  const viewHints = jobLogView
    ? "esc back · ↑↓ scroll · r retry · o open · q quit"
    : pipelineView
    ? "esc back · ↑↓ navigate · enter view log · r retry · o open · q quit"
    : commentView && replyDraft !== null
    ? "enter send · ctrl+j newline · esc cancel"
    : commentView
    ? "esc back · ↑↓ file · ←→ thread · R resolve · c reply · o open · q quit"
    : reviewsView
    ? "esc back · ↑↓ navigate · enter view · r refresh · o open · q quit"
    : detailView
    ? "esc back · ↓ reviews · p pipeline · o open · q quit"
    : null;

  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      {/* Header */}
      <Box gap={1} marginBottom={1} width="100%">
        <Text bold color="cyan">rt status</Text>
        {connection === "connected" ? (
          <Badge color="green">live</Badge>
        ) : (
          <Spinner label="connecting" />
        )}
        {!detailView && activeBranches.length > 0 && (
          <Text dimColor>{focusedIndex + 1}/{activeBranches.length}</Text>
        )}
        <Box flexGrow={1} />
        {commentToast ? (
          <Text color="yellow" wrap="truncate">{commentToast.text}</Text>
        ) : viewHints ? (
          <Text dimColor wrap="truncate">{viewHints}</Text>
        ) : localCount > 0 ? (
          <Text dimColor>{localCount} local-only</Text>
        ) : null}
      </Box>

      {(() => {
        // Resolve active pipeline: child stack or head
        const activePipeline = childPipelineStack.length > 0
          ? childPipelineStack[childPipelineStack.length - 1]!.pipeline
          : focusedMR?.pipeline;
        const breadcrumb = childPipelineStack.length > 0
          ? childPipelineStack.map((c, i) => {
              const parentPl = i === 0 ? focusedMR?.pipeline : childPipelineStack[i - 1]!.pipeline;
              return parentPl?.jobs?.[c.parentJobIndex]?.name || "child";
            }).join(" › ")
          : null;

        if (jobLogView && activePipeline) {
          return (
            <JobLogView
              job={activePipeline.jobs[focusedJobIndex]!}
              trace={jobTrace}
              onScrollTop={loadMoreTraceLines}
            />
          );
        }
        if (pipelineView && focusedMR) {
          return (
            <PipelineDetailView
              pipeline={activePipeline ?? null}
              focusedJobIndex={focusedJobIndex}
              actionState={actionState}
              breadcrumb={breadcrumb}
            />
          );
        }
        if (commentView && focusedMR) {
          const summaries = discussionsState.iid === focusedMR.iid && discussionsState.discussions
            ? buildAllCommenterSummaries(focusedMR, discussionsState.discussions)
            : [];
          const reviewerSummary = summaries.find((s) => s.reviewer.id === focusedReviewerId);
          const groups = reviewerSummary ? groupThreadsByFile(reviewerSummary.discussions) : [];
          const currentThread = groups[focusedFileIndex]?.threads[focusedThreadIndex];
          const firstNote = currentThread?.notes[0];
          const diffHunk = firstNote?.position?.newPath && mrDiffs?.iid === focusedMR.iid && mrDiffs.diffs
            ? extractHunk(mrDiffs.diffs.get(firstNote.position.newPath) ?? "", firstNote.position.newLine)
            : null;
          const diffsLoading = mrDiffs === null || mrDiffs.iid !== focusedMR.iid;
          return (
            <CommentView
              mr={focusedMR}
              reviewerName={reviewerSummary?.reviewer.name || reviewerSummary?.reviewer.username || "Reviewer"}
              groups={groups}
              focusedFileIndex={focusedFileIndex}
              focusedThreadIndex={focusedThreadIndex}
              actionState={actionState}
              replyDraft={replyDraft}
              diffHunk={diffHunk}
              diffsLoading={diffsLoading}
            />
          );
        }
        if (reviewsView && focusedMR) {
          const summaries = discussionsState.iid === focusedMR.iid && discussionsState.discussions
            ? buildAllCommenterSummaries(focusedMR, discussionsState.discussions)
            : [];
          return (
            <ReviewsView
              mr={focusedMR}
              state={discussionsState}
              focusedReviewerIndex={focusedReviewerIndex}
              summaries={summaries}
            />
          );
        }
        if (detailView && focusedMR) {
          return (
            <MRDetailView
              mr={focusedMR}
              ticket={focusedEntry?.[1]?.ticket ?? undefined}
              actionState={actionState}
            />
          );
        }
        return (
          <>
            {activeBranches.length > 0 ? (
              <ScrollableList reservedRows={6} itemHeight={3} handleInput={false} focusedIndex={focusedIndex}>
                {activeBranches.map(([branch, entry], i) => (
                  <Box key={branch}>
                    <MRRowTUI
                      mr={entry.mr!}
                      focused={i === focusedIndex}
                      ticket={entry.ticket ?? undefined}
                    />
                  </Box>
                ))}
              </ScrollableList>
            ) : (
              <StatusMessage variant="info">No active merge requests</StatusMessage>
            )}
          </>
        );
      })()}


      {/* Footer shortcuts — list view only */}
      {!detailView && (
        <Text dimColor wrap="truncate">↑↓ navigate · enter detail · p pipeline · o open · s {sortMode} · m merged{mergedDays > 0 ? ` (${mergedDays}d)` : ""} · q quit</Text>
      )}
    </Box>
  );
}
