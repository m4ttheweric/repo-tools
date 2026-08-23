import { join } from "path";
import { repoDataDir } from "../rt-paths.ts";
import {
  importLegacyJsonFile,
  listEndpointClaims,
  renameLegacyOutOfTheWay,
  replaceEndpointClaims,
  type EndpointClaim,
} from "../state/index.ts";

export type { EndpointClaim } from "../state/index.ts";

/** Retired storage location — kept only so a leftover pre-migration file can be imported once, then renamed out of the way. */
export function endpointsPath(repoName: string): string {
  return join(repoDataDir(repoName), "endpoints.json");
}

/** Keeps only well-shaped claim entries; drops anything malformed rather than throwing. */
function sanitizeClaims(raw: unknown): EndpointClaim[] {
  if (!Array.isArray(raw)) return [];
  const out: EndpointClaim[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.worktree !== "string" || typeof c.role !== "string") continue;
    if (typeof c.port !== "number" || !Number.isInteger(c.port)) continue;
    if (typeof c.ts !== "string") continue;
    const claim: EndpointClaim = { worktree: c.worktree, role: c.role, port: c.port, ts: c.ts };
    if (typeof c.pid === "number" && Number.isInteger(c.pid)) claim.pid = c.pid;
    out.push(claim);
  }
  return out;
}

export function loadClaims(repoName: string): EndpointClaim[] {
  const existing = listEndpointClaims(repoName);
  if (existing.length > 0) return existing;

  const result = importLegacyJsonFile<EndpointClaim[]>(endpointsPath(repoName), (json) => {
    const parsed = json as { claims?: unknown } | null;
    const claims = sanitizeClaims(parsed?.claims);
    replaceEndpointClaims(repoName, claims);
    return claims;
  });
  return result.imported ? result.value! : existing;
}

export function saveClaims(repoName: string, claims: EndpointClaim[]): void {
  replaceEndpointClaims(repoName, claims);
  renameLegacyOutOfTheWay(endpointsPath(repoName));
}
