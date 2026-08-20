/**
 * Data layer for the rt status dashboard — reads the branch cache and port
 * list from the daemon, falling back to the on-disk branch cache.
 *
 * RT-48: that fallback used to parse ~/.mattstack/rt/branch-cache.json; it
 * now reads the same rows out of state.db's branch_cache table. "rt status
 * works daemonless" is the property being preserved (spec "No-daemon
 * fallback").
 */

import type { CacheEntry, StatusData } from "./types.ts";
import type { PortEntry } from "../../lib/port-scanner.ts";

interface BranchCacheRow {
  branch: string;
  repo: string | null;
  ticket: string | null;
  linear_id: string;
  mr: string | null;
  fetched_at: number;
}

/**
 * Reads branch-cache rows straight from state.db, for when the daemon is not
 * answering. A MISSING db yields an empty result and creates nothing — the
 * same shape as yesterday's missing cache file, and the reason this checks
 * existsSync instead of just calling openStateDb (which would create and
 * migrate a db as a side effect of a read-only dashboard).
 *
 * Deliberately a plain read rather than `getBranchCacheStore(...)`: that
 * getter would rebind the process-wide store singleton to this throwaway
 * connection. Own the handle, copy what the dashboard needs, close it — so
 * rt's one non-singleton connection leaves nothing behind (neither an open db
 * nor a singleton pointing at a closed one) should `fetchStatusData` ever be
 * called from a long-lived, state-touching process.
 */
async function readBranchesFromStateDb(): Promise<Record<string, CacheEntry>> {
  try {
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    const { rtDir } = await import("../../lib/rt-paths.ts");
    const dbPath = join(rtDir(), "state.db");
    if (!existsSync(dbPath)) return {};

    // Barrel import (never lib/state/db.ts directly) so every store's
    // legacy-JSON importer is registered before this opens the db.
    const { openStateDb } = await import("../../lib/state/index.ts");
    const db = openStateDb(dbPath, "cli");
    try {
      const rows = db
        .query("SELECT branch, repo, ticket, linear_id, mr, fetched_at FROM branch_cache;")
        .all() as BranchCacheRow[];
      const branches: Record<string, CacheEntry> = {};
      for (const row of rows) {
        // The dashboard's CacheEntry is a structural subset of the store's,
        // with looser optionality on the ticket fields (`stateName?: string`
        // vs `string | null`). Same data that used to arrive here as parsed
        // JSON out of branch-cache.json.
        branches[row.branch] = {
          ticket: row.ticket !== null ? (JSON.parse(row.ticket) as CacheEntry["ticket"]) : null,
          linearId: row.linear_id,
          mr: row.mr !== null ? (JSON.parse(row.mr) as CacheEntry["mr"]) : null,
          fetchedAt: row.fetched_at,
          repoName: row.repo ?? undefined,
        };
      }
      return branches;
    } finally {
      db.close();
    }
  } catch {
    return {}; // unreadable cache is a cold dashboard, not a crash
  }
}

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
    branches = await readBranchesFromStateDb();
  }

  if (portResult?.ok && portResult.data?.ports) {
    ports = portResult.data.ports;
  }

  return { branches, ports, source };
}
