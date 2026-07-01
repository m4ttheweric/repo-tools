/**
 * Pipeline detail and job log views — stage-grouped scrollable job list with
 * child-pipeline drill-down, and the per-job trace log viewer.
 */

import type React from "react";
import { Box, Text } from "ink";
import { Spinner, StatusMessage } from "@inkjs/ui";
import type { MRDashboardProps, Pipeline, PipelineJob } from "@workforge/glance-sdk";
import { ScrollableList } from "../../lib/ScrollableList.tsx";
import { rpad, lpad } from "../../lib/tui/utils/label.ts";
import { useSpinnerFrame } from "../../lib/tui/hooks/use-spinner.ts";
import type { ActionState } from "./types.ts";
import { pipelineIcon, jobStatusIcon, formatDuration } from "./format.ts";

// ─── Pipeline Detail View ───────────────────────────────────────────────────

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
  const spinnerChar = useSpinnerFrame(pipelineRunning);

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
