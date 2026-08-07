/**
 * Keyboard handling for the live dashboard — one useInput handler covering
 * every view (list, detail, reviews, comments, pipeline, job log) plus the
 * MR action keys. Extracted from LiveDashboard; receives the dashboard's
 * state and setters through a context object so the handler body reads the
 * same as it did in-component.
 */

import type { Dispatch, SetStateAction } from "react";
import { useInput } from "ink";
import type { MRDashboardProps, Pipeline, ReviewerSummary } from "@mattstack/glance";
import {
  fetchDiscussions,
  setDiscussionResolved,
  replyToDiscussion,
  type DaemonMRActions,
} from "../../lib/daemon-client.ts";
import type { ActionState, CacheEntry, JobTraceState, SortMode, StatusData } from "./types.ts";
import { SORT_CYCLE } from "./types.ts";
import { cleanTraceLine, canRebaseRemotely } from "./format.ts";
import { buildAllCommenterSummaries, groupThreadsByFile, type DiscussionsState } from "./reviews.tsx";

export interface DashboardInputContext {
  actionState: ActionState;
  setActionState: Dispatch<SetStateAction<ActionState>>;
  setData: Dispatch<SetStateAction<StatusData>>;
  activeBranches: [string, CacheEntry][];
  setFocusedIndex: Dispatch<SetStateAction<number>>;
  focusedEntry: [string, CacheEntry] | undefined;
  focusedMR: MRDashboardProps | null | undefined;
  focusedActions: DaemonMRActions | undefined;
  detailView: boolean;
  setDetailView: Dispatch<SetStateAction<boolean>>;
  reviewsView: boolean;
  setReviewsView: Dispatch<SetStateAction<boolean>>;
  focusedReviewerIndex: number;
  setFocusedReviewerIndex: Dispatch<SetStateAction<number>>;
  discussionsState: DiscussionsState;
  setDiscussionsState: Dispatch<SetStateAction<DiscussionsState>>;
  commentView: boolean;
  setCommentView: Dispatch<SetStateAction<boolean>>;
  focusedReviewerId: string | null;
  setFocusedReviewerId: Dispatch<SetStateAction<string | null>>;
  focusedFileIndex: number;
  setFocusedFileIndex: Dispatch<SetStateAction<number>>;
  focusedThreadIndex: number;
  setFocusedThreadIndex: Dispatch<SetStateAction<number>>;
  pipelineView: boolean;
  setPipelineView: Dispatch<SetStateAction<boolean>>;
  pipelineFromList: boolean;
  setPipelineFromList: Dispatch<SetStateAction<boolean>>;
  jobLogView: boolean;
  setJobLogView: Dispatch<SetStateAction<boolean>>;
  focusedJobIndex: number;
  setFocusedJobIndex: Dispatch<SetStateAction<number>>;
  childPipelineStack: Array<{ pipeline: Pipeline; parentJobIndex: number }>;
  setChildPipelineStack: Dispatch<SetStateAction<Array<{ pipeline: Pipeline; parentJobIndex: number }>>>;
  setJobTrace: Dispatch<SetStateAction<JobTraceState>>;
  replyDraft: string | null;
  setReplyDraft: Dispatch<SetStateAction<string | null>>;
  setMergedDays: Dispatch<SetStateAction<number>>;
  setSortMode: Dispatch<SetStateAction<SortMode>>;
  executeAction: (key: string, label: string, loadingLabel: string, fn: () => Promise<void>) => Promise<void>;
  openPipelineView: () => void;
}

