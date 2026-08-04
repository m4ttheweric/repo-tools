/**
 * Shared types for the rt status dashboard.
 */

import type { PortEntry } from "../../lib/port-scanner.ts";
import type { MRDashboardProps } from "@mattstack/glance";

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

export interface StatusData {
  branches: Record<string, CacheEntry>;
  ports: PortEntry[];
  source: "daemon" | "cache-file" | "live";
}

export type ActionPending = {
  key: string;
  label: string;
  action: () => Promise<void>;
} | null;

export type ActionState = {
  loading: string | null; // label while loading
  result: { ok: boolean; message: string } | null;
  confirm: ActionPending;
};

export type SortMode = "status" | "pipeline" | "approved" | "newest" | "oldest";

export const SORT_CYCLE: SortMode[] = ["status", "pipeline", "approved", "newest", "oldest"];

export interface JobTraceState {
  loading: boolean;
  error?: string;
  lines: string[];       // currently visible window
  allLines: string[];    // full trace content
  displayedFrom: number; // index into allLines where visible window starts
  hasMore: boolean;      // are there earlier lines not yet shown?
  followTail: boolean;   // scroll to bottom on first mount
  prependedCount: number; // cumulative lines added to top (for viewport-stable scroll)
}
