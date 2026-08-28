/**
 * Shared context passed to every extracted handler module.
 *
 * The daemon builds one of these at startup and passes it to each handler
 * factory. Handlers close over their dependencies instead of reaching into
 * module-level state — this is what makes them unit-testable in isolation.
 */

import type { FSWatcher } from "fs";
import type { Logger } from "pino";
import type { PortEntry } from "../../port-scanner.ts";
import type { BranchCacheStore } from "../../state/index.ts";

/**
 * RT-48: `CacheEntry` used to be DECLARED here — a third copy of the same
 * shape, alongside `lib/enrich.ts`'s and the daemon's. The single owner is
 * now `lib/state/branch-cache.ts`; this is a pure re-export so the modules
 * importing the type from this path keep compiling unchanged.
 */
export type { CacheEntry } from "../../state/index.ts";

/** Repo index (name → absolute path) as loaded from ~/.mattstack/rt/repos.json. */
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
   * The process-wide branch-cache store (`lib/state/branch-cache.ts`) — its
   * `entries` map IS the daemon's in-memory read model, and the db under it
   * is the durability layer (spec "In-memory ownership"). Do not destructure
   * `entries`: handlers must read `ctx.cache.entries` each call so a
   * `reload()` performed elsewhere stays visible. Mutate through
   * `ctx.cache.put`/`delete`, which write the row and the map together —
   * there is no flush step to forget.
   */
  cache:          BranchCacheStore;
  /** Async refresh from upstream (enrich + Linear batch). Fire-and-forget safe. */
  refreshCache:   () => Promise<void>;

  // ── Extensions for hooks/status handlers ─────────────────────────────────

  /** Daemon logger; handlers write side-effect logs through this. */
  log:            Logger;
  /** Unix-ms timestamp of daemon startup; read once by status handlers. */
  startedAt:      number;
  /** Flavor/version/sourceRev, computed once at boot (sourceRev needs a subprocess in dev flavor) — never recomputed per call. */
  identity:       { flavor: "dev" | "prod"; version: string; sourceRev: string | null; startedAt: number };
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
  /** Holder for the last cache-refresh cycle's outcome (0s = never run). */
  refreshStatusRef:        { lastRefreshAt: number; lastSuccessAt: number; failedRepos: number; enrichErrors: number };
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
