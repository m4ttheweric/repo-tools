/**
 * App — top-level screen router for the unified Ink CLI.
 *
 * Manages flow: worktree selection → port checks → dashboard.
 * All process management happens via callbacks — no Bun.spawn here.
 */
import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import type { DetectedWorktree, ResolvedWorktree } from "../lib";
import { WorktreeSelector } from "./WorktreeSelector.tsx";
import { Dashboard, type DashboardProps } from "./Dashboard.tsx";

// ── Types ──────────────────────────────────────────────────

export interface AppProps {
  /** All detected git worktrees */
  allWorktrees: DetectedWorktree[];
  /** Previously saved worktree selection (dirs) */
  savedSelection: string[] | null;
  /**
   * Called when user confirms worktree selection.
   * The orchestrator resolves worktrees, spawns tilt/proxy, and returns dashboard props.
   */
  onSelected: (selected: DetectedWorktree[]) => Promise<DashboardProps>;
}

type Screen =
  | { type: "selector" }
  | { type: "single-worktree"; dashboardProps: DashboardProps }
  | { type: "dashboard"; dashboardProps: DashboardProps };

// ── App ────────────────────────────────────────────────────

export function App({ allWorktrees, savedSelection, onSelected }: AppProps) {
  const [screen, setScreen] = useState<Screen>(() => {
    if (allWorktrees.length === 1) {
      // Single worktree — skip selector, but we need dashboardProps from onSelected
      return { type: "selector" }; // will auto-confirm in useEffect-like pattern below
    }
    return { type: "selector" };
  });

  const [autoStarted, setAutoStarted] = useState(false);

  const handleConfirm = useCallback(async (selected: DetectedWorktree[]) => {
    const dashboardProps = await onSelected(selected);
    setScreen({ type: "dashboard", dashboardProps });
  }, [onSelected]);

  // Auto-confirm for single worktree
  if (allWorktrees.length === 1 && !autoStarted && screen.type === "selector") {
    setAutoStarted(true);
    handleConfirm(allWorktrees);
  }

  if (screen.type === "selector") {
    if (allWorktrees.length === 1) {
      return (
        <Box>
          <Text dimColor>Single worktree detected — starting directly…</Text>
        </Box>
      );
    }
    return (
      <WorktreeSelector
        worktrees={allWorktrees}
        savedSelection={savedSelection}
        onConfirm={handleConfirm}
      />
    );
  }

  return <Dashboard {...screen.dashboardProps} />;
}
