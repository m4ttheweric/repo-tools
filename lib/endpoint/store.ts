import { join } from "path";
import { readJson, writeJson } from "../json-store.ts";
import { repoDataDir } from "../rt-paths.ts";

export interface EndpointClaim {
  worktree: string;
  role: string;
  port: number;
  pid?: number;
  ts: string; // ISO
}

interface ClaimsFile {
  claims: EndpointClaim[];
}

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
  const path = endpointsPath(repoName);
  const data = readJson<Partial<ClaimsFile>>(path, { claims: [] });
  return sanitizeClaims(data?.claims);
}

/**
 * Per-repo write counter, bumped by every `saveClaims`.
 *
 * The claims store has exactly one writer process (the daemon), but not one
 * writer *task*: allocation, release, and reconcile all interleave on the same
 * event loop. Anything that loads a whole-file snapshot, awaits, and then
 * saves that snapshot back would silently overwrite whatever landed in
 * between. An in-memory counter is enough to detect that (no cross-process
 * concern) and lives here because `saveClaims` is the seam every write already
 * funnels through. Callers compare `claimsEpoch(repo)` captured right after
 * their load against its value in the same synchronous block as their save.
 */
const epochs = new Map<string, number>();

/** How many times this repo's claims file has been saved in this process. */
export function claimsEpoch(repoName: string): number {
  return epochs.get(repoName) ?? 0;
}

export function saveClaims(repoName: string, claims: EndpointClaim[]): void {
  const path = endpointsPath(repoName);
  writeJson(path, { claims });
  epochs.set(repoName, claimsEpoch(repoName) + 1);
}
