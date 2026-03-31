/**
 * Centralized branch enrichment for rt.
 *
 * Single source of truth for enriching branches with:
 *  - GitLab MR data (via @workforge/glance-sdk)
 *  - Linear ticket info (via Linear GraphQL API)
 *  - Disk cache with stale-while-revalidate
 *
 * Every picker/display that shows branches imports from this module.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  GitLabProvider,
  type PullRequest,
  getMRDashboardProps,
  type MRDashboardProps,
} from "@workforge/glance-sdk";
import { green, blue, red, reset, dim, yellow, cyan } from "./tui.ts";
import {
  loadSecrets,
  extractLinearId,
  type LinearTicket,
} from "./linear.ts";

// ─── Remote URL parser ───────────────────────────────────────────────────────

function parseRemoteUrl(url: string): { host: string; projectPath: string } | null {
  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  if (sshMatch) return { host: `https://${sshMatch[1]}`, projectPath: sshMatch[2]! };

  const httpsMatch = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (httpsMatch) return { host: `https://${httpsMatch[1]}`, projectPath: httpsMatch[2]! };

  return null;
}

// ─── EnrichedBranch type ─────────────────────────────────────────────────────

/** Re-export for downstream consumers */
export type { MRDashboardProps };

export interface EnrichedBranch {
  path: string;
  dirName: string;
  branch: string;
  linearId: string | null;
  ticket: LinearTicket | null;
  mr: MRDashboardProps | null;
}

// ─── PullRequest → MRDashboardProps ──────────────────────────────────────────

function toMRInfo(pr: PullRequest): MRDashboardProps {
  return getMRDashboardProps(pr, "idle");
}

// ─── Disk cache (~/.rt/branch-cache.json) ────────────────────────────────────

const CACHE_PATH = join(homedir(), ".rt", "branch-cache.json");

interface CacheEntry {
  ticket: LinearTicket | null;
  linearId: string;
  mr: MRDashboardProps | null;
  fetchedAt: number;
}

interface DiskCache {
  entries: Record<string, CacheEntry>;
}

function readDiskCache(): DiskCache {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return { entries: {} };
  }
}

