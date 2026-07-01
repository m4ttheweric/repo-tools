/**
 * rt status — Live interactive branch dashboard.
 *
 * WebSocket-powered real-time MR dashboard with navigation,
 * detail drill-down, and inline actions (merge, rebase, approve, etc.)
 *
 * Module layout:
 *   types.ts               shared types (CacheEntry, StatusData, ActionState, …)
 *   data.ts                fetchStatusData (daemon cache/port reads)
 *   format.ts              pure formatting helpers + status/color maps
 *   markdown.tsx           inline markdown renderer for comment bodies
 *   mr-views.tsx           MR list row + detail card views
 *   reviews.tsx            reviews sub-view + per-reviewer comment threads
 *   pipeline.tsx           pipeline detail + job log views
 *   dashboard.tsx          LiveDashboard state, effects, and view routing
 *   use-dashboard-input.ts keyboard handling for every dashboard view
 */

import { render } from "ink";
import { StatusMessage } from "@inkjs/ui";
import { fetchStatusData } from "./data.ts";
import type { CacheEntry } from "./types.ts";
import { LiveDashboard } from "./dashboard.tsx";

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

// ─── Public surface ──────────────────────────────────────────────────────────

export { fetchStatusData } from "./data.ts";
export type { CacheEntry, ActionState } from "./types.ts";
export { cleanTraceLine } from "./format.ts";
export { MRDetailView } from "./mr-views.tsx";
export {
  buildAllCommenterSummaries,
  groupThreadsByFile,
  ReviewsView,
  CommentView,
  INITIAL_DISCUSSIONS_STATE,
  type DiscussionsState,
  type FileGroup,
} from "./reviews.tsx";
export { PipelineDetailView, JobLogView } from "./pipeline.tsx";
export { DEFAULT_BRANCHES } from "./dashboard.tsx";
