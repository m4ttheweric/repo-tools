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
 * This module is also the daemon's shared GitLab plumbing: per-repo provider
 * registry, current-user id, and the aggregated connection state broadcast
 * as `mr:status`.
 *
 * Lifecycle:
 *   initFreshness(env)      — daemon startup, after first cache refresh
 *   reconcileFreshness(env) — tail of every refreshCache(); follows repo index
 *   disposeFreshness()      — daemon shutdown
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { GitLabProvider, type EventCursor, type InvalidationKey, type PullRequest } from "@workforge/glance-sdk";
import { RT_DIR } from "../daemon-config.ts";
import { loadRepoTracking, grants } from "../repo-tracking.ts";
import { loadSecrets } from "../linear.ts";
import { parseRemoteUrl, isGitLabRemote, toMRInfo } from "../enrich.ts";
import { checkAndNotify } from "../notifier.ts";
import type { HandlerContext } from "./handlers/types.ts";
import { getDaemonLogger } from "../daemon-logger.ts";

const log = (await getDaemonLogger()).childLogger("freshness");

// ─── Env bundle (passed in from daemon.ts to avoid circular imports) ────────

export interface FreshnessEnv {
  ctx:       HandlerContext;
  broadcast: (type: string, data: any) => void;
}

// ─── Cursor persistence ──────────────────────────────────────────────────────

export const EVENTS_CURSORS_PATH = join(RT_DIR, "events-cursors.json");

export interface CursorStore {
  get(repoName: string): EventCursor | undefined;
  set(repoName: string, cursor: EventCursor): void;
}

/**
 * Tiny synchronous JSON map of repoName → EventCursor. A corrupt or missing
 * file means every repo cold-starts, which the SDK handles by establishing a
 * fresh cursor without firing invalidations. Write failures degrade to
 * in-memory cursors (a daemon restart then cold-starts, which is safe).
 */
export function createCursorStore(filePath: string): CursorStore {
  let map: Record<string, EventCursor> = {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) map = parsed;
  } catch { /* missing or corrupt file → cold start for all repos */ }

  return {
    get: (repoName) => map[repoName],
    set: (repoName, cursor) => {
      map[repoName] = cursor;
      try {
        writeFileSync(filePath, JSON.stringify(map, null, 2));
      } catch (err) {
        log.warn({ err }, "events-cursor write failed; continuing in-memory");
      }
    },
  };
}

