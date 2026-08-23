import { unlinkSync } from "fs";
import { join } from "path";
import { repoDataDir } from "../rt-paths.ts";
import { listEndpointClaims, replaceEndpointClaims, type EndpointClaim } from "../state/index.ts";

export type { EndpointClaim } from "../state/index.ts";

/** Retired storage location — kept only so a leftover pre-migration file can be cleaned up. */
export function endpointsPath(repoName: string): string {
  return join(repoDataDir(repoName), "endpoints.json");
}

function unlinkLegacyEndpoints(repoName: string): void {
  try {
    unlinkSync(endpointsPath(repoName));
  } catch {
    // already gone, or never existed
  }
}

export function loadClaims(repoName: string): EndpointClaim[] {
  return listEndpointClaims(repoName);
}

export function saveClaims(repoName: string, claims: EndpointClaim[]): void {
  replaceEndpointClaims(repoName, claims);
  unlinkLegacyEndpoints(repoName);
}
