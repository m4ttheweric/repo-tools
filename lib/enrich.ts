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

export function parseRemoteUrl(url: string): { host: string; projectPath: string } | null {
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
  // Delegates to glance-sdk ≥ 0.7.6, which uses mergeabilityChecks as a stable
  // source for `conflicts` (fixes GitLab's async boolean flapping).
  return getMRDashboardProps(pr, "idle");
}

// ─── Disk cache (~/.rt/branch-cache.json) ────────────────────────────────────

const CACHE_PATH = join(homedir(), ".rt", "branch-cache.json");

interface CacheEntry {
  ticket: LinearTicket | null;
  linearId: string;
  mr: MRDashboardProps | null;
  fetchedAt: number;
  repoName?: string;
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
 * A split label: `leading` is the dir + branch/title text (grows, clips on
 * overflow), `trailing` is the right-edge metadata (icons, state tags) that
 * the runner pins to the right of the row so it never gets truncated off.
 */
export interface BranchLabelParts {
  leading: string;
  trailing: string;
}

/**
 * Build the split-label form used by the runner's row layout.
 *
 * Runner rows render as `<leading> <spacer flex=1> <trailing>`, so the trailing
 * bit stays anchored to the right edge and the leading bit is what clips when
 * the title is longer than the row width. Putting icons/state tags into
 * `trailing` keeps them visible regardless of title length.
 *
 * Format (ticket branch):   leading = "dirname · Title [In Progress]"
 *                           trailing = "✓ ◉"
 * Format (normal branch):   leading = "dirname · branch"
 *                           trailing = "✓ ◉ DEV-123"   (or "[Local Only]")
 */
export function formatBranchLabelParts(eb: EnrichedBranch): BranchLabelParts {
  const sep = `${dim} · ${reset}`;

  // MR pipeline + state icons
  const iconParts: string[] = [];
  if (eb.mr?.pipeline) {
    const icon = PIPELINE_ICONS[eb.mr.pipeline.status] || "";
    if (icon) iconParts.push(icon);
  }
  if (eb.mr) {
    const stateIcon = MR_STATE_ICONS[eb.mr.state] || "";
    if (stateIcon) iconParts.push(stateIcon);
  }

  const isDefault = DEFAULT_BRANCHES.has(eb.branch);
  const isTicketBranch = !!(eb.linearId && eb.ticket);

  if (isTicketBranch) {
    let status = "";
    if (eb.ticket!.stateName) {
      const color = eb.ticket!.stateColor ? hexToAnsi(eb.ticket!.stateColor) : dim;
      status = ` ${color}[${eb.ticket!.stateName}]${reset}`;
    }
    return {
      leading:  `${eb.dirName}${sep}${eb.ticket!.title}${status}`,
      trailing: iconParts.join(" "),
    };
  }

  // Normal branch: name is meaningful; keep it in `leading`.
  const leading = eb.branch
    ? `${eb.dirName}${sep}${dim}${eb.branch}${reset}`
    : eb.dirName;

  const infoParts: string[] = [...iconParts];
  if (eb.linearId) infoParts.push(eb.linearId);
  const trailing = infoParts.length > 0
    ? infoParts.join(" ")
    : (isDefault ? `${dim}[main branch]${reset}` : `${dim}[Local Only]${reset}`);

  return { leading, trailing };
}

/**
 * Flat-string label for picker (fzf) inputs where the selection layer can't
 * consume a split shape. Just joins the parts with the standard separator.
 *
 * Format (ticket branch):   `dirname · Ticket Title [In Progress] · ✓ ◉`
 * Format (normal branch):   `dirname · branch · ✓ ◉`
 */
export function formatBranchLabel(eb: EnrichedBranch): string {
  const sep = `${dim} · ${reset}`;
  const { leading, trailing } = formatBranchLabelParts(eb);
  return trailing ? `${leading}${sep}${trailing}` : leading;
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
  options?: { silent?: boolean; forceRefresh?: boolean },
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

  const allCached = !options?.forceRefresh && willFetch && branches.every((b) => b.branch in diskCache.entries);

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

// ─── Daemon-optimized bulk refresh ───────────────────────────────────────────

/**
 * Optimized refresh for the daemon: fetches MRs for all branches in a single
 * GraphQL query using the sourceBranches filter, then batch-fetches Linear tickets.
 *
 * @param branches - local branches to update in the cache
 * @param remoteUrl - git remote origin URL (for GitLab host/project resolution)
 */
export async function refreshAllMRs(
  branches: Array<{ path: string; branch: string }>,
  remoteUrl?: string,
  onError?: (msg: string) => void,
  repoName?: string,
): Promise<void> {
  const secrets = loadSecrets();
  const diskCache = readDiskCache();
  const now = Date.now();

  // ── Step 1: Fetch MRs for all branches in 1 GraphQL call ──────────────
  let mrsByBranch = new Map<string, PullRequest | null>();
  let mrFetchSucceeded = false;

  if (secrets.gitlabToken && remoteUrl) {
    const remote = parseRemoteUrl(remoteUrl);
    if (remote) {
      try {
        const provider = new GitLabProvider(remote.host, secrets.gitlabToken);
        const branchNames = branches.map(b => b.branch).filter(b => b !== "");
        if (branchNames.length > 0) {
          // Fetch all states in one query. The cache keeps whatever state
          // the SDK returns (opened/merged/closed); rt status hides closed
          // and recently-merged-only, and the notifier uses the state to
          // fire distinct merged vs closed transitions.
          mrsByBranch = await provider.fetchPullRequestsByBranches(remote.projectPath, branchNames, 'all');
          mrFetchSucceeded = true;
        }
      } catch (err) {
        onError?.(`GitLab MR fetch failed for ${remote.projectPath}: ${err}`);
        // keep stale MR data to avoid false transitions in notifications
      }
    }
  }

  // ── Step 2: Collect Linear IDs from branches + MR titles ──────────────
  const branchLinearIds: Array<{ branch: string; linearId: string | null }> = branches.map(b => {
    let linearId = extractLinearId(b.branch);

    // Fall back to MR title for Linear ID
    if (!linearId) {
      const pr = mrsByBranch.get(b.branch);
      if (pr) {
        const titleMatch = /\b([A-Za-z]+-\d+)\b/.exec(pr.title);
        if (titleMatch) linearId = titleMatch[1]!.toUpperCase();
      }
    }

    return { branch: b.branch, linearId };
  });

  // ── Step 3: Batch-fetch all Linear tickets in ONE API call ────────────
  const { fetchTicketsBatch } = await import("./linear.ts");
  const uniqueIds = [...new Set(
    branchLinearIds
      .map(b => b.linearId)
      .filter((id): id is string => !!id),
  )];

  let ticketMap = new Map<string, LinearTicket>();
  if (uniqueIds.length > 0 && secrets.linearApiKey) {
    try {
      ticketMap = await fetchTicketsBatch(secrets.linearApiKey, uniqueIds);
    } catch (err) {
      onError?.(`Linear ticket fetch failed for [${uniqueIds.join(", ")}]: ${err}`);
    }
  }

  // ── Step 4: Assemble and write cache ──────────────────────────────────
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i]!;
    const { linearId } = branchLinearIds[i]!;
    const ticket = linearId ? (ticketMap.get(linearId.toUpperCase()) ?? null) : null;

    if (mrFetchSucceeded) {
      // Fresh MR data — write it (null means no MR exists for this branch)
      const pr = mrsByBranch.get(b.branch) ?? null;
      const mr = pr ? toMRInfo(pr) : null;

      // If we resolved nothing new (no MR found, no linearId from branch name or MR title),
      // preserve the existing entry to avoid overwriting good enrichment data that was
      // previously resolved via a full enrich (e.g., from an older/renamed MR title).
      if (!mr && !linearId) {
        const existing = diskCache.entries[b.branch];
        if (existing?.linearId || existing?.ticket) {
          // Keep existing enrichment — we have nothing better to replace it with
          diskCache.entries[b.branch] = { ...existing, fetchedAt: now, repoName };
          continue;
        }
      }

      diskCache.entries[b.branch] = {
        ticket,
        linearId: linearId || "",
        mr,
        fetchedAt: now,
        repoName,
      };
    } else {
      // GitLab API failed entirely — preserve existing MR data to avoid false transitions.
      // If we also couldn't resolve a linearId (non-standard branch name, no MR title to fall
      // back on), preserve existing ticket/linearId too — we have nothing better to substitute.
      const existing = diskCache.entries[b.branch];
      diskCache.entries[b.branch] = {
        ticket:    linearId ? ticket : (existing?.ticket ?? null),
        linearId:  linearId || existing?.linearId || "",
        mr:        existing?.mr ?? null,
        fetchedAt: existing?.fetchedAt ?? now,
        repoName:  repoName ?? existing?.repoName,
      };
    }
  }

  writeDiskCache(diskCache);
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
