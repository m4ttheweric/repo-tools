/**
 * rt mr-status — Single-branch MR/ticket status card.
 *
 * Spawned by `rt runner` into a tmux pane. Bootstraps its own GitLabProvider
 * from the cached mr.webUrl — no git remote needed. Receives the same
 * fetchJobDetail / fetchJobTrace API as the full status dashboard.
 *
 * Keys (card view):   p=pipeline  o=browser  q=quit
 * Keys (pipeline):    j/k/↑/↓=navigate  ↵=drill/log  o=browser  Esc=back  q=quit
 * Keys (job log):     ↑/↓=scroll  b/Esc=back  q=quit
 */

import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput } from "ink";
import { Spinner } from "@inkjs/ui";
import { execSync } from "child_process";
import type { Pipeline, MRDashboardProps, MRDashboardActions, PipelineJob } from "@workforge/glance-sdk";
import type { CommandContext } from "../lib/command-tree.ts";
import {
  fetchStatusData,
  MRDetailView,
  PipelineDetailView,
  JobLogView,
  cleanTraceLine,
  DEFAULT_BRANCHES,
  type CacheEntry,
  type ActionState,
} from "./status.tsx";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseMrWebUrl(webUrl: string): { host: string; projectPath: string } | null {
  const m = /^(https?:\/\/[^/]+)\/(.+?)\/-\/merge_requests\/\d+/.exec(webUrl);
  if (!m) return null;
  return { host: m[1]!, projectPath: m[2]! };
}

// ─── Types ─────────────────────────────────────────────────────────────────────

const NO_ACTIONS: ActionState = { loading: null, result: null, confirm: null };
type StackEntry = { pipeline: Pipeline; parentJobIndex: number };
type TraceState = {
  loading: boolean;
  error?: string;
  lines: string[];
  allLines: string[];
  displayedFrom: number;
  hasMore: boolean;
  followTail: boolean;
  prependedCount: number;
};
const EMPTY_TRACE: TraceState = {
  loading: false, lines: [], allLines: [], displayedFrom: 0,
  hasMore: false, followTail: false, prependedCount: 0,
};

// ─── App ───────────────────────────────────────────────────────────────────────

