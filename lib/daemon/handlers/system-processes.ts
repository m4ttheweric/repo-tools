/**
 * System process IPC handler.
 *
 *   system-processes — all repo-associated processes discovered by
 *   SystemProcessScanner (CPU/memory/runaway status), enriched with the
 *   Linear ticket for each process's branch from the daemon's branch cache.
 */

import type { HandlerMap, HandlerContext } from "./types.ts";
import type { SystemProcessScanner } from "../system-process-scanner.ts";

export function createSystemProcessHandlers(
  scanner: SystemProcessScanner,
  ctx: HandlerContext,
): HandlerMap {
  return {
    "system-processes": async () => {
      // Enrich with Linear ticket from branch cache
      const processes = scanner.getProcesses().map(proc => {
        let linearTicket: string | null = null;
        if (proc.branch) {
          const cacheEntry = ctx.cache.entries[proc.branch];
          if (cacheEntry?.ticket) {
            linearTicket = `${cacheEntry.ticket.identifier}: ${cacheEntry.ticket.title}`;
          }
        }
        return { ...proc, linearTicket };
      });

      return {
        ok: true,
        data: {
          processes,
          updatedAt: Date.now(),
        },
      };
    },
  };
}
