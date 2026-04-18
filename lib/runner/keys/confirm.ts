/**
 * Confirmation modal keymaps: confirm-reset and confirm-spread.
 *
 * Both return two keymaps since they're registered as separate modes
 * ("confirm-reset" / "confirm-spread") with different y-handlers but
 * identical n / escape behavior.
 */

import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import type { KeymapContext, KeymapHandlers } from "./types.ts";

export function createConfirmResetKeymap(ctx: KeymapContext): KeymapHandlers {
  return {
    y: ({ state, update }) => {
      ctx.doDispatch({ type: "reset" }, state);
      update((s) => ({ ...s, mode: { type: "normal" } }));
      ctx.setMode("default");
    },
    n: ({ update }) => { update((s) => ({ ...s, mode: { type: "normal" } })); ctx.setMode("default"); },
    escape: ({ update }) => { update((s) => ({ ...s, mode: { type: "normal" } })); ctx.setMode("default"); },
  };
}

export function createConfirmSpreadKeymap(ctx: KeymapContext): KeymapHandlers {
  return {
    y: ({ state, update }) => {
      const mode = state.mode;
      if (mode.type !== "confirm-spread") return;
      const lane = state.lanes.find((l) => l.id === mode.laneId);
      const entry = lane?.entries.find((e) => e.id === mode.entryId);
      if (!lane || !entry) {
        update((s) => ({ ...s, mode: { type: "normal" } }));
        ctx.setMode("default");
        return;
      }
      // Only spread to worktrees that don't already have an entry with this command
      const sameGroupWorktrees = new Set(
        lane.entries.filter((e) => e.commandTemplate === entry.commandTemplate).map((e) => e.worktree)
      );
      const repo = state.knownRepos.find((r) => r.repoName === lane.repoName);
      const worktrees = repo?.worktrees ?? [];
      const relPath = relative(entry.worktree, entry.targetDir);
      let added = 0;
      for (const wt of worktrees) {
        if (sameGroupWorktrees.has(wt.path)) continue;
        const targetDir = relPath ? join(wt.path, relPath) : wt.path;
        if (!existsSync(targetDir)) continue;
        void ctx.addResolvedEntry(lane.id, {
          targetDir,
          pm: entry.pm,
          script: entry.script,
          packageLabel: entry.packageLabel,
          worktree: wt.path,
          branch: wt.branch,
        });
        added++;
      }
      ctx.showToast(
        added > 0
          ? `added to ${added} worktree${added === 1 ? "" : "s"}`
          : "no new worktrees to add",
      );
      update((s) => ({ ...s, mode: { type: "normal" } }));
      ctx.setMode("default");
    },
    n: ({ update }) => { update((s) => ({ ...s, mode: { type: "normal" } })); ctx.setMode("default"); },
    escape: ({ update }) => { update((s) => ({ ...s, mode: { type: "normal" } })); ctx.setMode("default"); },
  };
}