const cursorStore = createCursorStore(EVENTS_CURSORS_PATH);

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
const providers = new Map<string, GitLabProvider>();
let   userId: number | null = null;
let   userIdResolved = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getRemoteUrl(repoPath: string): string | null {
  try {
    return execSync("git config --get remote.origin.url", {
      cwd: repoPath, encoding: "utf8", stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}

function ensureProvider(repoName: string, repoPath: string): GitLabProvider | null {
  const cached = providers.get(repoName);
  if (cached) return cached;

  const secrets = loadSecrets();
  if (!secrets.gitlabToken) {
    log.info(`no gitlabToken; skipping ${repoName}`);
    return null;
  }

  const remoteUrl = getRemoteUrl(repoPath);
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

  const provider = new GitLabProvider(remote.host, secrets.gitlabToken);
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
    log.info(`resolved userId=${userId}`);
  } catch (err) {
    log.warn({ err }, "token validation failed");
  }
  return userId;
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
      throw new Error(`repo "${repoName}" not in ~/.rt/repos.json (run rt repo add)`);
    }
    const secrets = loadSecrets();
    if (!secrets.gitlabToken) {
      throw new Error("missing gitlabToken in ~/.rt/secrets.json (run rt secret set gitlabToken <pat>)");
    }
    const remoteUrl = getRemoteUrl(repoPath);
    if (!remoteUrl) {
      throw new Error(`could not read git remote.origin.url in ${repoPath}`);
    }
    const remote = parseRemoteUrl(remoteUrl);
    if (!remote) {
      throw new Error(`could not parse remote URL "${remoteUrl}"`);
    }
    provider = new GitLabProvider(remote.host, secrets.gitlabToken);
    providers.set(repoName, provider);
  }

  // Pick projectPath: explicit override > previously-cached ephemeral > git remote.
  let projectPath: string | null = projectPathOverride ?? null;
  if (!projectPath) {
    const cached = ephemeralCtx.get(repoName);
    if (cached) projectPath = cached.projectPath;
  }
  if (!projectPath && repoPath) {
    const remoteUrl = getRemoteUrl(repoPath);
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
  // restRequest does NOT prepend /api/v4 — it just appends path to baseURL.
  const apiPath = `/api/v4/projects/${encodeURIComponent(projectPath)}`;
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
  "fetchSingleMR" | "fetchPullRequestByBranch" | "fetchPullRequestsByBranches"
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
    runner.pending.push(...keys);
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

  let mutated = false;

  for (const k of unique) {
    try {
      switch (k.kind) {
        case "mr": {
          const iid = Number(k.ref);
          const branch = branchByIid.get(iid);
          if (!branch) {
            // Not a cached MR. Could be someone else's, or an MR just opened
            // on one of our branches — the gap-fill decides cheaply.
            scheduleGapFill(env, target, runner, overrides);
            break;
          }
          const pr = await provider.fetchSingleMR(projectPath, iid, getCurrentUserId());
          mutated = updateEntry(env, repoName, branch, pr) || mutated;
          break;
        }
        case "notes": {
          const iid = Number(k.ref);
          if (!branchByIid.has(iid)) break; // not one of ours
          const refresh = overrides.refreshDiscussions ?? defaultRefreshDiscussions;
          await refresh(env, repoName, iid);
          break;
        }
        case "branch": {
          const entry = ctx.cache.entries[k.ref];
          if (!entry || entry.repoName !== repoName) break; // not one of ours
          const pr = await provider.fetchPullRequestByBranch(projectPath, k.ref, "all");
          if (!pr && runner.gapFillTimer) break; // MR may be mid-creation; let the gap-fill decide
          mutated = updateEntry(env, repoName, k.ref, pr) || mutated;
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

  if (mutated) {
    ctx.flushCache();
    const notify = overrides.notify
      ?? ((entries: Record<string, any>, uid: number | null) => checkAndNotify(entries, undefined, uid));
    notify(ctx.cache.entries, getCurrentUserId());
  }
}

/**
 * Write one refreshed MR into its cache entry, preserving enrichment fields
 * the events path never touches (ticket, linearId, discussions).
 * Returns true if the entry was written.
 */
function updateEntry(env: FreshnessEnv, repoName: string, branch: string, pr: PullRequest | null): boolean {
  const { ctx } = env;
  const existing = ctx.cache.entries[branch];
  if (!existing) return false; // lost race with a full refresh — skip
  const mr = pr ? toMRInfo(pr) : null;
  ctx.cache.entries[branch] = { ...existing, mr, fetchedAt: Date.now(), repoName };
  if (mr && typeof mr.iid === "number") {
    env.broadcast("mr:update", { repoName, mrs: { [mr.iid]: mr } });
  }
  return true;
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
    ctx.flushCache();
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

    const provider = ensureProvider(repoName, repoPath);
    if (!provider?.watchEvents) continue;
    if (!userIdResolved) await ensureUserId();

    // Re-check after the await: coalescing above should make this
    // unreachable, but the await is a yield point, so re-verify before
    // startWatch rather than trust a check made before it.
    if (watches.has(repoName)) continue;

    const remoteUrl = getRemoteUrl(repoPath);
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

function startWatch(env: FreshnessEnv, repoName: string, provider: GitLabProvider, projectPath: string): void {
  const resumeCursor = cursorStore.get(repoName);

  const watch: RepoWatch = {
    provider,
    projectPath,
    dispose:      () => {},
    projectId:    null,
    state:        "live",
    lastSyncedAt: null,
    lastEventId:  resumeCursor?.lastEventId ?? null,
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
        cursorStore.set(repoName, c);
        watch.lastEventId = c.lastEventId;
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
