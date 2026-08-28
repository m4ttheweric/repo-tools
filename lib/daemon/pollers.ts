/**
 * Periodic background work — cache refresh, port scanning, system-process
 * scanning, and the hooks-guard fallback rescan.
 *
 * All intervals live here so daemon.ts stays a thin wiring layer.
 */

import { existsSync } from "fs";
import type { Logger } from "pino";
import { scanListeningPorts } from "../port-scanner.ts";
import { checkRunawayProcesses } from "../notifier.ts";
import { primeTeamTrackingIdentityMap } from "../repo-tracking.ts";
import type { SystemProcessScanner } from "./system-process-scanner.ts";
import type { PortCacheRef, RepoIndex } from "./handlers/types.ts";
import { demandedWithin } from "./demand-tracker.ts";

const MR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;        // 5 minutes
const PORT_SCAN_INTERVAL_MS = 30 * 1000;             // 30 seconds
const HOOKS_SCAN_INTERVAL_MS = 60 * 1000;            // 60 seconds (fallback for stale watchers)
const SYSTEM_PROCESS_SCAN_INTERVAL_MS = 10 * 1000;   // 10 seconds
/** Consider a consumer "present" for 5 min after its last scan-backed read. */
const DEMAND_WINDOW_MS = 5 * 60 * 1000;

export interface PollerDeps {
  log: Logger;
  refreshCache: () => Promise<void>;
  /** Mutated in place so handlers read fresh port values without getters. */
  portCacheRef: PortCacheRef;
  broadcast: (type: string, data: any) => void;
  systemProcessScanner: SystemProcessScanner;
  repoIndex: () => RepoIndex;
  checkAndRepairHooksPath: (repoName: string, repoPath: string) => Promise<boolean>;
}

export function startPollers(deps: PollerDeps): void {
  const { log, refreshCache, portCacheRef, broadcast, systemProcessScanner } = deps;

  // In-flight guards: the scans are async now, so a slow scan must not
  // overlap the next tick (the runaway math assumes one sample per 10s).
  let portScanInFlight = false;
  let processScanInFlight = false;

  async function refreshPortCache(): Promise<void> {
    if (portScanInFlight) return;
    if (!demandedWithin(DEMAND_WINDOW_MS)) return; // no consumer asked recently
    portScanInFlight = true;
    try {
      portCacheRef.ports = await scanListeningPorts();
      portCacheRef.updatedAt = Date.now();
      log.debug({ count: portCacheRef.ports.length }, "ports scanned");

      broadcast("ports", { ports: portCacheRef.ports, updatedAt: portCacheRef.updatedAt });
    } catch (err) {
      log.error({ err }, "port scan failed");
    } finally {
      portScanInFlight = false;
    }
  }

  async function refreshSystemProcesses(): Promise<void> {
    if (processScanInFlight) return;
    if (!demandedWithin(DEMAND_WINDOW_MS)) return;
    processScanInFlight = true;
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
    } finally {
      processScanInFlight = false;
    }
  }

  // Periodic cache refresh
  setTimeout(() => refreshCache(), 5000); // initial refresh after 5s
  setInterval(() => refreshCache(), MR_REFRESH_INTERVAL_MS);

  // Port scanning (lightweight — every 30s)
  setTimeout(() => refreshPortCache(), 2000); // initial scan after 2s
  setInterval(() => refreshPortCache(), PORT_SCAN_INTERVAL_MS);

  // System process scanning (every 10s)
  setTimeout(() => refreshSystemProcesses(), 3000);  // initial scan after 3s
  setInterval(() => refreshSystemProcesses(), SYSTEM_PROCESS_SCAN_INTERVAL_MS);

  // Periodic hooks scan — belt-and-suspenders fallback in case a directory
  // watcher ever misses a write (e.g. watcher limit hit, FS edge-case).
  // Runs every 60s; each call is cheap (one git-config read per watched repo).
  //
  // Rides the same interval to re-prime the team-tracking identity map: this
  // is the ONLY re-prime mechanism now that the repo index lives in
  // state.db (RT-50) — there is no file left to fs.watch (see daemon.ts).
  setInterval(async () => {
    const repos = deps.repoIndex();
    await primeTeamTrackingIdentityMap(repos).catch((err) => {
      log.warn({ err }, "repo-tracking: failed to re-prime team-intent identity map");
    });
    for (const [repoName, repoPath] of Object.entries(repos)) {
      if (existsSync(repoPath)) await deps.checkAndRepairHooksPath(repoName, repoPath);
    }
  }, HOOKS_SCAN_INTERVAL_MS);
}