function writeDiskCache(cache: DiskCache): void {
  try {
    const dir = join(homedir(), ".rt");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch { /* best-effort */ }
}

// ─── Label formatting ────────────────────────────────────────────────────────

const MR_STATE_ICONS: Record<string, string> = {
  opened: `${green}◉${reset}`,
  merged: `${blue}●${reset}`,
  closed: `${red}○${reset}`,
};

const PIPELINE_ICONS: Record<string, string> = {
  success: `${green}✓${reset}`,
  success_with_warnings: `${yellow}✓${reset}`,
  failed: `${red}✗${reset}`,
  running: `${cyan}⟳${reset}`,
  pending: `${dim}⟳${reset}`,
  created: `${dim}○${reset}`,
  canceled: `${dim}✗${reset}`,
};

function hexToAnsi(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

const DEFAULT_BRANCHES = new Set(["master", "main", "develop", "development", "staging", "production"]);

/**
 * Build a full label string for a branch picker option.
 * Everything is in the label so it's always visible.
 *
 * Format: `dirname · branch · ✓ ◉ CV-1287: Title [In Progress]`
 */
export function formatBranchLabel(eb: EnrichedBranch): string {
  const sep = `${dim} · ${reset}`;
  const parts: string[] = [eb.dirName];

  if (eb.branch) {
    const branchDisplay = eb.branch.length > 40 ? eb.branch.slice(0, 39) + "…" : eb.branch;
    parts.push(`${dim}${branchDisplay}${reset}`);
  }

  // MR + pipeline info
  const infoParts: string[] = [];

  if (eb.mr?.pipeline) {
    const icon = PIPELINE_ICONS[eb.mr.pipeline.status] || "";
    if (icon) infoParts.push(icon);
  }

  if (eb.mr) {
    const stateIcon = MR_STATE_ICONS[eb.mr.state] || "";
    if (stateIcon) infoParts.push(stateIcon);
  }

  if (eb.ticket) {
    let status = "";
    if (eb.ticket.stateName) {
      const color = eb.ticket.stateColor ? hexToAnsi(eb.ticket.stateColor) : dim;
      status = ` ${color}[${eb.ticket.stateName}]${reset}`;
    }
    const title = eb.ticket.title.length > 40
      ? eb.ticket.title.slice(0, 39) + "…"
      : eb.ticket.title;
    infoParts.push(`${eb.ticket.identifier}: ${title}${status}`);
  } else if (eb.linearId) {
    infoParts.push(eb.linearId);
  }

  const isDefault = DEFAULT_BRANCHES.has(eb.branch);

  if (infoParts.length > 0) {
    parts.push(infoParts.join(" "));
  } else if (isDefault) {
    parts.push(`${dim}[main branch]${reset}`);
  } else {
    parts.push(`${dim}[Local Only]${reset}`);
  }

  return parts.join(sep);
}

// ─── Public enrichment API ───────────────────────────────────────────────────

/**
 * Enrich a list of branches with Linear ticket + GitLab MR data.
 *
 * Cache strategy:
 *  - If cached data exists → serve instantly, always revalidate in background
 *  - If no cached data → fetch with spinner (cold start)
 */
export async function enrichBranches(
  branches: Array<{ path: string; branch: string }>,
  remoteUrl?: string,
  options?: { silent?: boolean },
): Promise<EnrichedBranch[]> {
  // ── Daemon-first path: instant response from in-memory cache ──
  if (!options?.silent) {
    try {
      const { daemonQuery } = await import("./daemon-client.ts");
      const response = await daemonQuery("cache:read", {
        branches: branches.map(b => b.branch),
      });

      if (response?.ok && response.data) {
        const daemonCache = response.data as Record<string, CacheEntry>;
        const allHit = branches.every(b => b.branch in daemonCache);

        if (allHit) {
          return branches.map(b => {
            const entry = daemonCache[b.branch]!;
            return {
              path: b.path,
              dirName: b.path.split("/").pop() || b.path,
              branch: b.branch,
              linearId: entry.linearId || null,
              ticket: entry.ticket,
              mr: entry.mr ?? null,
            };
          });
        }
      }
    } catch {
      // Daemon not available — fall through to disk cache / direct fetch
    }
  }

  // ── Existing logic (disk cache + fetch) ──
  const secrets = loadSecrets();
  const willFetch = !!(secrets.linearApiKey || secrets.gitlabToken);
  const diskCache = readDiskCache();

  const allCached = willFetch && branches.every((b) => b.branch in diskCache.entries);

  if (allCached) {
    const cachedResults = branches.map((b) => {
      const entry = diskCache.entries[b.branch]!;
      return {
        path: b.path,
        dirName: b.path.split("/").pop() || b.path,
        branch: b.branch,
        linearId: entry.linearId || null,
        ticket: entry.ticket,
        mr: entry.mr ?? null,
      };
    });

    // Revalidate in a detached subprocess so the main process can exit immediately
    spawnCacheRefresh(branches, remoteUrl);

    return cachedResults;
  }

  // Cold start
  return fetchAndCache(branches, remoteUrl, diskCache, options?.silent ?? false);
}

async function fetchAndCache(
  branches: Array<{ path: string; branch: string }>,
  remoteUrl: string | undefined,
  diskCache: DiskCache,
  silent: boolean,
): Promise<EnrichedBranch[]> {
  const secrets = loadSecrets();
  const willFetch = !!(secrets.linearApiKey || secrets.gitlabToken);

  let showSpinner = false;
  if (!silent && willFetch && process.stderr.isTTY) {
    showSpinner = true;
    process.stderr.write(`  ${cyan}⟳${reset} Fetching branch info…\r`);
  }

  // ── Step 1: Fetch GitLab MR data via glance-sdk (already batched) ──
  let mrMap = new Map<string, PullRequest | null>();

  if (secrets.gitlabToken && remoteUrl) {
    const remote = parseRemoteUrl(remoteUrl);
    if (remote) {
      try {
        const provider = new GitLabProvider(remote.host, secrets.gitlabToken);
        const branchNames = branches.map(b => b.branch).filter(b => b !== "");
        if (branchNames.length > 0) {
          mrMap = await provider.fetchPullRequestsByBranches(remote.projectPath, branchNames);
        }
      } catch { /* GitLab fetch failed — continue without MR data */ }
    }
  }

  // ── Step 2: Collect Linear IDs and MR-derived IDs ──
  const branchLinearIds: Array<{ branch: string; linearId: string | null }> = branches.map(b => {
    let linearId = extractLinearId(b.branch);

    // Fall back to MR title for Linear ID
    if (!linearId) {
      const pr = mrMap.get(b.branch);
      if (pr) {
        const titleMatch = /\b([A-Za-z]+-\d+)\b/.exec(pr.title);
        if (titleMatch) linearId = titleMatch[1]!.toUpperCase();
      }
    }

    return { branch: b.branch, linearId };
  });

  // ── Step 3: Batch-fetch all Linear tickets in ONE API call ──
  const { fetchTicketsBatch } = await import("./linear.ts");
  const uniqueIds = [...new Set(
    branchLinearIds
      .map(b => b.linearId)
      .filter((id): id is string => !!id),
  )];

  let ticketMap = new Map<string, LinearTicket>();
  if (uniqueIds.length > 0 && secrets.linearApiKey) {
    ticketMap = await fetchTicketsBatch(secrets.linearApiKey, uniqueIds);
  }

  // ── Step 4: Assemble results ──
  const results: EnrichedBranch[] = branches.map((b, idx) => {
    const dirName = b.path.split("/").pop() || b.path;
    const { linearId } = branchLinearIds[idx]!;

    const pr = mrMap.get(b.branch) ?? null;
    const mr = pr ? toMRInfo(pr) : null;
    const ticket = linearId ? (ticketMap.get(linearId.toUpperCase()) ?? null) : null;

    // Update disk cache
    diskCache.entries[b.branch] = {
      ticket,
      linearId: linearId || "",
      mr,
      fetchedAt: Date.now(),
    };

    return { path: b.path, dirName, branch: b.branch, linearId, ticket, mr };
  });

  writeDiskCache(diskCache);

  if (showSpinner) {
    const ticketCount = results.filter(r => r.ticket).length;
    const mrCount = results.filter(r => r.mr).length;
    const parts: string[] = [];
    if (mrCount > 0) parts.push(`${mrCount} MR${mrCount !== 1 ? "s" : ""}`);
    if (ticketCount > 0) parts.push(`${ticketCount} ticket${ticketCount !== 1 ? "s" : ""}`);
    process.stderr.write(`  ${green}✓${reset} ${parts.length > 0 ? parts.join(", ") + " loaded" : "Done"}          \n`);
  }

  return results;
}

// ─── Detached cache refresh ──────────────────────────────────────────────────

function spawnCacheRefresh(
  branches: Array<{ path: string; branch: string }>,
  remoteUrl: string | undefined,
): void {
  try {
    const scriptPath = new URL(import.meta.url).pathname;
    const payload = JSON.stringify({
      branches: branches.map(b => ({ path: b.path, branch: b.branch })),
      remoteUrl,
    });
    const child = Bun.spawn(["bun", "run", scriptPath, payload], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
  } catch { /* best-effort */ }
}

// ─── Standalone entry (called by detached subprocess) ────────────────────────

if (import.meta.main) {
  const data = JSON.parse(process.argv[2]!) as {
    branches: Array<{ path: string; branch: string }>;
    remoteUrl?: string;
  };
  const cache = readDiskCache();
  await fetchAndCache(data.branches, data.remoteUrl, cache, true);
}
