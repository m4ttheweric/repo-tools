/**
 * Centralized branch enrichment for rt.
 *
 * Single source of truth for enriching branches with:
 *  - GitLab MR data (via @mattstack/glance)
 *  - Linear ticket info (via Linear GraphQL API)
 *  - state.db branch cache with stale-while-revalidate
 *
 * Every picker/display that shows branches imports from this module.
 *
 * RT-48: this module used to carry its OWN `CacheEntry`/`DiskCache` pair plus
 * `readDiskCache`/`writeDiskCache` over ~/.mattstack/rt/branch-cache.json —
 * a second, separately-declared copy of the daemon's cache, and one half of
 * the cross-process full-file-rewrite race. Both copies are gone: the single
 * owner is `lib/state/branch-cache.ts`, reached (per the barrel rule) through
 * `lib/state/index.ts`. `MRInfo` still lives here and the store imports the
 * type from this module.
 */

import { fileURLToPath } from "url";
import {
  getBranchCacheStore,
  getStateDb,
  type BranchCacheStore,
  type CacheEntry,
} from "./state/index.ts";
import { composeKey } from "./state/branch-cache.ts";
import { identityFromRemote, serializeIdentity } from "./settings/identity.ts";
import {
  GitLabProvider,
  type PullRequest,
  getMRDashboardProps,
  type MRDashboardProps,
} from "@mattstack/glance";
import { green, blue, red, reset, dim, yellow, cyan } from "./tui.ts";
import {
  loadSecrets,
  extractLinearId,
  type LinearTicket,
} from "./linear.ts";
import type { PickSegment } from "./ui/protocol.ts";

/** Best-effort serialized identity for a remote URL; undefined with no remote. */
function identityForRemote(remoteUrl: string | undefined): string | undefined {
  if (!remoteUrl) return undefined;
  const parsed = identityFromRemote(remoteUrl);
  return parsed ? serializeIdentity(parsed) : undefined;
}

// ─── Remote URL parser ───────────────────────────────────────────────────────

export function parseRemoteUrl(url: string): { host: string; projectPath: string } | null {
  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  if (sshMatch) return { host: `https://${sshMatch[1]}`, projectPath: sshMatch[2]! };

  const httpsMatch = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (httpsMatch) return { host: `https://${httpsMatch[1]}`, projectPath: httpsMatch[2]! };

  return null;
}

/**
 * True when a git remote points at a GitLab host (gitlab.com or a self-hosted
 * gitlab.* instance). MR enrichment is GitLab-only — without this gate, GitHub
 * (and other) remotes get a GitLab GraphQL query fired at the wrong host, which
 * fails with a 422 on every refresh and floods the daemon log with warnings.
 * This is the single source of truth for the GitLab check across the CLI and
 * daemon; keep provider selection routed through it.
 */
export function isGitLabRemote(url: string | undefined): boolean {
  return !!url && /gitlab\./i.test(url);
}

/**
 * Scoped provider IDs arrive as "gitlab:42" or "gitlab:user:42"; extract the
 * trailing numeric segment. Single source of truth for the notifier's
 * self-author check and the discussions store's author/participant matching.
 */
