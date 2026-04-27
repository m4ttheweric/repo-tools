/**
 * MR live subscription subsystem.
 *
 * The daemon owns one GitLabProvider and one glance-sdk DashboardGroup per
 * tracked repo. Incoming live MR updates from the WS feed are written back
 * into the daemon's cache (preserving ticket/linearId) and broadcast to any
 * connected UI clients as `mr:update` events. An aggregated connection
 * status rolls up per-repo WatcherStatus into a single `mr:status` event.
 *
 * Clients (rt status, rt mr-status) read initial state from `cache:read` and
 * subscribe to these WS events for push updates. They no longer need to open
 * their own glance-sdk subscriptions.
 *
 * Lifecycle:
 *   initMRSubscriptions(env)      — called at daemon startup after first cache refresh
 *   reconcileMRSubscriptions(env) — called at the tail of every refreshCache()
 *   disposeAllMRSubscriptions()   — called on daemon shutdown
 */

import { execSync } from "child_process";
import {
  GitLabProvider,
  createDashboard,
  type DashboardGroup,
  type MRDashboardActions,
  type MRDashboardProps,
} from "@workforge/glance-sdk";
import { loadSecrets } from "../linear.ts";
import { parseRemoteUrl } from "../enrich.ts";
import type { HandlerContext, CacheEntry } from "./handlers/types.ts";

// ─── State ───────────────────────────────────────────────────────────────────

interface GroupState {
  group:        DashboardGroup;
  /** iid → branch name (for write-back to ctx.cache.entries). */
  branchByIid:  Map<number, string>;
  /** Current set of iids this group is watching. */
  iids:         Set<number>;
  connection:   "connecting" | "connected" | "disconnected" | "reconnecting";
  /** GitLab project path (e.g. "group/proj"). Needed by resolveDiscussion. */
  projectPath:  string;
  /** Numeric GitLab project id. Resolved lazily on first discussions fetch. */
  projectId:    number | null;
}

const providers = new Map<string, GitLabProvider>();
const groups    = new Map<string, GroupState>();
let   userId: number | null = null;
let   userIdResolved = false;

// ─── Env bundle (passed in from daemon.ts to avoid circular imports) ────────

export interface MRSubscriptionEnv {
  ctx:       HandlerContext;
  log:       (msg: string) => void;
  broadcast: (type: string, data: any) => void;
}

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

/**
 * Roll up all active group connection states into one flag:
 *   any disconnected   → disconnected
 *   else any reconnecting/connecting → connecting
 *   else all connected → connected
 *   empty              → disconnected
 */
function aggregatedConnection(): "connected" | "connecting" | "disconnected" {
  if (groups.size === 0) return "disconnected";
  let sawConnecting = false;
  for (const { connection } of groups.values()) {
    if (connection === "disconnected") return "disconnected";
    if (connection === "connecting" || connection === "reconnecting") sawConnecting = true;
  }
  return sawConnecting ? "connecting" : "connected";
}

function broadcastStatus(env: MRSubscriptionEnv): void {
  env.broadcast("mr:status", { connection: aggregatedConnection() });
}

/**
 * Compute {iid → branch} for a repo from the daemon cache. The daemon refresh
 * stamps `repoName` on each entry; anything without `repoName` is ignored here
 * (legacy entries get backfilled on next refreshAllMRs pass).
 */
function iidMapForRepo(ctx: HandlerContext, repoName: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const [branch, entry] of Object.entries(ctx.cache.entries)) {
    if (entry.repoName !== repoName) continue;
    const iid = entry.mr?.iid;
    if (typeof iid === "number") out.set(iid, branch);
  }
  return out;
}

// ─── Subscribe callback: write cache + broadcast ─────────────────────────────

