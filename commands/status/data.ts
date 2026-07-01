/**
 * Data layer for the rt status dashboard — reads the branch cache and port
 * list from the daemon, falling back to the on-disk cache file.
 */

import type { CacheEntry, StatusData } from "./types.ts";
import type { PortEntry } from "../../lib/port-scanner.ts";

export async function fetchStatusData(): Promise<StatusData> {
  const { daemonQuery } = await import("../../lib/daemon-client.ts");

  const [cacheResult, portResult] = await Promise.all([
    daemonQuery("cache:read"),
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