export function numericUserId(id: string | null | undefined): number | null {
  const tail = id?.split(":").pop();
  const n = tail ? parseInt(tail, 10) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** MR/PR states past which no further transition (merge, approval, discussion) can occur. */
export const MR_TERMINAL_STATES = new Set(["merged", "closed"]);

// ─── EnrichedBranch type ─────────────────────────────────────────────────────

/** Re-export for downstream consumers */
export type { MRDashboardProps };

export interface EnrichedBranch {
  path: string;
  dirName: string;
  branch: string;
  linearId: string | null;
  ticket: LinearTicket | null;
  mr: MRInfo | null;
}

// ─── PullRequest → MRDashboardProps ──────────────────────────────────────────

/**
 * Cached MR shape: MRDashboardProps plus the head commit `sha`, which the
 * SDK's dashboard projection drops.
 */
export type MRInfo = MRDashboardProps & { sha: string | null };

export function toMRInfo(pr: PullRequest): MRInfo {
  // Delegates to glance-sdk ≥ 0.7.6, which uses mergeabilityChecks as a stable
  // source for `conflicts` (fixes GitLab's async boolean flapping).
  return { ...getMRDashboardProps(pr, "idle"), sha: pr.sha };
}

// ─── Branch cache (state.db, via lib/state) ──────────────────────────────────

/**
 * Upserts only the rows this process actually enriched, in ONE transaction
 * (spec "Store-by-store" item 1: "CLI-process enrich.ts paths upsert only
 * the rows they enriched, in a transaction"). `db.transaction` callbacks are
 * sync — never pass an async function here.
 *
 * The transaction is taken on the process singleton, which is the connection
 * every caller of `getBranchCacheStore()` (no argument) is already using —
 * both in the CLI and inside the daemon.
 */
function writeEnriched(store: BranchCacheStore, rows: Array<[string, CacheEntry]>): void {
  if (rows.length === 0) return;
  const commit = getStateDb().transaction((batch: Array<[string, CacheEntry]>) => {
    for (const [branch, entry] of batch) store.put(branch, entry);
  });
  commit(rows);
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

// ─── Segment-form label (rt-ui picker rows) ──────────────────────────────────

const PIPELINE_GLYPHS: Record<string, { glyph: string; tone: string }> = {
  success: { glyph: "✓", tone: "mint" },
  success_with_warnings: { glyph: "✓", tone: "peach" },
  failed: { glyph: "✗", tone: "coral" },
  running: { glyph: "⟳", tone: "cyan" },
  pending: { glyph: "⟳", tone: "faint" },
  created: { glyph: "○", tone: "faint" },
  canceled: { glyph: "✗", tone: "faint" },
};

const MR_STATE_GLYPHS: Record<string, { glyph: string; tone: string }> = {
  opened: { glyph: "◉", tone: "mint" },
  merged: { glyph: "●", tone: "blue" },
  closed: { glyph: "○", tone: "coral" },
};

/**
 * Segment-form sibling of `formatBranchLabelParts` for the rt-ui picker's row
 * model — same source fields and the same leading/trailing split, but tones
 * and hex values replace ANSI escapes so the picker can recolor per-theme and
 * step cursor-row weight itself. Linear's `stateColor` rides as `hex` because
 * it's a workspace's own dynamic truecolor, not one of the picker's named
 * theme tones.
 */
export function formatBranchSegments(eb: EnrichedBranch): { left: PickSegment[]; right: PickSegment[] } {
  const right: PickSegment[] = [];
  if (eb.mr?.pipeline) {
    const g = PIPELINE_GLYPHS[eb.mr.pipeline.status];
    if (g) right.push({ text: g.glyph, tone: g.tone });
  }
  if (eb.mr) {
    const g = MR_STATE_GLYPHS[eb.mr.state];
    if (g) {
      if (right.length > 0) right.push({ text: " " });
      right.push({ text: g.glyph, tone: g.tone });
    }
  }

  const isDefault = DEFAULT_BRANCHES.has(eb.branch);
  const isTicketBranch = !!(eb.linearId && eb.ticket);

  if (isTicketBranch) {
    const left: PickSegment[] = [
      { text: eb.dirName, tone: "text", bold: true },
      { text: " · ", tone: "faint" },
      { text: eb.ticket!.title, tone: "text", bold: true },
    ];
    if (eb.ticket!.stateName) {
      left.push(
        eb.ticket!.stateColor
          ? { text: ` [${eb.ticket!.stateName}]`, hex: eb.ticket!.stateColor }
          : { text: ` [${eb.ticket!.stateName}]`, tone: "dim" },
      );
    }
    return { left, right };
  }

  const left: PickSegment[] = eb.branch
    ? [
        { text: eb.dirName, tone: "text", bold: true },
        { text: " · ", tone: "faint" },
        { text: eb.branch, tone: "dim" },
      ]
    : [{ text: eb.dirName, tone: "text", bold: true }];

  if (right.length === 0) {
    right.push(
      eb.linearId
        ? { text: eb.linearId, tone: "dimmer" }
        : { text: isDefault ? "[main branch]" : "[Local Only]", tone: "dimmer" },
    );
  } else if (eb.linearId) {
    right.push({ text: " " }, { text: eb.linearId, tone: "dimmer" });
  }

  return { left, right };
}

// ─── Public enrichment API ───────────────────────────────────────────────────

/** Trivial enrichment for a branch that never carries MR/Linear data. */
function localOnly(b: { path: string; branch: string }): EnrichedBranch {
  return {
    path: b.path,
    dirName: b.path.split("/").pop() || b.path,
    branch: b.branch,
    linearId: null,
    ticket: null,
    mr: null,
  };
}

/**
 * Enrich a list of branches with Linear ticket + GitLab MR data.
 *
 * `on-deck/*` branches are worktree-pool plumbing: they never have an MR or a
 * ticket, and the daemon's cache-refresh deliberately never caches them. Gating
 * the real enrichment on `branches.every(cached)` would therefore always miss
 * for any repo with on-deck worktrees and force a cold fetch (the spinner) every
 * time. So they are enriched trivially as Local Only, kept out of the cache-hit
 * gate and the fetch, and only the real branches go through `enrichRealBranches`.
 */
export async function enrichBranches(
  branches: Array<{ path: string; branch: string }>,
  remoteUrl?: string,
  options?: { silent?: boolean; forceRefresh?: boolean },
): Promise<EnrichedBranch[]> {
  const real = branches.filter((b) => !b.branch.startsWith("on-deck/"));
  const enrichedReal = real.length > 0
    ? await enrichRealBranches(real, remoteUrl, options)
    : [];
  const byPath = new Map(enrichedReal.map((e) => [e.path, e]));
  return branches.map((b) => byPath.get(b.path) ?? localOnly(b));
}

async function enrichRealBranches(
  branches: Array<{ path: string; branch: string }>,
  remoteUrl?: string,
  options?: { silent?: boolean; forceRefresh?: boolean },
): Promise<EnrichedBranch[]> {
  // ── Daemon-first path: instant response from in-memory cache ──
  if (!options?.silent) {
    try {
      const { daemonQuery } = await import("./daemon-client.ts");
      const identity = identityForRemote(remoteUrl);
      const response = await daemonQuery("cache:read", {
        branches: branches.map(b => b.branch),
        repoIdentity: identity,
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

  // ── Existing logic (state.db cache + fetch) ──
  const secrets = await loadSecrets();
  const willFetch = !!(secrets.linearApiKey || secrets.gitlabToken);
  const store = getBranchCacheStore();
  const identity = identityForRemote(remoteUrl);

  const allCached = !options?.forceRefresh && willFetch
    && branches.every((b) => composeKey(identity, b.branch) in store.entries);

  if (allCached) {
    const cachedResults = branches.map((b) => {
      const entry = store.entries[composeKey(identity, b.branch)]!;
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
  return fetchAndCache(branches, remoteUrl, store, options?.silent ?? false);
}

async function fetchAndCache(
  branches: Array<{ path: string; branch: string }>,
  remoteUrl: string | undefined,
  store: BranchCacheStore,
  silent: boolean,
): Promise<EnrichedBranch[]> {
  const secrets = await loadSecrets();
  const willFetch = !!(secrets.linearApiKey || secrets.gitlabToken);
  const identity = identityForRemote(remoteUrl);

  let showSpinner = false;
  if (!silent && willFetch && process.stderr.isTTY) {
    showSpinner = true;
    process.stderr.write(`  ${cyan}⟳${reset} Fetching branch info…\r`);
  }

  // ── Step 1: Fetch GitLab MR data via glance-sdk (already batched) ──
  let mrMap = new Map<string, PullRequest | null>();
  let mrFetchSucceeded = false;

  if (secrets.gitlabToken && remoteUrl && isGitLabRemote(remoteUrl)) {
    const remote = parseRemoteUrl(remoteUrl);
    if (remote) {
      try {
        const provider = new GitLabProvider(remote.host, secrets.gitlabToken);
        const branchNames = branches.map(b => b.branch).filter(b => b !== "");
        if (branchNames.length > 0) {
          mrMap = await provider.fetchPullRequestsByBranches(remote.projectPath, branchNames);
          mrFetchSucceeded = true;
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
  let ticketFetchSucceeded = true;
  if (uniqueIds.length > 0 && secrets.linearApiKey) {
    try {
      ticketMap = await fetchTicketsBatch(secrets.linearApiKey, uniqueIds);
    } catch { ticketFetchSucceeded = false; }
  }

  // ── Step 4: Assemble results ──
  // Mirrors refreshAllMRs: a failed (or skipped — missing secrets) fetch must
  // preserve existing cache entries, not clobber them with nulls; and entries
  // must keep their repoName, which composes the key they are stored under.
  const enriched: Array<[string, CacheEntry]> = [];
  const results: EnrichedBranch[] = branches.map((b, idx) => {
    const dirName = b.path.split("/").pop() || b.path;
    const { linearId } = branchLinearIds[idx]!;
    const existing = store.entries[composeKey(identity, b.branch)];

    const pr = mrMap.get(b.branch) ?? null;
    const mr = mrFetchSucceeded ? (pr ? toMRInfo(pr) : null) : (existing?.mr ?? null);
    const freshTicket = linearId ? (ticketMap.get(linearId.toUpperCase()) ?? null) : null;
    const ticket = ticketFetchSucceeded && linearId
      ? freshTicket
      : (existing?.ticket ?? freshTicket);

    enriched.push([b.branch, {
      ticket,
      linearId: linearId || existing?.linearId || "",
      mr,
      fetchedAt: mrFetchSucceeded ? Date.now() : (existing?.fetchedAt ?? Date.now()),
      repoName: identity,
    }]);

    return { path: b.path, dirName, branch: b.branch, linearId, ticket, mr };
  });

  writeEnriched(store, enriched);

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
  signal?: AbortSignal,
): Promise<void> {
  // Mirrors subprocess.ts's opts.signal check: an already-aborted signal
  // skips the GitLab/Linear round trip rather than starting one just to
  // discard the result once the deadline (cache-refresh.ts) has passed.
  if (signal?.aborted) return;

  const secrets = await loadSecrets();
  // In the daemon this is the SAME singleton the handler context serves from
  // (spec "Store-by-store" item 1) — writes below land in the live map and
  // in state.db together, so the two can never diverge in one process.
  const store = getBranchCacheStore();
  const now = Date.now();

  // ── Step 1: Fetch MRs for all branches in 1 GraphQL call ──────────────
  let mrsByBranch = new Map<string, PullRequest | null>();
  let mrFetchSucceeded = false;

  if (secrets.gitlabToken && remoteUrl && isGitLabRemote(remoteUrl)) {
    const remote = parseRemoteUrl(remoteUrl);
    if (remote) {
      try {
        const provider = new GitLabProvider(remote.host, secrets.gitlabToken);
        const branchNames = branches.map(b => b.branch).filter(b => b !== "");
        if (branchNames.length > 0) {
          // Fetch all states in one query. The cache keeps whatever state
          // the SDK returns (opened/merged/closed); the notifier uses it to
          // fire distinct merged vs closed transitions, and readers filter
          // on it themselves.
          mrsByBranch = await provider.fetchPullRequestsByBranches(remote.projectPath, branchNames, 'all');
          mrFetchSucceeded = true;
        }
      } catch (err) {
        onError?.(`GitLab MR fetch failed for ${remote.projectPath}: ${err}`);
        // keep stale MR data to avoid false transitions in notifications
      }
    }
  }

  // A deadline that fires while the GitLab await above was in flight must
  // discard this cycle's result rather than let a slower, now-stale cycle
  // overwrite a newer one's cache rows (the coalescer permits a new cycle
  // the moment this one's deadline passes).
  if (signal?.aborted) return;

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

  // The Linear await above is the other non-cancellable gap this cycle can
  // outlive its own deadline in.
  if (signal?.aborted) return;

  // ── Step 4: Assemble and write cache ──────────────────────────────────
  const enriched: Array<[string, CacheEntry]> = [];
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
        const existing = store.entries[composeKey(repoName, b.branch)];
        if (existing?.linearId || existing?.ticket) {
          // Keep existing enrichment — we have nothing better to replace it with
          enriched.push([b.branch, { ...existing, fetchedAt: now, repoName }]);
          continue;
        }
      }

      enriched.push([b.branch, {
        ticket,
        linearId: linearId || "",
        mr,
        fetchedAt: now,
        repoName,
      }]);
    } else {
      // GitLab API failed entirely — preserve existing MR data to avoid false transitions.
      // If we also couldn't resolve a linearId (non-standard branch name, no MR title to fall
      // back on), preserve existing ticket/linearId too — we have nothing better to substitute.
      const existing = store.entries[composeKey(repoName, b.branch)];
      enriched.push([b.branch, {
        ticket:    linearId ? ticket : (existing?.ticket ?? null),
        linearId:  linearId || existing?.linearId || "",
        mr:        existing?.mr ?? null,
        fetchedAt: existing?.fetchedAt ?? now,
        repoName:  repoName ?? existing?.repoName,
      }]);
    }
  }

  writeEnriched(store, enriched);
}

// ─── Detached cache refresh ──────────────────────────────────────────────────

function spawnCacheRefresh(
  branches: Array<{ path: string; branch: string }>,
  remoteUrl: string | undefined,
): void {
  try {
    const scriptPath = fileURLToPath(import.meta.url);
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
  await fetchAndCache(data.branches, data.remoteUrl, getBranchCacheStore(), true);
}
