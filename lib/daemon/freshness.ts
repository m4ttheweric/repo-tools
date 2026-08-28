/**
 * Live-freshness subsystem.
 *
 * One glance-sdk `watchEvents()` watcher per GitLab repo polls the project
 * events feed (SDK-owned loop, ~15s cadence) and reports invalidation keys.
 * The mapping in this module turns each key into the narrowest possible
 * cache refresh (single MR, single branch, one MR's discussions). The 5-min
 * full poll in cache-refresh.ts remains the safety net for the events feed's
 * blind spots (metadata-only MR edits, pipeline status transitions).
 *
 * The mapping's fan-out is grant-scoped: a repo granting only `branches`
 * gets today's branch-cache-only behavior (including the unknown-iid
 * gap-fill); a repo also granting `project-mrs` additionally upserts the
 * project open-MR store on `mr`/`branch` events (teammate MRs included,
 * without a second fetch when a local fetch already produced the PR); a
 * repo granting `discussions` gets `notes` events routed to the discussions
 * store, but only for MRs whose discussions are already cached.
 *
 * This module is also the daemon's shared GitLab plumbing: per-repo provider
 * registry, current-user id, and the aggregated connection state broadcast
 * as `mr:status`.
 *
 * Lifecycle:
 *   initFreshness(env)      — daemon startup, after first cache refresh
 *   reconcileFreshness(env) — tail of every refreshCache(); follows repo index
 *   disposeFreshness()      — daemon shutdown
 */

import { GitLabProvider, type InvalidationKey, type MRApprovalRules, type PullRequest } from "@mattstack/glance";
import { loadRepoTracking, grants, type RepoGrants } from "../repo-tracking.ts";
import { loadSecrets } from "../linear.ts";
import { parseRemoteUrl, isGitLabRemote, toMRInfo } from "../enrich.ts";
import { checkAndNotify } from "../notifier.ts";
import type { HandlerContext } from "./handlers/types.ts";
import { lazyChildLogger } from "../daemon-logger.ts";
import { getProjectMRs, type ProjectMRs } from "./project-mrs-store.ts";
import { getDiscussionsFileStore } from "./discussions-file-store.ts";
import { createCursorStore, type CursorStore } from "../state/index.ts";
import { runCapture } from "../subprocess.ts";

const log = lazyChildLogger("freshness");

// ─── Env bundle (passed in from daemon.ts to avoid circular imports) ────────

export interface FreshnessEnv {
  ctx:       HandlerContext;
  broadcast: (type: string, data: any) => void;
}

// ─── Cursor persistence ──────────────────────────────────────────────────────
//
// createCursorStore/CursorStore now live in lib/state/cursors-store.ts (spec
// "Store-by-store" item 5: `kv` rows, ns='events-cursor', k=repoName),
// imported above via the barrel and re-exported here so existing importers
// of `../freshness.ts` don't break. The store itself is constructed lazily
// on first use (never at module scope) so importing this module never
// touches state.db (the "no module-load db access" rule — see
// lib/state/db.ts).

export { createCursorStore, type CursorStore };

let cursorStoreSingleton: CursorStore | null = null;

function cursorStore(): CursorStore {
  return cursorStoreSingleton ??= createCursorStore();
}

// ─── State ───────────────────────────────────────────────────────────────────

/** Per-repo live watcher state. Structurally a BatchRunner (Task 3). */
interface RepoWatch {
  provider:     GitLabProvider;
  projectPath:  string;
  dispose:      () => void;
  /** Numeric GitLab project id. Resolved lazily on first discussions fetch. */
  projectId:    number | null;
  state:        "live" | "degraded";
  lastSyncedAt: string | null;
  lastEventId:  number | null;
  processing:   boolean;
  pending:      InvalidationKey[];
  gapFillTimer: ReturnType<typeof setTimeout> | null;
  /** Set by stopWatch; tells a gap-fill timer armed just before teardown not to fire. */
  disposed:     boolean;
}

const watches   = new Map<string, RepoWatch>();

/** Bound merged pending so a wedged processKeys cannot grow memory unbounded. */
export const PENDING_CAP = 1000;

