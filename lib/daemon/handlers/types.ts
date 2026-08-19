/**
 * Shared context passed to every extracted handler module.
 *
 * The daemon builds one of these at startup and passes it to each handler
 * factory. Handlers close over their dependencies instead of reaching into
 * module-level state — this is what makes them unit-testable in isolation.
 */

import type { FSWatcher } from "fs";
import type { Logger } from "pino";
import type { Discussion } from "@mattstack/glance";
import type { PortEntry } from "../../port-scanner.ts";

/** Daemon-local cache entry shape (mirrors the inline definition in daemon.ts). */
export interface CacheEntry {
  ticket:    any;
  linearId:  string;
  mr:        any;
  fetchedAt: number;
  /**
   * Repo this entry belongs to (from ~/.rt/repos.json). Optional for
   * backward compat with older on-disk caches — populated on next
   * refreshAllMRs pass.
   */
  repoName?: string;
  /**
   * Legacy field, no longer written since the discussions lift — snapshots
   * now live in ~/.rt/discussions.json (see discussions-file-store.ts). Kept
   * only so the one-time seed can read old caches; die by attrition.
   */
  discussions?: Discussion[];
  /**
   * Legacy field, no longer written since the discussions lift — snapshots
   * now live in ~/.rt/discussions.json (see discussions-file-store.ts). Kept
   * only so the one-time seed can read old caches; die by attrition.
   */
  discussionsFetchedAt?: number;
}

/** Repo index (name → absolute path) as loaded from ~/.rt/repos.json. */
export interface RepoIndex {
  [repoName: string]: string;
}

/**
 * Live ref to the daemon's port-scan cache. Mutated in-place by refreshPortCache
 * so handlers can read fresh values without getters.
 */
export interface PortCacheRef {
  ports:     PortEntry[];
  updatedAt: number;
}

export interface HandlerContext {
  /**
   * Live cache object. Do not destructure `entries` — handlers must read
   * `ctx.cache.entries` each call so disk reloads are visible.
   */
  cache:          { entries: Record<string, CacheEntry> };
  /** Async refresh from upstream (enrich + Linear batch). Fire-and-forget safe. */
  refreshCache:   () => Promise<void>;
  /** Reload cache.entries in-place from disk; used after enrichBranches writes. */
  loadCache:      () => void;
  /** Persist cache.entries to disk. Handlers call this after mutating in-memory entries. */
  flushCache:     () => void;

  // ── Extensions for hooks/status/workspace handlers ──────────────────────────

  /** Daemon logger; handlers write side-effect logs through this. */
  log:            Logger;
  /** Unix-ms timestamp of daemon startup; read once by status handlers. */
  startedAt:      number;
  /**
   * Live ref to the port scan cache. Do not destructure — handlers read
   * ctx.portCacheRef.ports / .updatedAt each call to see fresh values.
   */
  portCacheRef:   PortCacheRef;
  /** Live map of repo git-config watchers (configPath → FSWatcher). */
  watchedConfigs: Map<string, FSWatcher>;
  /** Read-through fn for the repo index; cheap so we don't cache. */
  repoIndex:      () => RepoIndex;
  /** Re-apply rt hooks shim dir if clobbered; returns true if a repair happened. */
  checkAndRepairHooksPath: (repoName: string, repoPath: string) => Promise<boolean>;
  /** Start a directory watch over a repo's .git/config and run an initial check. */
  startWatchingRepo:       (repoName: string, repoPath: string) => void;
  /** Holder for the last cache-refresh timestamp (0 = never). */
  refreshStatusRef:        { lastRefreshAt: number };
}

export type Handler    = (payload: any, signal?: AbortSignal) => Promise<any>;
export type HandlerMap = Record<string, Handler>;

// ── Typed command surface (MAT-31) ───────────────────────────────────────────
// The shared rt-client catalog is the contract external consumers compile
// against, so the handlers behind it carry the catalog's payload and
// response types instead of `any`. Renaming a command, drifting a payload
// field, or changing a data shape in commands.ts without touching the
// handler is a tsc error here, not a runtime `ok: false` in a consumer.
// Daemon-internal commands (cache, hooks, status, ...) have no external
// contract and stay on the loose Handler type.

import type { Commands, CommandName } from "../../../packages/rt-client/src/commands.ts";

/** The daemon's reply envelope for one cataloged command. */
export type CommandResult<K extends CommandName> =
  | { ok: true; data: Commands[K]["data"] }
  | { ok: false; error: string };

export type TypedHandlers = {
  [K in CommandName]: (payload: Commands[K]["payload"]) => Promise<CommandResult<K>>;
};
