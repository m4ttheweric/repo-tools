/**
 * Periodic background work — cache refresh, port scanning, system-process
 * scanning, and the hooks-guard fallback rescan.
 *
 * All intervals live here so daemon.ts stays a thin wiring layer.
 */

import { existsSync } from "fs";
import type { Logger } from "pino";
import { scanListeningPorts, type PortEntry } from "../port-scanner.ts";
import { checkRunawayProcesses } from "../notifier.ts";
import { primeTeamTrackingIdentityMap } from "../repo-tracking.ts";
import type { SystemProcessScanner } from "./system-process-scanner.ts";
import type { PortCacheRef, RepoIndex } from "./handlers/types.ts";
import { demandedWithin } from "./demand-tracker.ts";
import { makeCoalescer } from "./cache-refresh.ts";

const MR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;        // 5 minutes
const PORT_SCAN_INTERVAL_MS = 30 * 1000;             // 30 seconds
const HOOKS_SCAN_INTERVAL_MS = 60 * 1000;            // 60 seconds (fallback for stale watchers)
const SYSTEM_PROCESS_SCAN_INTERVAL_MS = 10 * 1000;   // 10 seconds
/** Consider a consumer "present" for 5 min after its last scan-backed read. */
const DEMAND_WINDOW_MS = 5 * 60 * 1000;
/**
 * Abandon a wedged port/process scan after this long so a later tick is not
 * latched out forever (R047). Both scans chain multiple subprocess calls
 * whose own runCapture timeouts can stack to ~20s worst case, so this sits
 * well above that -- it only fires for a genuinely hung child, not a slow one.
 */
const SCAN_DEADLINE_MS = 45 * 1000;

export interface PollerDeps {
  log: Logger;
  refreshCache: () => Promise<void>;
  /** Mutated in place so handlers read fresh port values without getters. */
  portCacheRef: PortCacheRef;
  broadcast: (type: string, data: any) => void;
  systemProcessScanner: SystemProcessScanner;
  repoIndex: () => RepoIndex;
  checkAndRepairHooksPath: (repoName: string, repoPath: string) => Promise<boolean>;
  /** Test seam: overrides the real lsof/ps port scan. */
  scanPorts?: () => Promise<PortEntry[]>;
  /** Test seam: overrides the real "consumer read recently" demand check. */
  demanded?: () => boolean;
  /** Test seam: overrides SCAN_DEADLINE_MS for both scans. */
  scanDeadlineMs?: number;
}

export interface PollersHandle {
  /** Clears every timer this armed, so the pollers unit's reverse-stop leaves
   *  no interval or pending initial-scan timeout running. */
  stop(): void;
  /** Test seam: run one port-scan tick now. */
  tickPorts(): Promise<void>;
  /** Test seam: run one process-scan tick now. */
  tickProcesses(): Promise<void>;
}

export function startPollers(deps: PollerDeps): PollersHandle {
  const { log, refreshCache, portCacheRef, broadcast, systemProcessScanner } = deps;
  const scanPorts = deps.scanPorts ?? scanListeningPorts;
  const demanded = deps.demanded ?? (() => demandedWithin(DEMAND_WINDOW_MS));
  const scanDeadlineMs = deps.scanDeadlineMs ?? SCAN_DEADLINE_MS;

  // In-flight + deadline guard: the scans are async, so a slow scan must not
  // overlap the next tick (the runaway math assumes one sample per 10s), and
  // a wedged one must not latch out every later tick forever (R047).
  const runPortScan = makeCoalescer(
    async () => {
      try {
        portCacheRef.ports = await scanPorts();
        portCacheRef.updatedAt = Date.now();
        log.debug({ count: portCacheRef.ports.length }, "ports scanned");

        broadcast("ports", { ports: portCacheRef.ports, updatedAt: portCacheRef.updatedAt });
      } catch (err) {
        log.error({ err }, "port scan failed");
      }
    },
    scanDeadlineMs,
    () => log.warn("port scan timed out; cleared in-flight latch for next tick"),
  );

  const runProcessScan = makeCoalescer(
    async () => {
      try {
        const processes = await systemProcessScanner.scan(portCacheRef.ports);
        broadcast("system-processes", {
          processes,
          updatedAt: Date.now(),
        });

        // Check for new runaways to notify about
        checkRunawayProcesses(
          processes,
          (pid) => systemProcessScanner.markRunawayNotified(pid),
          (pid) => systemProcessScanner.isRunawayNotified(pid),
        );
      } catch (err) {
        log.error({ err }, "system process scan failed");
      }
    },
    scanDeadlineMs,
    () => log.warn("system process scan timed out; cleared in-flight latch for next tick"),
  );

  async function refreshPortCache(): Promise<void> {
    if (!demanded()) return; // no consumer asked recently
    await runPortScan();
  }

  async function refreshSystemProcesses(): Promise<void> {
    if (!demanded()) return;
    await runProcessScan();
  }

  const timeouts: ReturnType<typeof setTimeout>[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];

  // Periodic cache refresh
  timeouts.push(setTimeout(() => refreshCache(), 5000)); // initial refresh after 5s
  intervals.push(setInterval(() => refreshCache(), MR_REFRESH_INTERVAL_MS));

  // Port scanning (lightweight — every 30s)
  timeouts.push(setTimeout(() => refreshPortCache(), 2000)); // initial scan after 2s
  intervals.push(setInterval(() => refreshPortCache(), PORT_SCAN_INTERVAL_MS));

  // System process scanning (every 10s)
  timeouts.push(setTimeout(() => refreshSystemProcesses(), 3000));  // initial scan after 3s
  intervals.push(setInterval(() => refreshSystemProcesses(), SYSTEM_PROCESS_SCAN_INTERVAL_MS));

  // Periodic hooks scan — belt-and-suspenders fallback in case a directory
  // watcher ever misses a write (e.g. watcher limit hit, FS edge-case).
  // Runs every 60s; each call is cheap (one git-config read per watched repo).
  //
  // Rides the same interval to re-prime the team-tracking identity map: this
  // is the ONLY re-prime mechanism now that the repo index lives in
  // state.db (RT-50) — there is no file left to fs.watch (see daemon.ts).
  intervals.push(setInterval(async () => {
    const repos = deps.repoIndex();
    await primeTeamTrackingIdentityMap(repos).catch((err) => {
      log.warn({ err }, "repo-tracking: failed to re-prime team-intent identity map");
    });
    for (const [repoName, repoPath] of Object.entries(repos)) {
      if (existsSync(repoPath)) await deps.checkAndRepairHooksPath(repoName, repoPath);
    }
  }, HOOKS_SCAN_INTERVAL_MS));

  return {
    stop() {
      for (const t of timeouts) clearTimeout(t);
      for (const i of intervals) clearInterval(i);
    },
    tickPorts: refreshPortCache,
    tickProcesses: refreshSystemProcesses,
  };
}