const providers = new Map<string, GitLabProvider>();
let   userId: number | null = null;
let   userIdResolved = false;
let   selfUsername: string | null = null;

const remoteUrlCache = new Map<string, string | null>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** remote.origin.url, cached per repoPath for the process lifetime (remotes
 *  rarely change). Async so it never blocks the event loop. */
async function getRemoteUrl(repoPath: string): Promise<string | null> {
  const cached = remoteUrlCache.get(repoPath);
  if (cached !== undefined) return cached;
  const r = await runCapture(["git", "config", "--get", "remote.origin.url"], {
    cwd: repoPath,
    timeoutMs: 5000,
    stderr: "ignore",
  });
  const url = r.exitCode === 0 ? (r.stdout.trim() || null) : null;
  remoteUrlCache.set(repoPath, url);
  return url;
}

/** The same debug-accounting hook makeProvider wires, for SDK helpers rt constructs directly (NoteMutator). */
export function providerRequestHook(): { onRequest: (info: { op: string; transport: "graphql" | "rest"; method: string; path: string; durationMs: number; status: number }) => void } {
  return {
    onRequest: (info) => log.debug(
      { op: info.op, transport: info.transport, status: info.status, ms: Math.round(info.durationMs) },
      "api request",
    ),
  };
}

/**
 * All daemon-built providers carry the SDK's onRequest hook wired to the
 * freshness logger at debug. This is the API-accounting source for the
 * stress-test gates (spec §10.2) — one line per logical SDK operation,
 * visible under RT_LOG_LEVEL=debug.
 */
function makeProvider(host: string, token: string): GitLabProvider {
  return new GitLabProvider(host, token, providerRequestHook());
}

async function ensureProvider(repoName: string, repoPath: string): Promise<GitLabProvider | null> {
  const cached = providers.get(repoName);
  if (cached) return cached;

  const secrets = await loadSecrets();
  if (!secrets.gitlabToken) {
    log.info(`no gitlabToken; skipping ${repoName}`);
    return null;
  }

  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    log.info(`no origin remote for ${repoName}; skipping`);
    return null;
  }

  if (!isGitLabRemote(remoteUrl)) {
    log.info(`remote "${remoteUrl}" for ${repoName} is not GitLab; skipping events watch`);
    return null;
  }

  const remote = parseRemoteUrl(remoteUrl);
  if (!remote) {
    log.info(`could not parse remote "${remoteUrl}" for ${repoName}; skipping`);
    return null;
  }

  const provider = makeProvider(remote.host, secrets.gitlabToken);
  providers.set(repoName, provider);
  return provider;
}

async function ensureUserId(): Promise<number | null> {
  if (userIdResolved) return userId;
  // Resolve via any available provider. If none exist yet, defer until one does.
  const anyProvider = providers.values().next().value as GitLabProvider | undefined;
  if (!anyProvider) return null;

  try {
    const user = await anyProvider.validateToken();
    const numId = user.id.split(":").pop();
    userId = numId ? parseInt(numId, 10) : null;
    userIdResolved = true;
    selfUsername = user.username ?? null;
    log.info(`resolved userId=${userId}`);
  } catch (err) {
    log.warn({ err }, "token validation failed");
  }
  return userId;
}

export function getSelfUsername(): string | null { return selfUsername; }

export async function resolveSelfUsername(repoName: string, repoPath: string): Promise<string | null> {
  if (selfUsername) return selfUsername;
  try {
    await getRepoContext(repoName, repoPath);   // materializes a provider for ensureUserId
    await ensureUserId();
    return selfUsername;
  } catch (err) {
    log.warn({ err, repo: repoName }, "self username resolution failed");
    return null;
  }
}

// ─── Aggregated connection state ─────────────────────────────────────────────

/**
 * Roll up watcher states into the `mr:status` connection flag clients already
 * consume: any degraded watcher → "connecting", all live → "connected",
 * no watchers → "disconnected".
 */
export function getAggregatedConnection(): "connected" | "connecting" | "disconnected" {
  if (watches.size === 0) return "disconnected";
  for (const w of watches.values()) {
    if (w.state === "degraded") return "connecting";
  }
  return "connected";
}

