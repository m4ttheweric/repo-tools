// lib/daemon/health.ts
/**
 * Pure daemon health verdict. computeHealth takes a fully-gathered input
 * struct (the daemon-side adapter does all I/O) and returns the level, the
 * named reasons, and the metrics/eventLoop blocks the surfaces echo.
 */

export const HEALTH_THRESHOLDS = {
  refreshStaleMultiplier: 2,
  rssSoftThresholdBytes: 1024 * 1024 * 1024,
  rssGrowthPct: 50,
  diskSoftFloorBytes: 500 * 1024 * 1024,
  diskHardFloorBytes: 100 * 1024 * 1024,
  restartsPerHourUnhealthy: 5,
  recoveredErrorRate: 10,
} as const;

export interface HealthMetrics {
  rss: number;
  heapUsed: number;
  external: number;
  uptimeMs: number;
  wsClients: number;
  watchers: number;
}

export interface HealthEventLoop {
  maxLagMs: number;
  lastStallAt: number | null;
  lastStallCmd: string | null;
  stalls: number;
}

export interface HealthInputs {
  now: number;
  uptimeMs: number;
  mem: { rss: number; heapUsed: number; external: number };
  /** rss + timestamp from ~1h ago, for growth detection; null if not yet sampled. */
  rssBaseline: { rss: number; at: number } | null;
  wsClients: number;
  watchers: number;
  freshness: Record<string, { state: string }>;
  refresh: { lastSuccessAt: number; failedRepos: number; enrichErrors: number };
  refreshIntervalMs: number;
  eventLoop: HealthEventLoop & { currentlyStalled: boolean };
  supervisionFailuresLastHour: number;
  crashLooping: boolean;
  loggerDegraded: boolean;
  recoveredErrorRateLastWindow: number;
  freeBytes: number | null;
  /** Deferred inputs (spec): wired in a later phase, ignored today. */
  busySkips?: number;
  criticalWriteFailures?: number;
}

export interface HealthSnapshot {
  level: "ok" | "degraded" | "unhealthy";
  reasons: string[];
  metrics: HealthMetrics;
  eventLoop: HealthEventLoop;
}

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export function computeHealth(i: HealthInputs): HealthSnapshot {
  const T = HEALTH_THRESHOLDS;
  const unhealthy: string[] = [];
  const degraded: string[] = [];

  // --- unhealthy ---
  if (i.loggerDegraded) unhealthy.push("logging: disabled (ENOSPC)");
  if (i.eventLoop.currentlyStalled) unhealthy.push("event-loop: currently stalled");
  if (i.crashLooping || i.supervisionFailuresLastHour >= T.restartsPerHourUnhealthy) {
    unhealthy.push(`restarts: ${i.supervisionFailuresLastHour} in the last hour`);
  }
  if (i.freeBytes !== null && i.freeBytes < T.diskHardFloorBytes) {
    unhealthy.push(`disk: ${mb(i.freeBytes)}MB free (critical)`);
  }

  // --- degraded ---
  const degradedRepos = Object.values(i.freshness).filter((f) => f.state === "degraded").length;
  if (degradedRepos > 0) degraded.push(`refresh: ${degradedRepos} watcher${degradedRepos !== 1 ? "s" : ""} degraded`);
  if (i.refresh.failedRepos > 0 || i.refresh.enrichErrors > 0) {
    degraded.push(`refresh: ${i.refresh.failedRepos} repos failing (auth?)`);
  }
  const refreshAge = i.now - i.refresh.lastSuccessAt;
  if (i.refresh.lastSuccessAt > 0 && refreshAge > T.refreshStaleMultiplier * i.refreshIntervalMs) {
    degraded.push(`refresh: last success ${Math.round(refreshAge / 1000)}s ago`);
  }
  if (i.mem.rss > T.rssSoftThresholdBytes) degraded.push(`memory: rss ${mb(i.mem.rss)}MB`);
  if (i.rssBaseline && i.mem.rss > i.rssBaseline.rss * (1 + T.rssGrowthPct / 100)) {
    degraded.push(`memory: rss grew >${T.rssGrowthPct}% in the last hour`);
  }
  if (i.eventLoop.maxLagMs > 500) degraded.push(`event-loop: lag ${i.eventLoop.maxLagMs}ms`);
  if (i.recoveredErrorRateLastWindow > T.recoveredErrorRate) {
    degraded.push(`errors: ${i.recoveredErrorRateLastWindow} recovered in 5min`);
  }
  if (i.freeBytes !== null && i.freeBytes >= T.diskHardFloorBytes && i.freeBytes < T.diskSoftFloorBytes) {
    degraded.push(`disk: ${mb(i.freeBytes)}MB free`);
  }

  const level = unhealthy.length > 0 ? "unhealthy" : degraded.length > 0 ? "degraded" : "ok";
  return {
    level,
    reasons: level === "ok" ? [] : [...unhealthy, ...degraded],
    metrics: {
      rss: i.mem.rss,
      heapUsed: i.mem.heapUsed,
      external: i.mem.external,
      uptimeMs: i.uptimeMs,
      wsClients: i.wsClients,
      watchers: i.watchers,
    },
    eventLoop: {
      maxLagMs: i.eventLoop.maxLagMs,
      lastStallAt: i.eventLoop.lastStallAt,
      lastStallCmd: i.eventLoop.lastStallCmd,
      stalls: i.eventLoop.stalls,
    },
  };
}
