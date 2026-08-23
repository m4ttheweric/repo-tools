/**
 * Direct catalog scanner: parses `sdm access catalog` output into
 * SdmResource[], no connector executable involved. getSdmSnapshot already
 * parses `sdm status` into a Map<name, state>, so this scanner takes status
 * names (not raw status text) and folds in any standing-access resource the
 * catalog itself did not list.
 */

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { rtDir } from "../rt-paths.ts";
import {
  getKvValue,
  getStateDb,
  hasKvValue,
  importLegacyJsonFile,
  renameLegacyOutOfTheWay,
  setKvValue,
} from "../state/index.ts";
import { fetchAccessCatalog, getSdmSnapshot } from "./core.ts";

export interface SdmResource {
  name: string;
  type: string;
  tags: string[];
  /** True when you can connect without an access request: the catalog row has
   * no "available" (requestable) state, or the resource is already in status. */
  standingAccess: boolean;
}

export function parseCatalogResources(catalogOutput: string, statusNames: string[]): SdmResource[] {
  const byName = new Map<string, SdmResource>();
  for (const line of catalogOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s{2,}/);
    if (cols.length < 4 || !/^rs-[0-9a-f]+$/i.test(cols[0]!)) continue;
    const name = cols[1]!.trim();
    const type = cols[3]!.trim().toLowerCase();
    // postgres-family only (postgres, aurora-postgres); connect+verify is
    // postgres-oriented, and this drops AWS/website/cluster catalog rows.
    if (!type.includes("postgres")) continue;
    const last = cols[cols.length - 1]!.trim();
    const tags = /=/.test(last) ? last.split(",").map(t => t.trim()).filter(Boolean) : [];
    // "available" in any column means the resource must be requested; its
    // absence means you already have standing access (matches core's
    // resourceNeedsAccessRequest).
    const standingAccess = !cols.some(c => c.trim().toLowerCase() === "available");
    byName.set(name, { name, type, tags, standingAccess });
  }
  // Standing-access / connected datasources (already parsed by getSdmSnapshot)
  // that the catalog did not list: being in status means you can reach them.
  for (const name of statusNames) {
    if (name && !byName.has(name)) byName.set(name, { name, type: "postgres", tags: [], standingAccess: true });
  }
  return [...byName.values()];
}

export const CATALOG_CACHE_MS = 10 * 60_000;

const SCAN_CACHE_NS = "sdm-scan-cache";
const SCAN_CACHE_KEY = "state";

/** Retired storage location — kept only so a leftover pre-migration file can be imported once, then renamed out of the way. */
export function scanCachePath(): string {
  return join(rtDir(), "sdm", "scan-cache.json");
}

interface PersistedScanCache {
  builtAt: number;
  resources: SdmResource[];
}

function freshResources(parsed: Partial<PersistedScanCache> | null | undefined): SdmResource[] | null {
  return typeof parsed?.builtAt === "number" && Array.isArray(parsed.resources) && Date.now() - parsed.builtAt < CATALOG_CACHE_MS
    ? (parsed.resources as SdmResource[])
    : null;
}

/**
 * Guarded read of the scan cache: a missing row, malformed row, or a shape
 * that doesn't look like a PersistedScanCache all fall through to null
 * (caller re-scans), same convention as the catalog-cache helper this
 * replaces.
 */
export function readScanCache(db: Database = getStateDb()): SdmResource[] | null {
  if (hasKvValue(SCAN_CACHE_NS, SCAN_CACHE_KEY, db)) {
    return freshResources(getKvValue<Partial<PersistedScanCache> | null>(SCAN_CACHE_NS, SCAN_CACHE_KEY, null, db));
  }

  const result = importLegacyJsonFile<PersistedScanCache | null>(scanCachePath(), (json) => {
    const parsed = json as Partial<PersistedScanCache> | null;
    if (typeof parsed?.builtAt !== "number" || !Array.isArray(parsed.resources)) return null;
    const payload: PersistedScanCache = { builtAt: parsed.builtAt, resources: parsed.resources as SdmResource[] };
    setKvValue(SCAN_CACHE_NS, SCAN_CACHE_KEY, payload, db);
    return payload;
  });
  return result.imported ? freshResources(result.value) : null;
}

/**
 * Never overwrite a good cache with an empty result: a transient sdm outage
 * would otherwise blank it until the outage clears.
 */
export function writeScanCache(resources: SdmResource[], db: Database = getStateDb()): void {
  if (resources.length === 0) return;
  const payload: PersistedScanCache = { builtAt: Date.now(), resources };
  setKvValue(SCAN_CACHE_NS, SCAN_CACHE_KEY, payload, db);
  renameLegacyOutOfTheWay(scanCachePath());
}

export async function scanSdmResources(
  opts: { refresh?: boolean; db?: Database } = {},
): Promise<{ resources: SdmResource[]; fromCache: boolean; error?: string }> {
  const db = opts.db ?? getStateDb();
  if (!opts.refresh) {
    const cached = readScanCache(db);
    if (cached) return { resources: cached, fromCache: true };
  }
  const [catalog, snapshot] = await Promise.all([fetchAccessCatalog(opts.refresh), getSdmSnapshot(opts.refresh)]);
  // Only fold in DATASOURCE-section status entries: clusters, websites, and
  // servers are not connectable postgres DBs and must not leak into the picker.
  const statusNames = snapshot.health.status === "ok"
    ? [...snapshot.resources.entries()].filter(([, s]) => s.kind === "datasource").map(([name]) => name)
    : [];
  if (!catalog.ok && snapshot.health.status !== "ok") {
    return { resources: readScanCache(db) ?? [], fromCache: false, error: catalog.output.trim() || "sdm unavailable" };
  }
  const resources = parseCatalogResources(catalog.ok ? catalog.output : "", statusNames);
  if (resources.length > 0) writeScanCache(resources, db); // never clobber a good cache with empty
  return { resources, fromCache: false };
}