export function useDashboardInput(ctx: DashboardInputContext): void {
  const {
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
  } = ctx;

  useInput((input, key) => {
    if (actionState.loading) return; // ignore input while action in progress

    const resetAction = () => setActionState({ loading: null, result: null, confirm: null });
    const totalJobs = focusedMR?.pipeline?.jobs?.length ?? 0;

    // ── Job Log View ──────────────────────────────────────────────────────
    if (jobLogView) {
      if (key.escape || key.delete || input === "b") {
        setJobLogView(false);
        resetAction();
        return;
      }
      // Scroll is handled by ScrollableList's own useInput
      // Retry this job
      if (input === "r" && focusedMR?.pipeline && focusedActions) {
        const job = focusedMR.pipeline.jobs[focusedJobIndex];
        if (job) {
          const numericId = parseInt(job.id.split(":").pop() || "0", 10);
          setActionState({ loading: `Retrying ${job.name}…`, result: null, confirm: null });
          focusedActions.retryJob(numericId)
            .then(() => setActionState({ loading: null, result: { ok: true, message: `${job.name} retry triggered` }, confirm: null }))
            .catch((e: any) => setActionState({ loading: null, result: { ok: false, message: e.message }, confirm: null }));
        }
      }
      // Open job in browser
      if (input === "o" && focusedMR?.pipeline) {
        const job = focusedMR.pipeline.jobs[focusedJobIndex];
        if (job?.webUrl) {
          import("child_process").then(({ execSync }) => {
            execSync(`open ${JSON.stringify(job.webUrl)}`, { stdio: "ignore" });
          });
        }
      }
      if (input === "q" && !actionState.confirm) process.exit(0);
      return;
    }

    // ── Pipeline View ─────────────────────────────────────────────────────
    if (pipelineView) {
      // Resolve current pipeline: head or deepest child in stack
      const activePipeline = childPipelineStack.length > 0
        ? childPipelineStack[childPipelineStack.length - 1]!.pipeline
        : focusedMR?.pipeline;
      const activeJobs = activePipeline?.jobs ?? [];
      const activeJobCount = activeJobs.length;

      if (key.escape || key.delete || input === "b") {
        if (childPipelineStack.length > 0) {
          // Pop child pipeline, restore parent job index
          const popped = childPipelineStack[childPipelineStack.length - 1]!;
          setChildPipelineStack((s) => s.slice(0, -1));
          setFocusedJobIndex(popped.parentJobIndex);
        } else {
          setPipelineView(false);
          setChildPipelineStack([]);
          // If we jumped straight to pipeline from the list, skip the card view
          if (pipelineFromList) {
            setDetailView(false);
            setPipelineFromList(false);
          }
        }
        resetAction();
        return;
      }
      if (key.downArrow) {
        setFocusedJobIndex((i) => Math.min(i + 1, activeJobCount - 1));
        resetAction();
      }
      if (key.upArrow) {
        setFocusedJobIndex((i) => Math.max(i - 1, 0));
        resetAction();
      }
      // Enter: drill into child pipeline or job log
      if (key.return && activePipeline && focusedActions) {
        const job = activeJobs[focusedJobIndex];
        if (job) {
          const numericId = parseInt(job.id.split(":").pop() || "0", 10);
          const pipelineNumericId = parseInt(activePipeline.id?.split(":").pop() || "0", 10) || undefined;
          setActionState({ loading: "Loading…", result: null, confirm: null });
          focusedActions.fetchJobDetail(numericId, pipelineNumericId).then((detail) => {
            setActionState({ loading: null, result: null, confirm: null });
            if (detail.type === "bridge") {
              // Trigger job — drill into child pipeline
              setChildPipelineStack((s) => [...s, { pipeline: detail.downstreamPipeline, parentJobIndex: focusedJobIndex }]);
              setFocusedJobIndex(0);
            } else {
              // Regular job — show trace log
              const allLines = detail.content.split("\n").map(cleanTraceLine);
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
              setJobLogView(true);
            }
          }).catch((e: any) => {
            setActionState({ loading: null, result: { ok: false, message: e.message ?? "Failed to load job" }, confirm: null });
          });
        }
      }
      // Retry focused job
      if (input === "r" && activePipeline && focusedActions) {
        const job = activeJobs[focusedJobIndex];
        if (job && (job.status === "failed" || job.status === "canceled")) {
          const numericId = parseInt(job.id.split(":").pop() || "0", 10);
          setActionState({ loading: `Retrying ${job.name}…`, result: null, confirm: null });
          focusedActions.retryJob(numericId)
            .then(() => setActionState({ loading: null, result: { ok: true, message: `${job.name} retry triggered` }, confirm: null }))
            .catch((e: any) => setActionState({ loading: null, result: { ok: false, message: e.message }, confirm: null }));
        }
      }
      // Open job in browser
      if (input === "o" && activePipeline) {
        const job = activeJobs[focusedJobIndex];
        if (job?.webUrl) {
          import("child_process").then(({ execSync }) => {
            execSync(`open ${JSON.stringify(job.webUrl)}`, { stdio: "ignore" });
          });
        }
      }
      if (input === "q" && !actionState.confirm) process.exit(0);
      return;
    }

    // Compute current reviewer summaries once — used by both Reviews and Comment views.
    const reviewerSummaries: ReviewerSummary[] = focusedMR
      && discussionsState.iid === focusedMR.iid
      && discussionsState.discussions
      ? buildAllCommenterSummaries(focusedMR, discussionsState.discussions)
      : [];

    // ── Comment View (split-pane per-reviewer threads) ────────────────────
    if (commentView) {
      const reviewerSummary = reviewerSummaries.find((s) => s.reviewer.id === focusedReviewerId);
      const fileGroups = reviewerSummary ? groupThreadsByFile(reviewerSummary.discussions) : [];
      const currentGroup  = fileGroups[focusedFileIndex];
      const currentThread = currentGroup?.threads[focusedThreadIndex];
      const repoName      = focusedEntry?.[1]?.repoName;

      // ── Inline reply composition ──────────────────────────────────────
      if (replyDraft !== null) {
        if (key.escape) { setReplyDraft(null); return; }
        if (key.return) {
          const body = replyDraft.trim();
          if (body && focusedMR && repoName && currentThread) {
            const iid = focusedMR.iid;
            const discussionId = currentThread.id;
            setReplyDraft(null);
            setActionState({ loading: "Posting reply…", result: null, confirm: null });
            replyToDiscussion(repoName, iid, discussionId, body)
              .then((snap) => {
                setDiscussionsState({ iid, loading: false, error: null, discussions: snap.discussions, fetchedAt: snap.fetchedAt });
                setActionState({ loading: null, result: { ok: true, message: "Reply posted" }, confirm: null });
              })
              .catch((e: any) => {
                setActionState({ loading: null, result: { ok: false, message: e.message || "Reply failed" }, confirm: null });
              });
          } else if (!body) {
            setReplyDraft(null);
          }
          return;
        }
        if (key.ctrl && input === "j") { setReplyDraft((d) => (d ?? "") + "\n"); return; }
        if (key.backspace || key.delete) { setReplyDraft((d) => (d ?? "").slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setReplyDraft((d) => (d ?? "") + input); }
        return;
      }

      if (key.escape || key.delete || input === "b") {
        setCommentView(false);
        resetAction();
        return;
      }
      if (key.upArrow) {
        setFocusedFileIndex((i) => {
          const next = Math.max(i - 1, 0);
          if (next !== i) setFocusedThreadIndex(0);
          return next;
        });
        resetAction();
      }
      if (key.downArrow) {
        setFocusedFileIndex((i) => {
          const next = Math.min(i + 1, Math.max(fileGroups.length - 1, 0));
          if (next !== i) setFocusedThreadIndex(0);
          return next;
        });
        resetAction();
      }
      if (key.leftArrow) {
        setFocusedThreadIndex((i) => Math.max(i - 1, 0));
        resetAction();
      }
      if (key.rightArrow) {
        const max = Math.max((currentGroup?.threads.length ?? 0) - 1, 0);
        setFocusedThreadIndex((i) => Math.min(i + 1, max));
        resetAction();
      }
      // Resolve / unresolve the current thread (with confirm — matches [m] merge).
      if (input === "R" && currentThread?.resolvable && focusedMR && repoName) {
        const iid = focusedMR.iid;
        const discussionId = currentThread.id;
        const wantResolved = !currentThread.resolved;
        const label = wantResolved ? "Resolve thread" : "Unresolve thread";
        const loadingLabel = wantResolved ? "Resolving…" : "Unresolving…";
        executeAction("R", label, loadingLabel, async () => {
          const snap = await setDiscussionResolved(repoName, iid, discussionId, wantResolved);
          setDiscussionsState({
            iid, loading: false, error: null,
            discussions: snap.discussions, fetchedAt: snap.fetchedAt,
          });
        });
      }
      // Reply: open inline compose box.
      if (input === "c" && currentThread && focusedMR && repoName) {
        setReplyDraft("");
      }
      if (input === "o" && focusedMR?.webUrl) {
        import("child_process").then(({ execSync }) => {
          execSync(`open ${JSON.stringify(focusedMR.webUrl)}`, { stdio: "ignore" });
        });
      }
      if (input === "q" && !actionState.confirm) process.exit(0);
      return;
    }

    // ── Reviews Sub-View ──────────────────────────────────────────────────
    if (reviewsView) {
      if (key.escape || key.delete || input === "b") {
        setReviewsView(false);
        resetAction();
        return;
      }
      const summaries = reviewerSummaries;
      if (key.downArrow) {
        setFocusedReviewerIndex((i) => Math.min(i + 1, Math.max(summaries.length - 1, 0)));
        resetAction();
      }
      if (key.upArrow) {
        setFocusedReviewerIndex((i) => Math.max(i - 1, 0));
        resetAction();
      }
      // Enter: drill into the selected reviewer's comments
      if (key.return) {
        const selected = summaries[focusedReviewerIndex];
        if (selected && selected.discussions.length > 0) {
          setFocusedReviewerId(selected.reviewer.id);
          setFocusedFileIndex(0);
          setFocusedThreadIndex(0);
          setCommentView(true);
          resetAction();
          return;
        }
      }
      // Manual refresh
      if (input === "r" && focusedMR && focusedEntry?.[1]?.repoName) {
        const repoName = focusedEntry[1].repoName;
        const iid = focusedMR.iid;
        setDiscussionsState((s) => ({ ...s, loading: true, error: null }));
        fetchDiscussions(repoName, iid, { force: true })
          .then((snap) => setDiscussionsState({ iid, loading: false, error: null, discussions: snap.discussions, fetchedAt: snap.fetchedAt }))
          .catch((e: any) => setDiscussionsState((s) => ({ ...s, loading: false, error: e.message || "failed to fetch discussions" })));
      }
      if (input === "o" && focusedMR?.webUrl) {
        import("child_process").then(({ execSync }) => {
          execSync(`open ${JSON.stringify(focusedMR.webUrl)}`, { stdio: "ignore" });
        });
      }
      if (input === "q" && !actionState.confirm) process.exit(0);
      return;
    }

    // ── MR Detail View ────────────────────────────────────────────────────
    if (detailView) {
      if (key.escape || key.delete || input === "b") {
        setDetailView(false);
        resetAction();
        return;
      }
      // Enter pipeline view
      if (input === "p" && focusedMR?.pipeline) {
        setPipelineFromList(false);
        openPipelineView();
        return;
      }
      // Arrow down: enter Reviews sub-view (lazy-fetch discussions on entry)
      if (key.downArrow && focusedMR && focusedEntry?.[1]?.repoName) {
        const repoName = focusedEntry[1].repoName;
        const iid = focusedMR.iid;
        setReviewsView(true);
        setFocusedReviewerIndex(0);
        // Reset snapshot if it's for a different MR
        if (discussionsState.iid !== iid) {
          setDiscussionsState({ iid, loading: true, error: null, discussions: null, fetchedAt: null });
        } else {
          setDiscussionsState((s) => ({ ...s, loading: true, error: null }));
        }
        fetchDiscussions(repoName, iid)
          .then((snap) => setDiscussionsState({ iid, loading: false, error: null, discussions: snap.discussions, fetchedAt: snap.fetchedAt }))
          .catch((e: any) => setDiscussionsState((s) => ({ ...s, iid, loading: false, error: e.message || "failed to fetch discussions" })));
        resetAction();
        return;
      }
    }

    // ── MR List View ──────────────────────────────────────────────────────
    if (!detailView) {
      if (key.downArrow) {
        setFocusedIndex((i) => Math.min(i + 1, activeBranches.length - 1));
        resetAction();
      }
      if (key.upArrow) {
        setFocusedIndex((i) => Math.max(i - 1, 0));
        resetAction();
      }
      if (key.return && focusedMR) {
        setDetailView(true);
        resetAction();
      }
      // Pipeline shortcut from list view
      if (input === "p" && focusedMR?.pipeline) {
        setDetailView(true);
        setPipelineFromList(true);
        openPipelineView();
        return;
      }
    }

    // Actions (only in detail view, when we have a focused MR and actions)
    if (detailView && !pipelineView && focusedMR && focusedActions) {
      const mr = focusedMR;

      if (input === "m" && mr.mergeButton.visible && !mr.mergeButton.disabled) {
        const targetIid = mr.iid;
        executeAction("m", "Merge", "Merging…", async () => {
          await focusedActions.merge();
          // The daemon will broadcast the canonical merged state on its next
          // push, but that can lag a few seconds. Flip local state now so the
          // detail view stops advertising merge/approve/auto-merge buttons
          // for an MR that's already gone.
          setData((prev) => {
            const branches = { ...prev.branches };
            for (const [branch, entry] of Object.entries(branches)) {
              if (entry.mr?.iid !== targetIid) continue;
              branches[branch] = {
                ...entry,
                mr: {
                  ...entry.mr,
                  status: "merged",
                  state: "merged",
                  isMerging: false,
                  mergeButton:     { ...entry.mr.mergeButton,     visible: false },
                  autoMergeButton: { ...entry.mr.autoMergeButton, visible: false },
                  rebaseButton:    { ...entry.mr.rebaseButton,    visible: false },
                  blockers: { ...entry.mr.blockers, any: false, hasMergeError: false, mergeError: null },
                },
                fetchedAt: Date.now(),
              };
            }
            return { ...prev, branches };
          });
        });
      }
      if (input === "r" && canRebaseRemotely(mr)) {
        executeAction("r", "Rebase", "Rebasing…", () => focusedActions.rebase());
      }
      if (input === "R") {
        // Local rebase: worktree-aware fetch + rebase against target branch
        executeAction("R", "Local rebase", "Rebasing locally…", async () => {
          const { execSync } = await import("child_process");
          const { getKnownRepos } = await import("../../lib/repo.ts");
          const target = mr.targetBranch;
          const source = mr.sourceBranch;

          // Find the worktree that has the source branch checked out
          const repos = getKnownRepos();
          const allWorktrees = repos.flatMap(r => r.worktrees);
          const sourceWorktree = allWorktrees.find(wt => wt.branch === source);

          if (!sourceWorktree) {
            throw new Error(
              `Branch "${source}" is not checked out in any worktree.\n` +
              `Check it out first: git worktree add <path> ${source}`,
            );
          }

          const opts = { cwd: sourceWorktree.path, stdio: "pipe" as const };

          // Fetch both refs (branch is already checked out — no checkout needed)
          execSync(`git fetch origin ${target} ${source}`, opts);

          try {
            execSync(`git rebase origin/${target}`, opts);
            execSync(`git push --force-with-lease`, opts);
          } catch (e: any) {
            try { execSync(`git rebase --abort`, opts); } catch {}
            throw new Error(
              `Rebase conflicts in ${sourceWorktree.path} — resolve manually:\n` +
              `  cd ${sourceWorktree.path} && git rebase origin/${target}`,
            );
          }
        });
      }
      if (input === "a") {
        executeAction("a", "Approve", "Approving…", () => focusedActions.approve());
      }
      if (input === "u") {
        executeAction("u", "Unapprove", "Removing approval…", () => focusedActions.unapprove());
      }
      if (input === "M" && mr.autoMergeButton.visible) {
        if (mr.autoMergeButton.isActive) {
          executeAction("M", "Cancel auto-merge", "Cancelling…", () => focusedActions.cancelAutoMerge());
        } else {
          executeAction("M", "Enable auto-merge", "Enabling…", () => focusedActions.setAutoMerge());
        }
      }
      if (input === "d") {
        executeAction("d", mr.isDraft ? "Mark ready" : "Mark draft", mr.isDraft ? "Setting ready…" : "Marking draft…", () =>
          focusedActions.toggleDraft(!mr.isDraft).then(() => {}),
        );
      }
      if (input === "o" && mr.webUrl) {
        import("child_process").then(({ execSync }) => {
          execSync(`open ${JSON.stringify(mr.webUrl)}`, { stdio: "ignore" });
        });
      }
    }

    // Open in browser from list view too
    if (!detailView && input === "o" && focusedMR?.webUrl) {
      import("child_process").then(({ execSync }) => {
        execSync(`open ${JSON.stringify(focusedMR.webUrl)}`, { stdio: "ignore" });
      });
    }

    // Cycle merged MR window: off → 1d → 3d → 7d → off
    if (!detailView && input === "m") {
      setMergedDays((d) => ({ 0: 1, 1: 3, 3: 7, 7: 0 }[d] ?? 0));
    }

    // Cycle sort mode
    if (!detailView && input === "s") {
      setSortMode((m) => SORT_CYCLE[(SORT_CYCLE.indexOf(m) + 1) % SORT_CYCLE.length]!);
      setFocusedIndex(0);
    }

    // Global: q to quit
    if (input === "q" && !actionState.confirm) {
      process.exit(0);
    }
  });
}