function broadcastStatus(env: FreshnessEnv): void {
  env.broadcast("mr:status", { connection: getAggregatedConnection() });
}

/** Per-repo watcher freshness for `rt daemon status`. */
export function getFreshnessSnapshot(): Record<
  string,
  { state: "live" | "degraded"; lastSyncedAt: string | null; lastEventId: number | null }
> {
  const out: Record<string, { state: "live" | "degraded"; lastSyncedAt: string | null; lastEventId: number | null }> = {};
  for (const [repoName, w] of watches) {
    out[repoName] = { state: w.state, lastSyncedAt: w.lastSyncedAt, lastEventId: w.lastEventId };
  }
  return out;
}

// ─── Repo context (shared GitLab plumbing) ───────────────────────────────────

/**
 * Cache of (projectPath, projectId) resolved for repos without a live watch.
 * Lets the discussions handlers run against repos whose watcher was never set
 * up (missing token at boot, non-indexed repo) or was disposed.
 */
const ephemeralCtx = new Map<string, { projectPath: string; projectId: number | null }>();

/**
 * Provider + project identifiers for a repo. Tries the live-watch fast path
 * first; if no watch exists and `repoPath` is provided, builds an ephemeral
 * `GitLabProvider` from the repo's git remote so REST-only operations
 * (discussions read/resolve/reply, MR actions) keep working.
 *
 * `projectPathOverride` lets callers supply the canonical project path
 * directly — useful when a repo's git remote URL has been redirected/renamed
 * since clone time and the API would 404 on the stale path. Pass the path
 * extracted from a cached MR's webUrl when available.
 *
 * Throws with a specific reason when no provider can be produced. Callers
 * surface the message so the UI can show which step failed
 * (missing token, unparseable remote, REST 404, …).
 */
export async function getRepoContext(
  repoName: string,
  repoPath?: string,
  projectPathOverride?: string,
): Promise<{ provider: GitLabProvider; projectPath: string; projectId: number }> {
  const watch = watches.get(repoName);
  let provider = providers.get(repoName) ?? null;

  // Live-watch fast path — but only when the caller didn't override projectPath.
  // If they did, fall through to the ephemeral path so we use the canonical path.
  if (watch && provider && !projectPathOverride) {
    if (watch.projectId !== null) {
      return { provider, projectPath: watch.projectPath, projectId: watch.projectId };
    }
    const id = await fetchProjectId(provider, watch.projectPath);
    watch.projectId = id;
    return { provider, projectPath: watch.projectPath, projectId: id };
  }

  // Provider not yet built — construct from git remote.
  if (!provider) {
    if (!repoPath) {
      throw new Error(`repo "${repoName}" not in ~/.mattstack/rt/repos.json (run rt repo add)`);
    }
    const secrets = await loadSecrets();
    if (!secrets.gitlabToken) {
      throw new Error("missing gitlabToken (run: rt secrets set rt gitlabToken)");
    }
    const remoteUrl = await getRemoteUrl(repoPath);
    if (!remoteUrl) {
      throw new Error(`could not read git remote.origin.url in ${repoPath}`);
    }
    const remote = parseRemoteUrl(remoteUrl);
    if (!remote) {
      throw new Error(`could not parse remote URL "${remoteUrl}"`);
    }
    provider = makeProvider(remote.host, secrets.gitlabToken);
    providers.set(repoName, provider);
  }

  // Pick projectPath: explicit override > previously-cached ephemeral > git remote.
  let projectPath: string | null = projectPathOverride ?? null;
  if (!projectPath) {
    const cached = ephemeralCtx.get(repoName);
    if (cached) projectPath = cached.projectPath;
  }
  if (!projectPath && repoPath) {
    const remoteUrl = await getRemoteUrl(repoPath);
    const remote = remoteUrl ? parseRemoteUrl(remoteUrl) : null;
    if (remote) projectPath = remote.projectPath;
  }
  if (!projectPath) {
    throw new Error(`could not determine projectPath for ${repoName}`);
  }

  // Reuse cached projectId only when the path matches.
  const cached = ephemeralCtx.get(repoName);
  if (cached && cached.projectPath === projectPath && cached.projectId !== null) {
    return { provider, projectPath, projectId: cached.projectId };
  }

  const projectId = await fetchProjectId(provider, projectPath);
  ephemeralCtx.set(repoName, { projectPath, projectId });
  return { provider, projectPath, projectId };
}

