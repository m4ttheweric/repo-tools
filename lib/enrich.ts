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
import { GitLabProvider, type PullRequest } from "@workforge/glance-sdk";
import { green, blue, red, reset, dim, yellow, cyan } from "./tui.ts";
import {
  loadSecrets,
  extractLinearId,
  fetchTicket,
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

export interface MRInfo {
  iid: number;
  state: "opened" | "merged" | "closed";
  draft: boolean;
  webUrl: string | null;
  title: string;
  pipeline: {
    status: string;
    passing: number;
    failing: number;
    running: number;
    total: number;
  } | null;
  approvalsLeft: number;
  approved: boolean;
  conflicts: boolean;
  shouldBeRebased: boolean;
}

export interface EnrichedBranch {
  path: string;
  dirName: string;
  branch: string;
  linearId: string | null;
  ticket: LinearTicket | null;
  mr: MRInfo | null;
}

// ─── PullRequest → MRInfo ────────────────────────────────────────────────────

function toMRInfo(pr: PullRequest): MRInfo {
  const pipeline = pr.pipeline
    ? {
        status: pr.pipeline.status,
        passing: pr.pipeline.jobs.filter(j => j.status === "success").length,
        failing: pr.pipeline.jobs.filter(j => j.status === "failed" && !j.allowFailure).length,
        running: pr.pipeline.jobs.filter(j => j.status === "running" || j.status === "pending").length,
        total: pr.pipeline.jobs.length,
      }
    : null;

  return {
    iid: pr.iid,
    state: pr.state as MRInfo["state"],
    draft: pr.draft,
    webUrl: pr.webUrl,
    title: pr.title,
    pipeline,
    approvalsLeft: pr.approvalsLeft,
    approved: pr.approved,
    conflicts: pr.conflicts,
    shouldBeRebased: pr.shouldBeRebased,
  };
}

// ─── Disk cache (~/.rt/branch-cache.json) ────────────────────────────────────

const CACHE_PATH = join(homedir(), ".rt", "branch-cache.json");

interface CacheEntry {
  ticket: LinearTicket | null;
  linearId: string;
  mr: MRInfo | null;
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

    // Revalidate in background (silently)
    fetchAndCache(branches, remoteUrl, diskCache, true).catch(() => {});

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

  // ── Step 1: Fetch GitLab MR data via glance-sdk ──
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

  // ── Step 2: Enrich each branch with Linear ticket + MR info ──
  const results = await Promise.all(
    branches.map(async (b) => {
      const dirName = b.path.split("/").pop() || b.path;
      let linearId = extractLinearId(b.branch);

      // Get MR data
      const pr = mrMap.get(b.branch) ?? null;
      const mr = pr ? toMRInfo(pr) : null;

      // Fall back to MR title for Linear ID
      if (!linearId && pr) {
        const titleMatch = /\b([A-Za-z]+-\d+)\b/.exec(pr.title);
        if (titleMatch) linearId = titleMatch[1]!.toUpperCase();
      }

      // Fetch Linear ticket
      let ticket: LinearTicket | null = null;
      if (linearId && secrets.linearApiKey) {
        try {
          ticket = await fetchTicket(secrets.linearApiKey, linearId);
        } catch { /* fetch failed */ }
      }

      // Update cache
      diskCache.entries[b.branch] = {
        ticket,
        linearId: linearId || "",
        mr,
        fetchedAt: Date.now(),
      };

      return { path: b.path, dirName, branch: b.branch, linearId, ticket, mr };
    }),
  );

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
