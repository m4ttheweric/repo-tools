/**
 * Parking-lot IPC handlers.
 *
 *   parking-lot:scan      — run the auto-park check immediately.
 *   parking-lot:park-this — park a specific worktree on demand. The CLI
 *                           routes manual `rt park this` through here so the
 *                           caller can animate a spinner while awaiting the
 *                           result (the work itself is execSync-blocking).
 */

import { checkAndPark, park } from "../parking-lot.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

export function createParkingLotHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "parking-lot:scan": async () => {
      try {
        checkAndPark({ cache: ctx.cache, repoIndex: ctx.repoIndex });
        return { ok: true, data: { lines: [] } };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    "parking-lot:park-this": async (payload: any) => {
      const { worktreePath, repoPath, branch, index } = payload ?? {};
      // `branch` is intentionally optional — null/undefined means the worktree
      // is detached (a warm-pool entry being claimed onto its slot).
      if (!worktreePath || !repoPath || typeof index !== "number") {
        return { ok: false, error: "missing payload fields" };
      }

      try {
        const result = park(worktreePath, repoPath, branch ?? null, index);
        return { ok: true, data: { result, lines: [] } };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  };
}