function onGroupUpdate(
  env: MRSubscriptionEnv,
  repoName: string,
  state: GroupState,
  mrs: Map<number, MRDashboardProps>,
): void {
  const { ctx } = env;
  const emitted: Record<number, MRDashboardProps> = {};
  let mutated = false;

  for (const [iid, mr] of mrs) {
    const branch = state.branchByIid.get(iid);
    if (!branch) continue;
    const existing = ctx.cache.entries[branch];
    if (!existing) continue; // lost race with refresh — skip this update

    const next: CacheEntry = {
      ...existing,
      mr,
      fetchedAt: Date.now(),
      repoName,
    };
    ctx.cache.entries[branch] = next;
    emitted[iid] = mr;
    mutated = true;
  }

  if (mutated) {
    ctx.flushCache();
    env.broadcast("mr:update", { repoName, mrs: emitted });
  }
}

// ─── Provider + group lifecycle ──────────────────────────────────────────────

function ensureProvider(env: MRSubscriptionEnv, repoName: string, repoPath: string): GitLabProvider | null {
  const cached = providers.get(repoName);
  if (cached) return cached;

  const secrets = loadSecrets();
  if (!secrets.gitlabToken) {
    env.log(`mr-subscriptions: no gitlabToken; skipping ${repoName}`);
    return null;
  }

  const remoteUrl = getRemoteUrl(repoPath);
  if (!remoteUrl) {
    env.log(`mr-subscriptions: no origin remote for ${repoName}; skipping`);
    return null;
  }

  const remote = parseRemoteUrl(remoteUrl);
  if (!remote) {
    env.log(`mr-subscriptions: could not parse remote "${remoteUrl}" for ${repoName}; skipping`);
    return null;
  }

  const provider = new GitLabProvider(remote.host, secrets.gitlabToken);
  providers.set(repoName, provider);
  return provider;
}

async function ensureUserId(env: MRSubscriptionEnv): Promise<number | null> {
  if (userIdResolved) return userId;
  // Resolve via any available provider. If none exist yet, defer until one does.
  const anyProvider = providers.values().next().value as GitLabProvider | undefined;
  if (!anyProvider) return null;

  try {
    const user = await anyProvider.validateToken();
    const numId = user.id.split(":").pop();
    userId = numId ? parseInt(numId, 10) : null;
    userIdResolved = true;
    env.log(`mr-subscriptions: resolved userId=${userId}`);
  } catch (err) {
    env.log(`mr-subscriptions: token validation failed: ${err}`);
  }
  return userId;
}

