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
      // Capture log lines emitted during the scan so we can echo them back
      // to the CLI caller. The daemon's own log still gets them too.
      const lines: string[] = [];
      const tee = (msg: string) => {
        lines.push(msg);
        ctx.log(msg);
      };

      try {
        checkAndPark({ cache: ctx.cache, repoIndex: ctx.repoIndex, log: tee });
        return { ok: true, data: { lines } };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    "parking-lot:park-this": async (payload: any) => {
      const { worktreePath, repoPath, branch, index } = payload ?? {};
      if (!worktreePath || !repoPath || !branch || typeof index !== "number") {
        return { ok: false, error: "missing payload fields" };
      }

      const lines: string[] = [];
      const tee = (msg: string) => {
        lines.push(msg);
        ctx.log(msg);
      };

      try {
        const result = park(worktreePath, repoPath, branch, index, tee);
        return { ok: true, data: { result, lines } };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  };
}
