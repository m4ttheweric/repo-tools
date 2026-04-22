/**
 * rt status — Live interactive branch dashboard.
 *
 * WebSocket-powered real-time MR dashboard with navigation,
 * detail drill-down, and inline actions (merge, rebase, approve, etc.)
 */

import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput } from "ink";
import { Badge, Spinner, StatusMessage } from "@inkjs/ui";
import { ScrollableList } from "../lib/ScrollableList.tsx";
import type { MRDashboardProps, Reviewer, PipelineJob, Pipeline } from "@workforge/glance-sdk";
import { getReviewDisplayState } from "@workforge/glance-sdk";
import type { PortEntry } from "../lib/port-scanner.ts";
import { mrActions, subscribeToDaemon, type DaemonMRActions } from "../lib/daemon-client.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CacheEntry {
  ticket: {
    identifier: string;
    title: string;
    stateName?: string;
    stateColor?: string;
  } | null;
  linearId: string;
  mr: MRDashboardProps | null;
  fetchedAt: number;
  /** Repo this entry belongs to (from ~/.rt/repos.json). Used to route
   *  daemon mr:action IPC calls. Optional for backward compatibility with
   *  older on-disk caches — filled in on the next daemon refresh. */
  repoName?: string;
}

interface StatusData {
  branches: Record<string, CacheEntry>;
  ports: PortEntry[];
  source: "daemon" | "cache-file" | "live";
}

type ActionPending = {
  key: string;
  label: string;
  action: () => Promise<void>;
} | null;

export type ActionState = {
  loading: string | null; // label while loading
  result: { ok: boolean; message: string } | null;
  confirm: ActionPending;
};

// ─── Data fetching ──────────────────────────────────────────────────────────

