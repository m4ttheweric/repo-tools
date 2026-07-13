import type { HandlerMap, HandlerContext } from "./types.ts";
import type { SystemProcessScanner, SystemProcess } from "../system-process-scanner.ts";

function shortName(proc: SystemProcess): string {
  // Use fullCommand (complete argv) to get the real binary name,
  // since macOS truncates the comm field at ~16 chars
  const argv0 = proc.fullCommand.split(" ")[0] ?? proc.command;
  const base = argv0.split("/").pop() ?? argv0;
  return base || proc.command;
}

function flattenSingleChildChains(node: SystemProcess): SystemProcess {
  node.children = (node.children ?? []).map(flattenSingleChildChains);

  const crumbs: string[] = [];
  const chainPids: number[] = [];
  let current = node;
  while (current.children?.length === 1) {
    crumbs.push(shortName(current));
    chainPids.push(current.pid);
    current = current.children[0]!;
  }

  if (crumbs.length > 0) {
    return {
      ...current,
      command: [...crumbs, shortName(current)].join(" › "),
      pid: node.pid,
      ppid: node.ppid,
      // The row shows the chain root's pid; keep every collapsed pid so
      // kill actions can signal the whole chain, not just the root.
      // current may itself be an already-flattened chain — merge its pids.
      chainPids: [...chainPids, ...(current.chainPids ?? [current.pid])],
    };
  }

  return { ...node, command: shortName(node) };
}

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

  const flattened = roots.map(flattenSingleChildChains);

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

  for (const root of flattened) {
    const total = sumTree(root);
    (root as any).totalCpuPercent = total.cpu;
    (root as any).totalRssKb = total.rss;
  }

  return flattened;
}

export function createSystemProcessHandlers(
  scanner: SystemProcessScanner,
  ctx: HandlerContext,
): HandlerMap {
  // The background scanner refreshes every 10s; the tray polls far faster
  // while its panel is open. Re-discover on read when the cache is older than
  // this so a poll reflects current reality (new/dead processes) instead of
  // up-to-10s-stale data. `refresh` deliberately skips the runaway sample
  // window, so scanning more often here can't trip a premature alert.
  const STALE_READ_MS = 1500;

  return {
    "system-processes": async () => {
      if (scanner.msSinceLastScan() > STALE_READ_MS) {
        scanner.refresh(ctx.portCacheRef.ports);
      }
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
          ready: scanner.hasCompletedScan,
        },
      };
    },
  };
}
