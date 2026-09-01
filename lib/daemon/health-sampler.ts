// lib/daemon/health-sampler.ts
/** Periodic (5-min) metrics logging + the two cached signals health needs that
 *  are too costly to compute per ping: the 1h rss baseline (growth) and free
 *  disk under RT_DIR. Pure helpers are unit-tested; the timer just calls sample. */
import { statfsSync } from "fs";
import type { Logger } from "pino";
import { HEALTH_THRESHOLDS } from "./health.ts";

export function rollRssBaseline(
  prev: { rss: number; at: number } | null,
  now: { rss: number; at: number },
  windowMs: number,
): { rss: number; at: number } {
  if (!prev) return now;
  if (now.at - prev.at >= windowMs) return now;
  return prev;
}

export interface HealthSampler {
  sample(): void;
  freeBytes(): number | null;
  rssBaseline(): { rss: number; at: number } | null;
}

export function createHealthSampler(opts: {
  log: Logger;
  rtDir: string;
  wsClients: () => number;
  watchers: () => number;
  startedAt: number;
}): HealthSampler {
  let baseline: { rss: number; at: number } | null = null;
  let free: number | null = null;

  function statfsFree(dir: string): number | null {
    // Not every platform/runtime implements statfs; leave free=null and disk
    // checks are simply skipped rather than treated as an error.
    try {
      const s = statfsSync(dir);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }

  return {
    freeBytes: () => free,
    rssBaseline: () => baseline,
    sample() {
      const mem = process.memoryUsage();
      const now = Date.now();
      baseline = rollRssBaseline(baseline, { rss: mem.rss, at: now }, HEALTH_THRESHOLDS.rssGrowthWindowMs);
      free = statfsFree(opts.rtDir);
      opts.log.info(
        {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          external: mem.external,
          wsClients: opts.wsClients(),
          watchers: opts.watchers(),
          uptimeMs: now - opts.startedAt,
        },
        "daemon metrics",
      );
    },
  };
}
