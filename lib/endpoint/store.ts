import { join } from "path";
import { repoDataDir } from "../rt-paths.ts";
import {
  hasEndpointClaims,
  importLegacyJsonFile,
  listEndpointClaims,
  replaceEndpointClaims,
  type EndpointClaim,
} from "../state/index.ts";
import { rekeyTableColumn, type RekeyReport } from "../state/identity-migrate.ts";

export type { EndpointClaim } from "../state/index.ts";

/**
 * One-shot: re-key legacy NAME-keyed `endpoint_claims` rows onto serialized
 * identities. Exported for the daemon-boot migration runner; this module
 * does not wire the boot call.
 */
export function rekeyEndpointClaimsTable(): Promise<RekeyReport> {
  return rekeyTableColumn("endpoint_claims", "repo");
}

/** Retired storage location — kept only so a leftover pre-migration file can be imported once, then renamed out of the way. */
export function endpointsPath(repoName: string): string {
  return join(repoDataDir(repoName), "endpoints.json");
}

/**
 * Keeps only well-shaped claim entries; drops anything malformed rather than
 * throwing. Deduped on (worktree, role) — the destination table's PRIMARY
 * KEY is `(repo, worktree, role)`, and a legacy file with a duplicate pair
 * (e.g. hand-edited, or written by an older rt before some invariant held)
 * would otherwise throw a UNIQUE-constraint error out of the plain INSERT in
 * `replaceEndpointClaims`, permanently poisoning every future `loadClaims`
 * for this repo since the file stays in place after any throw. Last entry
 * for a pair wins, matching an INSERT ... ON CONFLICT DO UPDATE.
 */
function sanitizeClaims(raw: unknown): EndpointClaim[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, EndpointClaim>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.worktree !== "string" || typeof c.role !== "string") continue;
    if (typeof c.port !== "number" || !Number.isInteger(c.port)) continue;
    if (typeof c.ts !== "string") continue;
    const claim: EndpointClaim = { worktree: c.worktree, role: c.role, port: c.port, ts: c.ts };
    if (typeof c.pid === "number" && Number.isInteger(c.pid)) claim.pid = c.pid;
    byKey.set(JSON.stringify([c.worktree, c.role]), claim);
  }
  return [...byKey.values()];
}

export function loadClaims(repoName: string): EndpointClaim[] {
  if (hasEndpointClaims(repoName)) return listEndpointClaims(repoName);

  // An imported empty array has nothing to lose either way (the transaction
  // is a no-op DELETE+no-INSERT, indistinguishable from a swallowed BUSY on
  // an already-empty repo) — safe to rename regardless. A non-empty import
  // must actually be found in the table before the source file goes away.
  let importedCount = 0;
  const result = importLegacyJsonFile<EndpointClaim[]>(endpointsPath(repoName), (json) => {
    const parsed = json as { claims?: unknown } | null;
    const claims = sanitizeClaims(parsed?.claims);
    importedCount = claims.length;
    replaceEndpointClaims(repoName, claims);
    return claims;
  }, { verifyPersisted: () => importedCount === 0 || hasEndpointClaims(repoName) });
  return result.imported ? result.value! : [];
}

export function saveClaims(repoName: string, claims: EndpointClaim[]): void {
  // Folds in (and safely imports/renames) any legacy endpoints.json first —
  // see worktree/registry.ts's saveRegistry for the same reasoning: a save
  // reached without a prior load must not strand an unread legacy file.
  loadClaims(repoName);
  replaceEndpointClaims(repoName, claims);
}
