import type { HandlerMap, HandlerContext } from "./types.ts";
import type { SystemProcessScanner, SystemProcess } from "../system-process-scanner.ts";

function buildProcessTree(flat: SystemProcess[]): SystemProcess[] {
  const byPid = new Map<number, SystemProcess>();
  for (const proc of flat) {
    byPid.set(proc.pid, { ...proc, children: [] });
  }

  const roots: SystemProcess[] = [];
  for (const proc of byPid.values()) {
    const parent = byPid.get(proc.ppid);
    if (parent) {
      parent.children!.push(proc);
    } else {
      roots.push(proc);
    }
  }

  // Aggregate children's CPU/memory into parent for the summary display
  function sumTree(node: SystemProcess): { cpu: number; rss: number } {
    let cpu = node.cpuPercent;
    let rss = node.rssKb;
    for (const child of node.children ?? []) {
      const sub = sumTree(child);
      cpu += sub.cpu;
      rss += sub.rss;
    }
    return { cpu, rss };
  }

  // Attach aggregate stats so the UI can show "claude 0.3% (total 0.5%)"
  for (const root of roots) {
    const total = sumTree(root);
    (root as any).totalCpuPercent = total.cpu;
    (root as any).totalRssKb = total.rss;
  }

  return roots;
}

export function createSystemProcessHandlers(
  scanner: SystemProcessScanner,
  ctx: HandlerContext,
): HandlerMap {
  return {
    "system-processes": async () => {
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

      const tree = buildProcessTree(processes);

      return {
        ok: true,
        data: {
          processes: tree,
          updatedAt: Date.now(),
        },
      };
    },
  };
}