async function fetchProjectId(provider: GitLabProvider, projectPath: string): Promise<number> {
  // glance >=0.14 prefixes /api/v4 itself and rejects pre-prefixed paths
  // (MAT-130), so this path is provider-relative.
  const apiPath = `/projects/${encodeURIComponent(projectPath)}`;
  let res: Response;
  try {
    res = await provider.restRequest("GET", apiPath);
  } catch (err) {
    throw new Error(`GitLab ${apiPath} lookup failed: ${String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`GitLab ${apiPath} returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { id?: number };
  if (typeof body.id !== "number") {
    throw new Error(`GitLab ${apiPath} response missing numeric id`);
  }
  return body.id;
}

/**
 * Numeric id of the authenticated GitLab user, or null if not yet resolved.
 * Used by the discussions poller so new-comment notifications can skip the
 * user's own replies, and by fetchSingleMR for viewer-scoped fields.
 */
export function getCurrentUserId(): number | null {
  return userId;
}

// ─── Invalidation → targeted refresh mapping ─────────────────────────────────

export const GAP_FILL_DEBOUNCE_MS = 5000;

/** Narrow provider surface the mapping needs — tests stub this. */
export type TargetedFetcher = Pick<
  GitLabProvider,
  "fetchSingleMR" | "fetchPullRequestByBranch" | "fetchPullRequestsByBranches" | "fetchApprovalRules"
>;

export interface RepoTarget {
  repoName:    string;
  projectPath: string;
  provider:    TargetedFetcher;
}

/** Mutable batch-processing state. RepoWatch satisfies this structurally. */
export interface BatchRunner {
  processing:   boolean;
  pending:      InvalidationKey[];
  gapFillTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Optional so bare test runners (never registered in `watches`) don't need
   * it; production runners are always RepoWatch, which always sets it.
   */
  disposed?:    boolean;
}

/** Test seams. Production callers omit this. */
export interface MappingOverrides {
  refreshDiscussions?: (env: FreshnessEnv, repoName: string, iid: number) => Promise<unknown>;
  notify?:             (entries: Record<string, any>, userId: number | null) => void;
  gapFillDebounceMs?:  number;
  grantsFor?:            (repoName: string) => RepoGrants;                   // default: grants(loadRepoTracking(), repoName)
  projectStore?:         ProjectMRs;                                          // default: getProjectMRs()
  hasCachedDiscussions?: (repoName: string, iid: number) => boolean;          // default: file-store read !== undefined
  /** Approval-heal seam: rules for just these iids. default: provider.fetchApprovalRules({projectPath, iids}) */
  fetchRulesByIid?:      (iids: number[]) => Promise<MRApprovalRules[]>;
}

/**
 * Process one tick's invalidations for a repo. Batches arriving while a
 * previous batch is still processing are merged into `runner.pending` and
 * drained when the current run finishes — no overlap, no loss.
 */
export async function applyInvalidationBatch(
  env: FreshnessEnv,
  target: RepoTarget,
  runner: BatchRunner,
  keys: InvalidationKey[],
  overrides: MappingOverrides = {},
): Promise<void> {
  if (runner.processing) {
    const seen = new Set(runner.pending.map((k) => `${k.kind}:${k.ref}`));
    for (const k of keys) {
      if (runner.pending.length >= PENDING_CAP) break;
      const id = `${k.kind}:${k.ref}`;
      if (seen.has(id)) continue;
      seen.add(id);
      runner.pending.push(k);
    }
    return;
  }
  runner.processing = true;
  try {
    await processKeys(env, target, runner, keys, overrides);
    while (runner.pending.length > 0) {
      const drained = runner.pending.splice(0);
      await processKeys(env, target, runner, drained, overrides);
    }
  } finally {
    runner.processing = false;
  }
}

async function processKeys(
  env: FreshnessEnv,
  target: RepoTarget,
  runner: BatchRunner,
  keys: InvalidationKey[],
  overrides: MappingOverrides,
): Promise<void> {
  const { ctx } = env;
  const { repoName, projectPath, provider } = target;

  // Dedup by kind:ref. The SDK dedups within a tick, but merged pending
  // batches can re-introduce duplicates.
  const seen = new Set<string>();
  const unique = keys.filter((k) => {
    const id = `${k.kind}:${k.ref}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // iid → branch for this repo, rebuilt per batch (the cache may have been
  // reloaded from disk by the full poll since the last tick).
  const branchByIid = new Map<number, string>();
  for (const [branch, entry] of Object.entries(ctx.cache.entries)) {
    if (entry.repoName !== repoName) continue;
    if (typeof entry.mr?.iid === "number") branchByIid.set(entry.mr.iid, branch);
  }

  const g = (overrides.grantsFor ?? ((r: string) => grants(loadRepoTracking(), r)))(repoName);
  const pStore = overrides.projectStore ?? getProjectMRs();
  const wantProject = g.caches.has("project-mrs");

  const upsertProject = (pr: PullRequest) => {
    // Demand-scoped repos only track the declared authors; an MR missing an
    // author never guess-drops, since we can't tell which side of the scope
    // it belongs on. A tagged stranger (out-of-scope author, still section-
    // tagged) is kept too: dropping it here would silently erase a tag that
    // only the approval-heal path is meant to clear.
    const rec = pStore.read(repoName);
    const scope = rec?.scope;
    const tagged = (rec?.mrs[pr.iid]?.codeownerSections?.length ?? 0) > 0;
    if (scope && pr.author?.username && !scope.authors.includes(pr.author.username) && !tagged) return;
    const changed = pStore.upsert(repoName, projectPath, pr, "events");
    if (changed.length > 0) env.broadcast("project-mrs", { repoName, iids: changed });
  };

  let mutated = false;

  for (const k of unique) {
    try {
      switch (k.kind) {
        case "mr": {
          const iid = Number(k.ref);
          const branch = branchByIid.get(iid);
          if (!branch && !wantProject) {
            // Not a cached MR and no project store to feed. Could be
            // someone else's, or an MR just opened on one of our branches —
            // the gap-fill decides cheaply.
            scheduleGapFill(env, target, runner, overrides);
            break;
          }
          const pr = await provider.fetchSingleMR(projectPath, iid, getCurrentUserId());
          const feedBranch = branch
            ?? (pr && ctx.cache.entries[pr.sourceBranch]?.repoName === repoName ? pr.sourceBranch : undefined);
          if (feedBranch) mutated = updateEntry(env, repoName, feedBranch, pr) || mutated;
          if (wantProject && pr) upsertProject(pr);
          // GitLab's approval action bumps no updatedAt, so this is the only
          // signal that heals a tag within one events tick rather than
          // waiting on the next deep/delta sweep.
          if (k.cause === "approved" && wantProject) {
            const rec = pStore.read(repoName);
            const sections = rec?.scope?.sections ?? [];
            if (sections.length > 0 && (rec?.mrs[iid]?.codeownerSections?.length ?? 0) > 0) {
              const fetchRulesByIid = overrides.fetchRulesByIid
                ?? (async (iids: number[]) => provider.fetchApprovalRules({ projectPath, iids }));
              const rules = await fetchRulesByIid([iid]);
              const match = rules.find((r) => r.iid === iid);
              if (match) {
                const { sectionsMatching } = await import("./project-sync.ts");
                pStore.setSectionTags(repoName, { [iid]: sectionsMatching(match.rules, sections) });
                env.broadcast("project-mrs", { repoName, iids: [iid] });
              }
            }
          }
          break;
        }
        case "notes": {
          const iid = Number(k.ref);
          if (!g.caches.has("discussions")) break; // repo doesn't grant discussions
          const hasCached = overrides.hasCachedDiscussions
            ?? ((repo: string, mrIid: number) => getDiscussionsFileStore().read(repo, mrIid) !== undefined);
          if (!hasCached(repoName, iid)) break; // not something a consumer has looked at
          const refresh = overrides.refreshDiscussions ?? defaultRefreshDiscussions;
          await refresh(env, repoName, iid);
          break;
        }
        case "branch": {
          const entry = ctx.cache.entries[k.ref];
          const isOurs = entry !== undefined && entry.repoName === repoName;
          let fetchedForRef: PullRequest | null | undefined;
          if (isOurs) {
            fetchedForRef = await provider.fetchPullRequestByBranch(projectPath, k.ref, "all");
            if (!(fetchedForRef == null && runner.gapFillTimer)) {
              // MR may be mid-creation when null and a gap-fill is already
              // armed; let the gap-fill decide instead of writing null now.
              mutated = updateEntry(env, repoName, k.ref, fetchedForRef ?? null) || mutated;
            }
          }
          if (wantProject) {
            if (fetchedForRef) {
              // Local push: reuse the PR the local handling just fetched.
              upsertProject(fetchedForRef);
            } else if (!isOurs) {
              // Teammate push: resolve the branch through the project store.
              const hit = pStore.findBySourceBranch(repoName, k.ref);
              if (hit) {
                const pr = await provider.fetchSingleMR(projectPath, hit.iid, getCurrentUserId());
                if (pr) upsertProject(pr);
              }
            }
          }
          break;
        }
        case "pipelines":
          // Pipeline status transitions emit no events (verified blind spot);
          // the 5-min full poll covers pipeline drift.
          break;
      }
    } catch (err) {
      log.warn({ err, repo: repoName, key: `${k.kind}:${k.ref}` }, "targeted refresh failed");
    }
  }

  // `mutated` survives RT-48 because it gates the NOTIFY, not a flush: only
  // a batch that actually changed an entry is worth re-running transition
  // detection over. The persistence it used to gate is gone — updateEntry
  // writes the row itself.
  if (mutated) {
    const notify = overrides.notify
      ?? ((entries: Record<string, any>, uid: number | null) => checkAndNotify(entries, undefined, uid));
    notify(ctx.cache.entries, getCurrentUserId());
  }
}

/**
 * Write one refreshed MR into its cache entry, preserving enrichment fields
 * the events path never touches (ticket, linearId).
 * Returns true if the entry was written.
 *
 * RT-48: this is the TRUE mutation site, so this is where write-through
 * lands (spec "Store-by-store" item 1). `store.put` updates the row and the
 * in-memory map in one call — the old batch-tail `ctx.flushCache()` calls
 * are gone, and with them the window where a daemon crash between mutation
 * and flush lost the update.
 */
function updateEntry(env: FreshnessEnv, repoName: string, branch: string, pr: PullRequest | null): boolean {
  const { ctx } = env;
  const existing = ctx.cache.entries[branch];
  if (!existing) return false; // lost race with a full refresh — skip
  const mr = pr ? toMRInfo(pr) : null;
  ctx.cache.put(branch, { ...existing, mr, fetchedAt: Date.now(), repoName });
  if (mr && typeof mr.iid === "number") {
    env.broadcast("mr:update", { repoName, mrs: { [mr.iid]: mr } });
  }
  return true;
}

/**
 * Mutation write-back (spec §5.4): after an rt-mediated MR mutation, write
 * the fresh PR into whichever stores hold it. The branch entry updates
 * unconditionally (it exists only if the MR is one of ours); the project
 * store updates only under the "project-mrs" grant.
 */
export function applyMRWriteback(env: FreshnessEnv, repoName: string, projectPath: string, pr: PullRequest): void {
  let branch: string | null = null;
  for (const [b, entry] of Object.entries(env.ctx.cache.entries)) {
    if (entry.repoName === repoName && entry.mr?.iid === pr.iid) { branch = b; break; }
  }
  if (branch) updateEntry(env, repoName, branch, pr);

  if (grants(loadRepoTracking(), repoName).caches.has("project-mrs")) {
    const changed = getProjectMRs().upsert(repoName, projectPath, pr, "mutation");
    if (changed.length > 0) env.broadcast("project-mrs", { repoName, iids: changed });
  }
}

async function defaultRefreshDiscussions(env: FreshnessEnv, repoName: string, iid: number): Promise<unknown> {
  // Dynamic import: discussions-store imports getRepoContext from this
  // module, so a static import here would be a top-level-await cycle.
  const { refreshDiscussions } = await import("./discussions-store.ts");
  return refreshDiscussions({ ctx: env.ctx, broadcast: env.broadcast }, repoName, iid);
}

/**
 * Debounced catch-all for events about MRs we don't have cached: one batch
 * fetch over this repo's branches that currently lack an MR. Covers the
 * "MR just opened on my branch" case without paying anything for other
 * users' MR activity (no null-mr branches → no request at all).
 */
function scheduleGapFill(
  env: FreshnessEnv,
  target: RepoTarget,
  runner: BatchRunner,
  overrides: MappingOverrides,
): void {
  if (runner.disposed) return; // stopWatch already tore this repo down
  if (runner.gapFillTimer) return; // already scheduled
  const delay = overrides.gapFillDebounceMs ?? GAP_FILL_DEBOUNCE_MS;
  runner.gapFillTimer = setTimeout(() => {
    runner.gapFillTimer = null;
    if (runner.disposed) return; // stopWatch ran while this timer was pending
    runGapFill(env, target, overrides).catch((err) => {
      log.warn({ err, repo: target.repoName }, "gap-fill failed");
    });
  }, delay);
}

async function runGapFill(env: FreshnessEnv, target: RepoTarget, overrides: MappingOverrides): Promise<void> {
  const { ctx } = env;
  const { repoName, projectPath, provider } = target;

  const nullMrBranches = Object.entries(ctx.cache.entries)
    .filter(([, e]) => e.repoName === repoName && e.mr == null)
    .map(([branch]) => branch);
  if (nullMrBranches.length === 0) return;
  if (!provider.fetchPullRequestsByBranches) return;

  const found = await provider.fetchPullRequestsByBranches(projectPath, nullMrBranches, "all");
  let mutated = false;
  for (const [branch, pr] of found) {
    if (!pr) continue; // still no MR — leave the entry untouched
    mutated = updateEntry(env, repoName, branch, pr) || mutated;
  }
  if (mutated) {
    const notify = overrides.notify
      ?? ((entries: Record<string, any>, uid: number | null) => checkAndNotify(entries, undefined, uid));
    notify(ctx.cache.entries, getCurrentUserId());
    log.info({ repo: repoName, filled: [...found.values()].filter(Boolean).length }, "gap-fill applied");
  }
}

// ─── Watcher lifecycle ───────────────────────────────────────────────────────

export async function initFreshness(env: FreshnessEnv): Promise<void> {
  log.info("initializing");
  await reconcileFreshness(env);
}

// The 7s boot timer (initFreshness) and every refreshCache() tail call
// reconcileFreshness, and they can overlap in real time. Coalesce the same
// way cache-refresh.ts does: a caller that arrives while one is running
// awaits the in-flight run instead of starting a second pass that could
// double-startWatch the same repo.
let reconcileInFlight: Promise<void> | null = null;

/**
 * Align watchers with the repo index and the tracking config: start one per
 * live-tracked GitLab repo that lacks one, dispose watchers for repos removed
 * from either. A watcher covers the whole project regardless of how many MRs
 * are cached, because pushes to MR-less branches matter too.
 */
export function reconcileFreshness(env: FreshnessEnv): Promise<void> {
  if (reconcileInFlight) return reconcileInFlight;
  reconcileInFlight = reconcileFreshnessImpl(env).finally(() => { reconcileInFlight = null; });
  return reconcileInFlight;
}

async function reconcileFreshnessImpl(env: FreshnessEnv): Promise<void> {
  const repoIndex = env.ctx.repoIndex();
  const tracking = loadRepoTracking();

  for (const [repoName, repoPath] of Object.entries(repoIndex)) {
    if (grants(tracking, repoName).mode !== "live") continue;
    if (watches.has(repoName)) continue;

    const provider = await ensureProvider(repoName, repoPath);
    if (!provider?.watchEvents) continue;
    if (!userIdResolved) await ensureUserId();

    // Re-check after the await: coalescing above should make this
    // unreachable, but the await is a yield point, so re-verify before
    // startWatch rather than trust a check made before it.
    if (watches.has(repoName)) continue;

    const remoteUrl = await getRemoteUrl(repoPath);
    const remote = remoteUrl ? parseRemoteUrl(remoteUrl) : null;
    if (!remote) continue;

    startWatch(env, repoName, provider, remote.projectPath);
  }

  for (const repoName of [...watches.keys()]) {
    if (!repoIndex[repoName]) {
      stopWatch(repoName);
      log.info(`disposed watcher for ${repoName} (repo removed from index)`);
    } else if (grants(tracking, repoName).mode !== "live") {
      stopWatch(repoName);
      log.info(`disposed watcher for ${repoName} (no longer tracked live)`);
    }
  }

  broadcastStatus(env);
}

// glance >=0.15 widened EventCursor.lastEventId to number | string | null for
// GitHub's string event ids. This watch path is GitLab-only, whose ids stay
// numeric; anything else reads as absent, same as glance's own pollers treat
// foreign cursor shapes.
function numericEventId(v: number | string | null | undefined): number | null {
  return typeof v === "number" ? v : null;
}

function startWatch(env: FreshnessEnv, repoName: string, provider: GitLabProvider, projectPath: string): void {
  const resumeCursor = cursorStore().get(repoName);

  const watch: RepoWatch = {
    provider,
    projectPath,
    dispose:      () => {},
    projectId:    null,
    state:        "live",
    lastSyncedAt: null,
    lastEventId:  numericEventId(resumeCursor?.lastEventId),
    processing:   false,
    pending:      [],
    gapFillTimer: null,
    disposed:     false,
  };

  watch.dispose = provider.watchEvents!(
    projectPath,
    {
      cursor: resumeCursor,
      onCursor: (c) => {
        cursorStore().set(repoName, c);
        watch.lastEventId = numericEventId(c.lastEventId);
      },
      onStatus: (s) => {
        const prev = watch.state;
        watch.state = s.state;
        watch.lastSyncedAt = s.lastSyncedAt;
        if (prev !== s.state) {
          log.info({ repo: repoName, state: s.state, cause: s.cause ?? null }, "events watcher status");
          broadcastStatus(env);
        }
      },
    },
    (batch) => {
      watch.lastSyncedAt = batch.syncedAt;
      if (batch.invalidations.length === 0) return;
      applyInvalidationBatch(env, { repoName, projectPath, provider }, watch, batch.invalidations)
        .catch((err) => log.warn({ err, repo: repoName }, "invalidation batch failed"));
    },
  );

  watches.set(repoName, watch);
  log.info({ repo: repoName, projectPath, resumed: resumeCursor != null }, "events watcher started");

  // Watcher start = the repo just went live; give project-mrs consumers
  // data now instead of at the next 5-min cycle.
  if (grants(loadRepoTracking(), repoName).caches.has("project-mrs")) {
    import("./project-sync.ts")
      .then(({ syncProjectMRs }) =>
        syncProjectMRs({ repoIndex: () => env.ctx.repoIndex(), broadcast: env.broadcast }, repoName))
      .catch((err) => log.warn({ err, repo: repoName }, "watcher-start project sync failed"));
  }
}

function stopWatch(repoName: string): void {
  const w = watches.get(repoName);
  if (!w) return;
  w.disposed = true; // must be set before dispose(): a batch already in flight checks this on the way out
  try { w.dispose(); } catch { /* watcher already stopped */ }
  if (w.gapFillTimer) clearTimeout(w.gapFillTimer);
  watches.delete(repoName);
}

export function disposeFreshness(): void {
  for (const repoName of [...watches.keys()]) stopWatch(repoName);
  providers.clear();
  userId = null;
  userIdResolved = false;
}
