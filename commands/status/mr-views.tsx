/**
 * MR list row and detail views — mirrors glance-react's MRRow / MRCard,
 * plus the compact/detailed pipeline, diff, reviewer, and blocker sections
 * and the detail-view action bar.
 */

import { Box, Text } from "ink";
import { Badge, Spinner, StatusMessage } from "@inkjs/ui";
import type { MRDashboardProps, PipelineJob, Reviewer } from "@workforge/glance-sdk";
import { getReviewDisplayState } from "@workforge/glance-sdk";
import { truncate, rpad, lpad, timeAgo } from "../../lib/tui/utils/label.ts";
import { useSpinnerFrame } from "../../lib/tui/hooks/use-spinner.ts";
import { useTerminalWidth } from "../../lib/tui/hooks/use-terminal-width.ts";
import type { ActionState, CacheEntry } from "./types.ts";
import {
  STATUS_COLOR,
  STATUS_LABEL,
  STATUS_ART,
  REVIEW_ICON,
  REVIEW_COLOR,
  pipelineIcon,
  jobStatusIcon,
} from "./format.ts";

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

export function MRRowTUI({
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
  const spinnerChar = useSpinnerFrame(pipelineRunning);

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
