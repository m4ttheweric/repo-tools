/**
 * Data layer for the rt status dashboard — reads the branch cache and port
 * list from the daemon, falling back to the on-disk cache file.
 */

import type { CacheEntry, StatusData } from "./types.ts";
import type { PortEntry } from "../../lib/port-scanner.ts";

/**
 * Parse a --max-age value into milliseconds. Accepts a bare number of
 * seconds ("45"), or s/m/h suffixes ("30s", "2m", "1h"). Returns null on
 * anything else.
 */
export function parseMaxAge(raw: string): number | null {
  const m = /^(\d+)(s|m|h)?$/.exec(raw.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = m[2] ?? "s";
  const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
  return n * multiplier;
}

export async function fetchStatusData(opts?: { maxAgeMs?: number }): Promise<StatusData> {
  const { daemonQuery } = await import("../../lib/daemon-client.ts");

  const wantsFreshness = typeof opts?.maxAgeMs === "number";
  const [cacheResult, portResult] = await Promise.all([
    daemonQuery(
      "cache:read",
      wantsFreshness ? { maxAgeMs: opts!.maxAgeMs } : undefined,
      wantsFreshness ? 120_000 : undefined,
    ),
    daemonQuery("ports"),
  ]);

  // Note: no cache:refresh here — the dashboard has its own live WebSocket connection

  let branches: Record<string, CacheEntry> = {};
  let ports: PortEntry[] = [];
  let source: "daemon" | "cache-file" = "daemon";

  if (cacheResult?.ok && cacheResult.data) {
    branches = cacheResult.data;
  } else {
    source = "cache-file";
    try {
      const { readFileSync } = await import("fs");
      const { homedir } = await import("os");
      const { join } = await import("path");
      const raw = JSON.parse(
        readFileSync(join(homedir(), ".rt", "branch-cache.json"), "utf8"),
      );
      branches = raw.entries || {};
    } catch {
      /* no cache */
    }
  }

  if (portResult?.ok && portResult.data?.ports) {
    ports = portResult.data.ports;
  }

  return { branches, ports, source };
}
