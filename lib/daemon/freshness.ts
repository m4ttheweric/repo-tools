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
 * This module is also the daemon's shared GitLab plumbing (successor to the
 * deleted mr-subscriptions.ts): per-repo provider registry, current-user id,
 * and the aggregated connection state broadcast as `mr:status`.
 *
 * Lifecycle:
 *   initFreshness(env)      — daemon startup, after first cache refresh
 *   reconcileFreshness(env) — tail of every refreshCache(); follows repo index
 *   disposeFreshness()      — daemon shutdown
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { GitLabProvider, type EventCursor } from "@workforge/glance-sdk";
import { RT_DIR } from "../daemon-config.ts";
import { loadSecrets } from "../linear.ts";
import { parseRemoteUrl, isGitLabRemote } from "../enrich.ts";
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
  pending:      import("@workforge/glance-sdk").InvalidationKey[];
  gapFillTimer: ReturnType<typeof setTimeout> | null;
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