function MrStatusApp({
  branch,
  initialEntry,
  actions,
}: {
  branch: string;
  initialEntry: CacheEntry;
  actions: MRDashboardActions | null;
}) {
  const [mr, setMr] = useState<MRDashboardProps>(initialEntry.mr!);
  const [ticket] = useState(initialEntry.ticket ?? undefined);
  const [actionState, setActionState] = useState<ActionState>(NO_ACTIONS);

  const [pipelineView, setPipelineView] = useState(false);
  const [jobLogView, setJobLogView] = useState(false);
  const [focusedJobIndex, setFocusedJobIndex] = useState(0);
  const [childPipelineStack, setChildPipelineStack] = useState<StackEntry[]>([]);
  const [jobTrace, setJobTrace] = useState<TraceState>(EMPTY_TRACE);

  // ── Poll cache as fallback (WebSocket updates flow through the group subscription) ──
  useEffect(() => {
    const t = setInterval(async () => {
      const data = await fetchStatusData();
      const fresh = data.branches[branch]?.mr;
      if (fresh) setMr(fresh);
    }, 5_000);
    return () => clearInterval(t);
  }, [branch]);

  // ── Active pipeline ─────────────────────────────────────────────────────────
  const rootPipeline = mr.pipeline ?? null;
  const activePipeline: Pipeline | typeof rootPipeline =
    childPipelineStack.length > 0
      ? childPipelineStack[childPipelineStack.length - 1]!.pipeline
      : rootPipeline;
  const activeJobs = activePipeline?.jobs ?? [];
  const activeJobCount = activeJobs.length;

  const breadcrumb: string | null = childPipelineStack.length > 0
    ? childPipelineStack.map((c, i) => {
        const parentPl = i === 0 ? rootPipeline : childPipelineStack[i - 1]!.pipeline;
        return parentPl?.jobs?.[c.parentJobIndex]?.name ?? "child";
      }).join(" › ")
    : null;

  // ── Load more trace lines (viewport-stable) ─────────────────────────────────
  const loadMoreTraceLines = useCallback(() => {
    setJobTrace((prev) => {
      if (prev.displayedFrom === 0 || prev.loading) return prev;
      const newFrom = Math.max(0, prev.displayedFrom - 200);
      const delta = prev.displayedFrom - newFrom;
      return {
        ...prev,
        lines: prev.allLines.slice(newFrom),
        displayedFrom: newFrom,
        hasMore: newFrom > 0,
        followTail: false,
        prependedCount: prev.prependedCount + delta,
      };
    });
  }, []);

  // ── Enter key: drill into child pipeline or show job trace ─────────────────
  const handleEnter = useCallback(() => {
    if (!activePipeline) return;
    const job = activeJobs[focusedJobIndex] as PipelineJob | undefined;
    if (!job) return;

    const numericId = parseInt(job.id.split(":").pop() || "0", 10);
    const numericPipelineId = parseInt(activePipeline.id?.split(":").pop() || "0", 10) || undefined;

    if (actions) {
      setActionState({ loading: "Loading…", result: null, confirm: null });
      actions.fetchJobDetail(numericId, numericPipelineId).then((detail: any) => {
        setActionState(NO_ACTIONS);
        if (detail.type === "bridge") {
          // Bridge/trigger job → drill into child pipeline using live data
          const downstream = detail.downstreamPipeline ?? (job as any).downstreamPipeline;
          if (downstream) {
            setChildPipelineStack((s) => [...s, { pipeline: downstream, parentJobIndex: focusedJobIndex }]);
            setFocusedJobIndex(0);
          } else {
            setActionState({ loading: null, result: { ok: false, message: "No downstream pipeline data" }, confirm: null });
          }
        } else {
          // Regular job → show trace log
          const allLines = (detail.content ?? "").split("\n").map(cleanTraceLine);
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
    } else if ((job as any).downstreamPipeline) {
      // Fallback: use cached downstream pipeline
      setChildPipelineStack((s) => [...s, {
        pipeline: (job as any).downstreamPipeline,
        parentJobIndex: focusedJobIndex,
      }]);
      setFocusedJobIndex(0);
    }
  }, [actions, activePipeline, activeJobs, focusedJobIndex]);

  // ── Input ───────────────────────────────────────────────────────────────────
  useInput((input, key) => {
    if (actionState.loading) return;

    // Job log view
    if (jobLogView) {
      if (key.escape || input === "b") { setJobLogView(false); setActionState(NO_ACTIONS); return; }
      if (input === "q") process.exit(0);
      // Scroll handled by ScrollableList's own useInput
      return;
    }

    // Pipeline view
    if (pipelineView) {
      if (key.escape) {
        if (childPipelineStack.length > 0) {
          const top = childPipelineStack[childPipelineStack.length - 1]!;
          setChildPipelineStack((s) => s.slice(0, -1));
          setFocusedJobIndex(top.parentJobIndex);
        } else {
          setPipelineView(false);
        }
        setActionState(NO_ACTIONS);
        return;
      }
      if (input === "q") { process.exit(0); return; }
      if (input === "j" || key.downArrow) { setFocusedJobIndex((i) => Math.min(i + 1, Math.max(0, activeJobCount - 1))); return; }
      if (input === "k" || key.upArrow)   { setFocusedJobIndex((i) => Math.max(i - 1, 0)); return; }
      if (key.return) { handleEnter(); return; }
      if (input === "o") {
        const job = activeJobs[focusedJobIndex];
        if (job?.webUrl) try { execSync(`open ${JSON.stringify(job.webUrl)}`, { stdio: "ignore" }); } catch {}
        return;
      }
      return;
    }

    // Card view
    if (input === "q") process.exit(0);
    if (input === "p" && rootPipeline) { setFocusedJobIndex(0); setChildPipelineStack([]); setActionState(NO_ACTIONS); setPipelineView(true); }
    if (input === "o" && mr.webUrl) try { execSync(`open ${JSON.stringify(mr.webUrl)}`, { stdio: "ignore" }); } catch {}
  });

  // ── Render: job log ─────────────────────────────────────────────────────────
  if (pipelineView && jobLogView) {
    const job = activeJobs[focusedJobIndex] as PipelineJob | undefined;
    if (job) {
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box paddingLeft={1} marginBottom={1}>
            <Text dimColor>[↑/↓] scroll  [b/Esc] back  [q] quit</Text>
          </Box>
          <JobLogView job={job} trace={jobTrace} onScrollTop={loadMoreTraceLines} />
        </Box>
      );
    }
  }

  // ── Render: pipeline ────────────────────────────────────────────────────────
  if (pipelineView) {
    const focusedJob = activeJobs[focusedJobIndex] as PipelineJob | undefined;
    const depthLabel = childPipelineStack.length > 0 ? ` · depth ${childPipelineStack.length}` : "";
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box paddingLeft={1} marginBottom={1}>
          <Text dimColor>
            [j/k] nav  [↵] open  [o] browser  [Esc] back{depthLabel}  [q] quit
          </Text>
        </Box>
        {actionState.loading && <Box paddingLeft={1}><Spinner label={actionState.loading} /></Box>}
        {actionState.result && (
          <Box paddingLeft={1}>
            <Text color={actionState.result.ok ? "green" : "red"}>{actionState.result.message}</Text>
          </Box>
        )}
        <PipelineDetailView
          pipeline={activePipeline}
          focusedJobIndex={focusedJobIndex}
          actionState={NO_ACTIONS}
          breadcrumb={breadcrumb}
          handleInput={false}
        />
      </Box>
    );
  }

  // ── Render: card ────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" marginTop={1}>
      <MRDetailView mr={mr} ticket={ticket} actionState={NO_ACTIONS} />
    </Box>
  );
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function showMrStatus(args: string[], _ctx: CommandContext): Promise<void> {
  const branch = args[0] ?? "";

  if (!branch || DEFAULT_BRANCHES.has(branch)) {
    const { waitUntilExit } = render(
      <Box flexDirection="column" marginTop={1} paddingLeft={1}>
        <Text dimColor>⎇  {branch || "no branch"}</Text>
        <Text dimColor>   no merge request</Text>
      </Box>
    );
    await waitUntilExit();
    return;
  }

  const data = await fetchStatusData();
  const entry = data.branches[branch];

  if (!entry?.mr) {
    const { waitUntilExit } = render(
      <Box flexDirection="column" marginTop={1} paddingLeft={1}>
        <Text dimColor>⎇  {branch}</Text>
        <Text dimColor>   no merge request</Text>
      </Box>
    );
    await waitUntilExit();
    return;
  }

  // Bootstrap GitLab provider from mr.webUrl (no git remote needed)
  let actions: MRDashboardActions | null = null;
  try {
    const { loadSecrets } = await import("../lib/linear.ts");
    const secrets = loadSecrets();
    if (secrets.gitlabToken && entry.mr.webUrl) {
      const parsed = parseMrWebUrl(entry.mr.webUrl);
      if (parsed) {
        const { GitLabProvider, createDashboard } = await import("@workforge/glance-sdk");
        const provider = new GitLabProvider(parsed.host, secrets.gitlabToken);
        let userId: number | null = null;
        try {
          const user = await provider.validateToken();
          const numId = user.id.split(":").pop();
          userId = numId ? parseInt(numId, 10) : null;
        } catch { /* continue without userId */ }
        const group = createDashboard({ provider, projectPath: parsed.projectPath, mrIid: [entry.mr.iid], userId });
        actions = group.actionsFor(entry.mr.iid);
      }
    }
  } catch { /* non-fatal — falls back to cached data */ }

  const { waitUntilExit } = render(
    <MrStatusApp branch={branch} initialEntry={entry} actions={actions} />
  );
  await waitUntilExit();
}