export async function fetchStatusData(): Promise<StatusData> {
  const { daemonQuery } = await import("../lib/daemon-client.ts");

  const [cacheResult, portResult] = await Promise.all([
    daemonQuery("cache:read"),
    daemonQuery("ports"),
  ]);

  // Note: no cache:refresh here — the dashboard has its own live WebSocket connection

  let branches: Record<string, CacheEntry> = {};
  let ports: PortEntry[] = [];
  let source: "daemon" | "cache-file" = "daemon";

  if (cacheResult?.ok && cacheResult.data) {
    branches = cacheResult.data;
  } else {
    source = "cache-file";
    try {
      const { readFileSync } = await import("fs");
      const { homedir } = await import("os");
      const { join } = await import("path");
      const raw = JSON.parse(
        readFileSync(join(homedir(), ".rt", "branch-cache.json"), "utf8"),
      );
      branches = raw.entries || {};
    } catch {
      /* no cache */
    }
  }

  if (portResult?.ok && portResult.data?.ports) {
    ports = portResult.data.ports;
  }

  return { branches, ports, source };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(ms: number | string): string {
  const ts = typeof ms === "string" ? new Date(ms).getTime() : ms;
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Animated spinner character — only ticks when a pipeline is running. */
function useSpinnerChar(active: boolean): string {
  const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, [active]);
  return FRAMES[frame]!;
}

/** Reactive terminal width — triggers re-render on resize. */
function useTerminalWidth(): number {
  const [width, setWidth] = useState(process.stdout.columns || 80);
  useEffect(() => {
    const onResize = () => setWidth(process.stdout.columns || 80);
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);
  return width;
}

// ─── Status config ──────────────────────────────────────────────────────────

type MRStatus = MRDashboardProps["status"];



const STATUS_COLOR: Record<MRStatus, string> = {
  mergeable: "green",     // positive  → green-40
  merged: "magenta",      // action    → purple-40
  blocked: "yellow",      // caution   → yellow-40
  draft: "gray",          // muted     → border
  closed: "red",          // negative  → red-40
};

const STATUS_LABEL: Record<MRStatus, string> = {
  mergeable: "Ready to merge",
  merged: "Merged",
  blocked: "Blocked",
  draft: "Draft",
  closed: "Closed",
};

// ─── Review display state ───────────────────────────────────────────────────

const REVIEW_ICON: Record<string, string> = {
  approved: "✓",
  commented: "💬",
  changes_requested: "✗",
  reviewing: "…",
  awaiting_review: "○",
};

const REVIEW_COLOR: Record<string, string> = {
  approved: "green",
  commented: "cyan",
  changes_requested: "yellow",
  reviewing: "gray",
  awaiting_review: "gray",
};

// ─── Pipeline Badge (compact + detailed) ────────────────────────────────────

function PipelineBadgeCompact({ pipeline }: { pipeline: MRDashboardProps["pipeline"] }) {
  if (!pipeline) return null;
  const { status, failing, running, total } = pipeline;

  if (failing > 0 || status === "failed") {
    return <Badge color="red">{failing} failing</Badge>;
  }
  if (status === "running" || status === "pending" || running > 0) {
    return (
      <Box gap={1}>
        <Spinner label="" />
        <Text dimColor>{running}/{total}</Text>
      </Box>
    );
  }
  return <Badge color="green">passed</Badge>;
}

function PipelineDetailed({ pipeline }: { pipeline: MRDashboardProps["pipeline"] }) {
  if (!pipeline) {
    return <Text dimColor>  No pipeline</Text>;
  }

  const { status, failing, running, passing, total, hasWarnings, jobs } = pipeline;
  const notableJobs = jobs.filter(
    (j: PipelineJob) => j.status === "failed" || j.status === "running" || j.status === "pending",
  );

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {failing > 0 || status === "failed" ? (
          <>
            <Text color="red">✗</Text>
            <Text>
              <Text color="red" bold>{failing} failing</Text>
              <Text dimColor> of {total} checks</Text>
            </Text>
          </>
        ) : status === "running" || status === "pending" || running > 0 ? (
          <>
            <Spinner label="" />
            <Text>
              <Text dimColor>{running} running of {total} checks</Text>
            </Text>
          </>
        ) : hasWarnings ? (
          <>
            <Text color="yellow">⚠</Text>
            <Text>
              <Text color="yellow" bold>Passed with warnings</Text>
              <Text dimColor> — {passing}/{total} checks</Text>
            </Text>
          </>
        ) : (
          <>
            <Text color="green">✓</Text>
            <Text>
              All <Text color="green" bold>{total} checks passed</Text>
            </Text>
          </>
        )}
      </Box>
      {notableJobs.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {notableJobs.map((job: PipelineJob) => {
            const si = jobStatusIcon(job.status, job.allowFailure);
            return (
              <Box key={job.id} gap={1}>
                <Text color={si.color}>{si.isSpinner ? "⟳" : si.icon}</Text>
                <Text>{job.name}</Text>
                <Text dimColor>({job.stage})</Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

// ─── Diff stats ─────────────────────────────────────────────────────────────

function DiffStatsCompact({ diff }: { diff: MRDashboardProps["diff"] }) {
  if (!diff) return null;
  return (
    <Text>
      <Text color="green">+{diff.additions}</Text>
      <Text dimColor> </Text>
      <Text color="red">-{diff.deletions}</Text>
    </Text>
  );
}

function DiffStatsDetailed({ diff }: { diff: MRDashboardProps["diff"] }) {
  if (!diff) return null;
  const total = diff.additions + diff.deletions;
  const dots = Math.min(diff.filesChanged, 20);
  const greenDots = total > 0 ? Math.round((diff.additions / total) * dots) : dots;

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text color="green" bold>+{diff.additions}</Text>
        <Text color="red" bold>-{diff.deletions}</Text>
        <Text dimColor>{diff.filesChanged} files</Text>
      </Box>
      <Text>
        {Array.from({ length: dots }, (_, i) =>
          i < greenDots ? "🟩" : "🟥"
        ).join("")}
      </Text>
    </Box>
  );
}

// ─── Reviewer detail ────────────────────────────────────────────────────────

function ReviewerDetailed({ reviews }: { reviews: MRDashboardProps["reviews"] }) {
  if (reviews.reviewers.length === 0) {
    return <Text dimColor>  No reviewers assigned</Text>;
  }

  const totalReviewers = reviews.given + reviews.remaining;

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {reviews.isApproved ? (
          <>
            <Text color="green">✓</Text>
            <Text>
              <Text color="green" bold>Approved</Text>
              <Text dimColor> by {reviews.given}/{totalReviewers} reviewers</Text>
            </Text>
          </>
        ) : (
          <>
            <Text color="yellow">◈</Text>
            <Text>
              {reviews.given}/{totalReviewers} approvals
              {reviews.remaining > 0 && (
                <Text dimColor> — {reviews.remaining} remaining</Text>
              )}
            </Text>
          </>
        )}
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {reviews.reviewers.map((r: Reviewer) => {
          const state = getReviewDisplayState(r.reviewState);
          const icon = REVIEW_ICON[state] || "○";
          const color = REVIEW_COLOR[state] || "gray";
          return (
            <Box key={r.id} gap={1}>
              <Text color={color as any}>{icon}</Text>
              <Text>{r.name}</Text>
              <Text dimColor>{state.replace(/_/g, " ")}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

// ─── Blocker detail ─────────────────────────────────────────────────────────

function BlockerDetailed({ mr }: { mr: MRDashboardProps }) {
  const b = mr.blockers;
  const items: { icon: string; color: string; text: string }[] = [];

  if (b.hasConflicts) items.push({ icon: "⚠", color: "yellow", text: "Merge conflicts" });
  if (b.needsRebase) items.push({ icon: "↻", color: "yellow", text: `Branch is behind target by ${mr.rebaseButton.behindBy} commits` });
  if (b.hasUnresolvedDiscussions) items.push({ icon: "💬", color: "cyan", text: "Unresolved discussions" });
  if (b.isDraft) items.push({ icon: "○", color: "gray", text: "Draft — mark as ready before merging" });
  if (b.mergeError) items.push({ icon: "✗", color: "red", text: b.mergeError });

  if (items.length === 0) return null;

  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Box key={i} gap={1}>
          <Text color={item.color as any}>{item.icon}</Text>
          <Text>{item.text}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ─── MR Row (list view) — mirrors glance-react MRRow ────────────────────────

/** Pipeline status → TUI icon */
function pipelineIcon(pipeline: { status: string; failing?: number; running?: number } | null): { icon: string; color: string } {
  if (!pipeline) return { icon: " ", color: "gray" };
  const { status, failing, running } = pipeline;
  if (status === "failed" || (failing && failing > 0)) return { icon: "✗", color: "red" };
  if (status === "running" || (running && running > 0)) return { icon: "~", color: "blue" };
  return { icon: "●", color: "green" };
}

/**
 * 2-line box-art status icons, colored by STATUS_COLOR.
 */
const STATUS_ART: Record<MRStatus, [string, string]> = {
  mergeable: ["╭ ✓ ╮", "╰───╯"],
  merged:    ["╭ ⏣ ╮", "╰───╯"],
  blocked:   ["╭ ━ ╮", "╰───╯"],
  draft:     ["┌ · ┐", "└───┘"],
  closed:    ["╭ ✗ ╮", "╰───╯"],
};

/** Right-pad a string to a fixed width */
function rpad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}
/** Left-pad a string to a fixed width */
function lpad(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function MRRowTUI({
  mr,
  focused,
  ticket,
}: {
  mr: MRDashboardProps;
  focused: boolean;
  ticket?: CacheEntry["ticket"];
}) {
  const statusColor = STATUS_COLOR[mr.status] || "gray";
  const art = STATUS_ART[mr.status] || STATUS_ART.blocked;
  const cols = useTerminalWidth();
  const pipelineRunning = mr.pipeline?.status === "running" || mr.pipeline?.status === "pending";
  const spinnerChar = useSpinnerChar(pipelineRunning);

  const totalReviewers = mr.reviews.given + mr.reviews.remaining;
  const reviewStr = totalReviewers > 0 ? `${mr.reviews.given}/${totalReviewers}` : "";
  const pi = pipelineIcon(mr.pipeline);
  const delStr = mr.diff ? `-${mr.diff.deletions}` : "";
  const addStr = mr.diff ? `+${mr.diff.additions}` : "";
  const filesStr = mr.diff ? `${mr.diff.filesChanged} files` : "";

  const RIGHT_W = 22; // lpad(5) + lpad(2) + lpad(8) + lpad(7)
  const LEFT_W = 8;
  const titleMax = Math.max(20, cols - RIGHT_W - LEFT_W - 1);

  const bg = focused ? "#334155" : undefined;
  const meta = `!${mr.iid} · ⎇ ${truncate(mr.sourceBranch, 25)} → ${mr.targetBranch}`;
  const line2ContentW = cols - LEFT_W;

  return (
    <Box flexDirection="column" width="100%">
      <Box width="100%">
        <Text color={focused ? "cyan" : statusColor} bold={focused}>│</Text>
        <Text backgroundColor={bg}> </Text>
        <Text backgroundColor={bg} color={statusColor} bold>{art[0]}</Text>
        <Text backgroundColor={bg}> </Text>
        <Text backgroundColor={bg} bold>{rpad(truncate(mr.title, titleMax), titleMax)}</Text>
        <Text backgroundColor={bg} color={mr.reviews.isApproved ? "green" : "yellow"}>{lpad(reviewStr || "   ", 5)}</Text>
        <Text backgroundColor={bg} color={pi.color}>{pipelineRunning ? lpad(spinnerChar, 2) : lpad(pi.icon, 2)}</Text>
        <Text backgroundColor={bg} color="red">{lpad(delStr, 8)}</Text>
        <Text backgroundColor={bg} color="green">{lpad(addStr, 7)}</Text>
      </Box>
      <Box width="100%">
        <Text color={focused ? "cyan" : statusColor} bold={focused}>│</Text>
        <Text backgroundColor={bg}> </Text>
        <Text backgroundColor={bg} color={statusColor} bold>{art[1]}</Text>
        <Text backgroundColor={bg}> </Text>
        <Text backgroundColor={bg} dimColor={!focused}>
          {rpad(meta, Math.max(0, line2ContentW - 11))}
        </Text>
        <Text backgroundColor={bg} dimColor={!focused}>{filesStr ? lpad(filesStr, 10) : "          "}</Text>
      </Box>
      <Text dimColor>{"·".repeat(Math.max(0, cols - 2))}</Text>
    </Box>
  );
}

// ─── MR Detail View (MRCard equivalent) ─────────────────────────────────────

export function MRDetailView({
  mr,
  ticket,
  actionState,
}: {
  mr: MRDashboardProps;
  ticket?: CacheEntry["ticket"];
  actionState: ActionState;
}) {
  const statusColor = STATUS_COLOR[mr.status] || "gray";

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* Header: status badge */}
      <Box gap={1} marginBottom={1}>
        {mr.isCheckingMergeability ? (
          <Badge color="cyan">Checking…</Badge>
        ) : (
          <Badge color={statusColor === "green" ? "green" : statusColor === "blue" ? "blue" : statusColor === "yellow" ? "yellow" : statusColor === "red" ? "red" : "cyan"}>
            {STATUS_LABEL[mr.status]}
          </Badge>
        )}
        {mr.isLoading && <Spinner label="updating" />}
        {mr.status === "blocked" && mr.statusDetail && (
          <Text dimColor>({mr.statusDetail})</Text>
        )}
      </Box>

      {/* Title + branch info */}
      <Box gap={1}>
        <Text dimColor>!{mr.iid}</Text>
        <Text dimColor>·</Text>
        <Text bold>{mr.title}</Text>
      </Box>
      <Box paddingLeft={2} gap={1}>
        <Text dimColor>⎇</Text>
        <Text dimColor>{mr.sourceBranch}</Text>
        <Text dimColor>→</Text>
        <Text dimColor>{mr.targetBranch}</Text>
        {mr.createdAt && (
          <>
            <Text dimColor>·</Text>
            <Text dimColor>{timeAgo(mr.createdAt)}</Text>
          </>
        )}
        <Text dimColor>· by {mr.author.username}</Text>
      </Box>

      {ticket && (
        <Box paddingLeft={2} gap={1}>
          <Text dimColor>{ticket.identifier}</Text>
          {ticket.title && <Text dimColor>{truncate(ticket.title, 50)}</Text>}
          {ticket.stateName && <Text dimColor>[{ticket.stateName}]</Text>}
        </Box>
      )}

      {/* Diff stats */}
      <Box marginTop={1} paddingLeft={2}>
        <DiffStatsDetailed diff={mr.diff} />
      </Box>

      {/* Status card: pipeline + reviews + blockers */}
      <Box flexDirection="column" marginTop={1} paddingLeft={2} borderStyle="single" borderLeft borderColor={statusColor as any} paddingRight={1}>
        <PipelineDetailed pipeline={mr.pipeline} />
        <ReviewerDetailed reviews={mr.reviews} />
        <BlockerDetailed mr={mr} />
      </Box>

      {/* Action bar */}
      {mr.status !== "closed" && mr.status !== "merged" && (
        <Box marginTop={1} paddingLeft={2}>
          <ActionBarView mr={mr} actionState={actionState} />
        </Box>
      )}

      {/* Action feedback */}
      {actionState.loading && (
        <Box paddingLeft={2} marginTop={1}>
          <Spinner label={actionState.loading} />
        </Box>
      )}
      {actionState.result && (
        <Box paddingLeft={2} marginTop={1}>
          <StatusMessage variant={actionState.result.ok ? "success" : "error"}>
            {actionState.result.message}
          </StatusMessage>
        </Box>
      )}
    </Box>
  );
}

// ─── Action Bar ─────────────────────────────────────────────────────────────

function ActionBarView({
  mr,
  actionState,
}: {
  mr: MRDashboardProps;
  actionState: ActionState;
}) {
  const pending = actionState.confirm;

  const items: { key: string; label: string; dimmed?: boolean }[] = [];

  if (mr.mergeButton.visible && !mr.mergeButton.disabled) {
    items.push({ key: "m", label: mr.mergeButton.label });
  }
  if (mr.rebaseButton.visible) {
    const behind = mr.rebaseButton.behindBy;
    items.push({ key: "r", label: `${mr.rebaseButton.label}${behind > 0 ? ` (${behind} behind)` : ""}` });
  }
  items.push({ key: "R", label: "Local rebase" });
  items.push({ key: "a", label: "Approve" });
  if (mr.autoMergeButton.visible) {
    items.push({
      key: "M",
      label: mr.autoMergeButton.isActive ? "Auto-merge ✓" : "Auto-merge",
    });
  }
  if (mr.isDraft) {
    items.push({ key: "d", label: "Mark ready" });
  }
  if (mr.pipeline) {
    items.push({ key: "p", label: "Pipeline" });
  }
  items.push({ key: "o", label: "Open in browser" });

  return (
    <Box gap={2} flexWrap="wrap">
      {items.map((item) => {
        const isConfirming = pending?.key === item.key;
        return (
          <Text key={item.key} dimColor={item.dimmed && !isConfirming}>
            <Text color={isConfirming ? "yellow" : "cyan"} bold={isConfirming}>[{item.key}]</Text>
            {" "}
            {isConfirming ? (
              <Text color="yellow" bold>press [{item.key}] again to confirm</Text>
            ) : (
              <Text>{item.label}</Text>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
// ─── Trace log formatting ───────────────────────────────────────────────────

/** Strip GitLab CI section markers and clean up trace lines, preserving ANSI color codes */
export function cleanTraceLine(line: string): string {
  // Strip GitLab section markers: \x1b[0Ksection_start:...\r\x1b[0K / section_end:...
  let cleaned = line
    .replace(/\x1b\[0Ksection_(start|end):[^\r\n]*/g, "")
    .replace(/\r/g, "")
    // Strip leading/trailing reset sequences that add no value
    .replace(/^\x1b\[0;m/, "")
    .replace(/\x1b\[0;m$/, "");

  // If line already has ANSI color codes, leave it as-is (GitLab colored it)
  if (/\x1b\[\d+/.test(cleaned)) return cleaned;

  // Pattern-based colorization for plain lines
  const lower = cleaned.toLowerCase();

  // Error patterns → red
  if (/\b(error|ERR!|FAIL|fatal|panic|exception)\b/i.test(cleaned)) {
    return `\x1b[31m${cleaned}\x1b[0m`;
  }
  // Warning patterns → yellow
  if (/\b(warn(ing)?|WARN|deprecated)\b/i.test(cleaned)) {
    return `\x1b[33m${cleaned}\x1b[0m`;
  }
  // Command prefix ($ ...) → cyan
  if (/^\$\s/.test(cleaned)) {
    return `\x1b[36m${cleaned}\x1b[0m`;
  }
  // Pass/success patterns → green
  if (/\b(pass(ed)?|success(ful)?|✓|ok)\b/i.test(cleaned) && !lower.includes("fail")) {
    return `\x1b[32m${cleaned}\x1b[0m`;
  }

  return cleaned;
}

// ─── Pipeline Detail View ───────────────────────────────────────────────────
function formatDuration(seconds: number | null): string {
  if (seconds == null) return "";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function jobStatusIcon(status: string, allowFailure = false): { icon: string; color: string; isSpinner?: boolean } {
  switch (status) {
    case "success": return { icon: "✓", color: "green" };
    case "failed": return allowFailure
      ? { icon: "⚠", color: "yellow" }   // allowed failure — warning, not error
      : { icon: "✗", color: "red" };
    case "running": return { icon: "", color: "blue", isSpinner: true };
    case "pending":
    case "waiting_for_resource":
    case "preparing":
    case "created": return { icon: "○", color: "yellow" };
    case "canceled": return { icon: "⊘", color: "gray" };
    case "skipped": return { icon: "⊘", color: "gray" };
    case "manual": return { icon: "▸", color: "cyan" };
    case "scheduled": return { icon: "◷", color: "cyan" };
    default: return { icon: "?", color: "gray" };
  }
}

export function PipelineDetailView({
  pipeline,
  focusedJobIndex,
  actionState,
  breadcrumb,
  handleInput = false,
}: {
  pipeline: Pipeline | MRDashboardProps["pipeline"] | null;
  focusedJobIndex: number;
  actionState: ActionState;
  breadcrumb?: string | null;
  /** If true, the list handles its own up/down scrolling (useful in standalone panes). Default false. */
  handleInput?: boolean;
}) {
  if (!pipeline) {
    return <StatusMessage variant="info">No pipeline data</StatusMessage>;
  }

  // Group jobs by stage, maintaining order
  const stages: { name: string; jobs: (PipelineJob & { globalIndex: number })[] }[] = [];
  const stageMap = new Map<string, typeof stages[number]>();
  let globalIdx = 0;
  for (const job of pipeline.jobs) {
    let stage = stageMap.get(job.stage);
    if (!stage) {
      stage = { name: job.stage, jobs: [] };
      stageMap.set(job.stage, stage);
      stages.push(stage);
    }
    stage.jobs.push({ ...job, globalIndex: globalIdx++ });
  }

  // Flatten stages + jobs into a single array of rows for ScrollableList.
  // Stage headers don't count as focusable items; we track the "visual row" index
  // of each job to set focusedIndex on the ScrollableList.
  const rows: React.ReactNode[] = [];
  const jobVisualRow: number[] = []; // jobVisualRow[globalIdx] = row index in `rows`

  for (const stage of stages) {
    rows.push(
      <Box key={`stage-${stage.name}`}>
        <Text dimColor bold>── {stage.name} </Text>
        <Text dimColor>{"─".repeat(Math.max(1, 40 - stage.name.length))}</Text>
      </Box>
    );
    for (const job of stage.jobs) {
      jobVisualRow[job.globalIndex] = rows.length;
      const si = jobStatusIcon(job.status, job.allowFailure);
      const focused = job.globalIndex === focusedJobIndex;
      const bg = focused ? "#334155" : undefined;
      const hasChildren = !!job.downstreamPipeline;
      const childCount = hasChildren ? job.downstreamPipeline!.jobs.length : 0;
      rows.push(
        <Box key={job.id} gap={1}>
          <Text backgroundColor={bg} color={focused ? "cyan" : "white"}>{focused ? "▸" : " "}</Text>
          {si.isSpinner ? (
            <Spinner />
          ) : (
            <Text backgroundColor={bg} color={si.color}>{si.icon}</Text>
          )}
          <Text backgroundColor={bg} bold={focused}>{rpad(job.name, 35)}</Text>
          <Text backgroundColor={bg} dimColor>{lpad(formatDuration(job.duration), 8)}</Text>
          {job.allowFailure && <Text backgroundColor={bg} color="gray"> (allowed)</Text>}
          {hasChildren && <Text backgroundColor={bg} color="cyan"> ▶ {childCount} jobs</Text>}
        </Box>
      );
    }
  }

  const pi = pipelineIcon(pipeline);
  // Which visual row is the focused job on?
  const scrollFocusedRow = jobVisualRow[focusedJobIndex] ?? 0;

  const pipelineRunning = pipeline.status === "running" || pipeline.status === "pending";
  const spinnerChar = useSpinnerChar(pipelineRunning);

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* Header */}
      <Box gap={1} marginBottom={1}>
        <Text color={pi.color} bold>{pipelineRunning ? spinnerChar : pi.icon}</Text>
        <Text bold>{breadcrumb ? `Child Pipeline` : `Pipeline`}</Text>
        <Text dimColor>— {pipeline.status}</Text>
        {"passing" in pipeline && <Text dimColor>· {pipeline.passing}/{pipeline.total} passed</Text>}
        {breadcrumb && <Text dimColor>· via {breadcrumb}</Text>}
      </Box>

      {/* Scrollable job list */}
      <ScrollableList
        reservedRows={8}
        focusedIndex={handleInput ? undefined : scrollFocusedRow}
        handleInput={handleInput}
      >
        {rows}
      </ScrollableList>

      {/* Action feedback */}
      {actionState.loading && (
        <Box paddingLeft={2} marginTop={1}>
          <Spinner label={actionState.loading} />
        </Box>
      )}
      {actionState.result && (
        <Box paddingLeft={2} marginTop={1}>
          <StatusMessage variant={actionState.result.ok ? "success" : "error"}>
            {actionState.result.message}
          </StatusMessage>
        </Box>
      )}
    </Box>
  );
}

export function JobLogView({
  job,
  trace,
  onScrollTop,
}: {
  job: PipelineJob;
  trace: {
    loading: boolean;
    error?: string;
    lines: string[];
    hasMore: boolean;
    followTail: boolean;
    displayedFrom: number;
    prependedCount: number;
  };
  onScrollTop: () => void;
}) {
  const si = jobStatusIcon(job.status, job.allowFailure);

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* Header */}
      <Box gap={1} marginBottom={1}>
        {si.isSpinner ? (
          <Spinner />
        ) : (
          <Text color={si.color} bold>{si.icon}</Text>
        )}
        <Text bold>{job.name}</Text>
        <Text dimColor>— {job.status}</Text>
        {job.duration != null && <Text dimColor>· {formatDuration(job.duration)}</Text>}
        <Text dimColor>· Stage: {job.stage}</Text>
        {job.allowFailure && <Text dimColor>· (allow failure)</Text>}
      </Box>

      {/* Log content */}
      {trace.loading ? (
        <Box paddingLeft={2}>
          <Spinner label="Loading job output..." />
        </Box>
      ) : trace.error ? (
        <StatusMessage variant="error">{trace.error}</StatusMessage>
      ) : (
        <>
          {trace.hasMore && (
            <Text dimColor>↑ {trace.displayedFrom} more lines above — scroll up to load
            </Text>
          )}
          {/* No key reset — prependedCount shifts offset smoothly */}
          <ScrollableList
            reservedRows={trace.hasMore ? 7 : 6}
            handleInput={true}
            followTail={trace.followTail}
            thumbColor="gray"
            onScrollTop={trace.hasMore ? onScrollTop : undefined}
            prependedCount={trace.prependedCount}
          >
            {trace.lines.map((line, i) => (
              <Text key={i} wrap="truncate">{line}</Text>
            ))}
          </ScrollableList>
        </>
      )}
    </Box>
  );
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function showStatus(_args: string[]): Promise<void> {
  const data = await fetchStatusData();
  const iidToBranch = new Map<
    number,
    { branch: string; entry: CacheEntry }
  >();

  for (const [branch, entry] of Object.entries(data.branches)) {
    if (entry.mr?.iid) {
      iidToBranch.set(entry.mr.iid, { branch, entry });
    }
  }

  if (iidToBranch.size === 0) {
    const i = render(
      <StatusMessage variant="info">
        No active merge requests to watch
      </StatusMessage>,
    );
    i.unmount();
    return;
  }

  // Enter alternate screen buffer (like fzf/vim) for clean resize
  process.stdout.write("\x1b[?1049h");
  // Restore on exit
  const restoreScreen = () => process.stdout.write("\x1b[?1049l");
  process.on("exit", restoreScreen);
  process.on("SIGINT", () => { restoreScreen(); process.exit(0); });

  const instance = render(
    <LiveDashboard
      initialData={data}
      iidToBranch={iidToBranch}
    />,
  );
  await instance.waitUntilExit();
}


export const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "dev"]);

function LiveDashboard({
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
  const [pipelineView, setPipelineView] = useState(false);
  const [pipelineFromList, setPipelineFromList] = useState(false); // entered via p from list, skip card on esc
  const [jobLogView, setJobLogView] = useState(false);
  const [focusedJobIndex, setFocusedJobIndex] = useState(0);
  // Stack for drilling into child/downstream pipelines
  const [childPipelineStack, setChildPipelineStack] = useState<Array<{ pipeline: Pipeline; parentJobIndex: number }>>([]);
  // Set of job IDs that are bridge/trigger jobs (fetched when entering pipeline view)
  const [bridgeJobIds, setBridgeJobIds] = useState<Set<string>>(new Set());
  const [jobTrace, setJobTrace] = useState<{
    loading: boolean;
    error?: string;
    lines: string[];       // currently visible window
    allLines: string[];    // full trace content
    displayedFrom: number; // index into allLines where visible window starts
    hasMore: boolean;      // are there earlier lines not yet shown?
    followTail: boolean;   // scroll to bottom on first mount
    prependedCount: number; // cumulative lines added to top (for viewport-stable scroll)
  }>({ loading: false, lines: [], allLines: [], displayedFrom: 0, hasMore: false, followTail: false, prependedCount: 0 });
  const [logScrollOffset, setLogScrollOffset] = useState(0);
  const [mergedDays, setMergedDays] = useState(0); // 0=off, 1, 3, 7
  type SortMode = "status" | "pipeline" | "approved" | "newest" | "oldest";
  const SORT_CYCLE: SortMode[] = ["status", "pipeline", "approved", "newest", "oldest"];
  const [sortMode, setSortMode] = useState<SortMode>("newest");
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
        executeAction("m", "Merge", "Merging…", () => focusedActions.merge().then(() => {}));
      }
      if (input === "r" && mr.rebaseButton.visible) {
        executeAction("r", "Rebase", "Rebasing…", () => focusedActions.rebase());
      }
      if (input === "R") {
        // Local rebase: worktree-aware fetch + rebase against target branch
        executeAction("R", "Local rebase", "Rebasing locally…", async () => {
          const { execSync } = await import("child_process");
          const { getKnownRepos } = await import("../lib/repo.ts");
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

  // Daemon WS subscription — the daemon owns the glance-sdk connection; we
  // just consume `mr:update` broadcasts and the aggregated `mr:status` flag.
  useEffect(() => {
    const sub = subscribeToDaemon((ev) => {
      if (ev.type === "mr:update") {
        const mrs = ev.data?.mrs as Record<string, MRDashboardProps> | undefined;
        if (!mrs) return;
        setData((prev) => {
          const newBranches = { ...prev.branches };
          let changed = false;
          for (const [iidStr, mrProps] of Object.entries(mrs)) {
            const iid = Number(iidStr);
            const info = iidToBranch.get(iid);
            if (!info) continue;
            newBranches[info.branch] = {
              ...(newBranches[info.branch] ?? info.entry),
              mr: mrProps,
              fetchedAt: Date.now(),
            };
            changed = true;
          }
          if (!changed) return prev;
          return { ...prev, branches: newBranches, source: "live" as const };
        });
        setHasLiveData(true);
      } else if (ev.type === "mr:status") {
        const c = ev.data?.connection;
        if (c === "connected" || c === "connecting" || c === "disconnected") {
          setConnection(c);
        }
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
    : detailView
    ? "esc back · p pipeline · o open · q quit"
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
        {viewHints ? (
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