function createGroupForRepo(
  env: MRSubscriptionEnv,
  repoName: string,
  provider: GitLabProvider,
  projectPath: string,
  initialIids: number[],
  branchByIid: Map<number, string>,
): GroupState {
  const state: GroupState = {
    group:        null as unknown as DashboardGroup, // filled in next line
    branchByIid,
    iids:         new Set(initialIids),
    connection:   "connecting",
    projectPath,
    projectId:    null,
  };

  state.group = createDashboard({
    provider,
    projectPath,
    mrIid: initialIids,
    userId,
  });

  state.group.subscribe((mrs) => onGroupUpdate(env, repoName, state, mrs));

  state.group.onStatusChange((s) => {
    const prev = state.connection;
    state.connection = s.connection;
    if (prev !== s.connection) broadcastStatus(env);
  });

  return state;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function initMRSubscriptions(env: MRSubscriptionEnv): Promise<void> {
  env.log("mr-subscriptions: initializing");
  await reconcileMRSubscriptions(env);
}

export async function reconcileMRSubscriptions(env: MRSubscriptionEnv): Promise<void> {
  const { ctx } = env;
  const repoIndex = ctx.repoIndex();

  // 1. For each known repo, compute desired iid set from cache.
  for (const [repoName, repoPath] of Object.entries(repoIndex)) {
    const branchByIid = iidMapForRepo(ctx, repoName);
    const desiredIids = [...branchByIid.keys()];

    const existing = groups.get(repoName);

    if (desiredIids.length === 0) {
      // No MRs to watch — dispose the group if present.
      if (existing) {
        try { existing.group.dispose(); } catch { /* best-effort */ }
        groups.delete(repoName);
        env.log(`mr-subscriptions: disposed ${repoName} (no tracked MRs)`);
      }
      continue;
    }

    const provider = ensureProvider(env, repoName, repoPath);
    if (!provider) continue;

    // First-time resolution of userId (uses any registered provider).
    if (!userIdResolved) await ensureUserId(env);

    // Determine projectPath for this repo.
    const remoteUrl = getRemoteUrl(repoPath);
    const remote   = remoteUrl ? parseRemoteUrl(remoteUrl) : null;
    if (!remote) continue;

    if (!existing) {
      // Fresh subscription.
      const state = createGroupForRepo(env, repoName, provider, remote.projectPath, desiredIids, branchByIid);
      groups.set(repoName, state);
      env.log(`mr-subscriptions: created ${repoName} (${desiredIids.length} MRs)`);
      continue;
    }

    // Already subscribed — update iid set + branch map if it changed.
    existing.branchByIid = branchByIid;
    const nextSet = new Set(desiredIids);
    const changed = nextSet.size !== existing.iids.size
      || [...nextSet].some((iid) => !existing.iids.has(iid));
    if (changed) {
      existing.iids = nextSet;
      existing.group.updateIids(desiredIids);
      env.log(`mr-subscriptions: reconciled ${repoName} → ${desiredIids.length} MRs`);
    }
  }

  // 2. Dispose groups for repos that are no longer in the index.
  for (const repoName of [...groups.keys()]) {
    if (!repoIndex[repoName]) {
      const state = groups.get(repoName);
      try { state?.group.dispose(); } catch { /* best-effort */ }
      groups.delete(repoName);
      env.log(`mr-subscriptions: disposed ${repoName} (repo removed from index)`);
    }
  }

  broadcastStatus(env);
}

/** Lookup helper for the upcoming `mr:action` IPC handler (PR 2). */
export function getActions(repoName: string, iid: number): MRDashboardActions | null {
  const state = groups.get(repoName);
  if (!state) return null;
  if (!state.iids.has(iid)) return null;
  try {
    return state.group.actionsFor(iid);
  } catch {
    return null;
  }
}

/**
 * Cache of (projectPath, projectId) resolved for repos without a live group.
 * Lets the discussions handlers run against merged/closed MRs whose live
 * ActionCable subscription was never set up (or was disposed).
 */
const ephemeralCtx = new Map<string, { projectPath: string; projectId: number | null }>();

/**
 * Provider + project identifiers for a repo. Tries the live-group fast path
 * first; if no group exists and `repoPath` is provided, builds an ephemeral
 * `GitLabProvider` from the repo's git remote so REST-only operations
 * (discussions read/resolve/reply) keep working on MRs without a subscription.
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
  const state = groups.get(repoName);
  let provider = providers.get(repoName) ?? null;

  // Live-group fast path — but only when the caller didn't override projectPath.
  // If they did, fall through to the ephemeral path so we use the canonical path.
  if (state && provider && !projectPathOverride) {
    if (state.projectId !== null) {
      return { provider, projectPath: state.projectPath, projectId: state.projectId };
    }
    const id = await fetchProjectId(provider, state.projectPath);
    state.projectId = id;
    return { provider, projectPath: state.projectPath, projectId: id };
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

/**
 * GitLab MR webUrls always reflect the project's canonical path:
 *   https://<host>/<group>/<sub>/<project>/-/merge_requests/<iid>
 * Returns the path between the host and `/-/merge_requests/`, or null if the
 * URL doesn't match the pattern.
 */
export function projectPathFromMrWebUrl(webUrl: string | null | undefined): string | null {
  if (!webUrl) return null;
  const m = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\//.exec(webUrl);
  return m ? m[1]! : null;
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

export function getAggregatedConnection(): "connected" | "connecting" | "disconnected" {
  return aggregatedConnection();
}

/**
 * Numeric id of the authenticated GitLab user, or null if not yet resolved.
 * Used by the discussions poller so new-comment notifications can skip the
 * user's own replies.
 */
export function getCurrentUserId(): number | null {
  return userId;
}

export function disposeAllMRSubscriptions(): void {
  for (const [, state] of groups) {
    try { state.group.dispose(); } catch { /* best-effort */ }
  }
  groups.clear();
  providers.clear();
  userId = null;
  userIdResolved = false;
}
