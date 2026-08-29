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
import type { HealthSnapshot } from "../health.ts";

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
  /** Computes the current health verdict (level/reasons/metrics/eventLoop) on demand; not cached, cheap enough per call. */
  getHealth:               () => HealthSnapshot;
  /** Current loop-monitor heartbeat sequence number, echoed by `ping`. */
  heartbeatSeq:            () => number;
  /** Sets the daemon logger's live level (trace/debug/info/warn/error). */
  setLogLevel:             (l: string) => void;
  /** Reads the daemon logger's current live level. */
  getLogLevel:             () => string;
}

export type Handler    = (payload: unknown, signal?: AbortSignal) => Promise<unknown>;
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

// ── Daemon-internal command surface (B2/R016) ────────────────────────────────
// Verbs with no out-of-process consumer found anywhere in this repo (no REST
// route, no rt CLI call, no tray/VS Code caller) stay off the shipped
// rt-client catalog -- that surface is meant to be exactly the cross-process
// contract, not every daemon command that happens to be reachable over the
// socket. Typed here for the same reason the shipped catalog is typed: a
// payload/data drift is a compile error for this repo's own tests, not a
// silent mismatch. settings:get/settings:list and home:snapshot* already
// carried this "not part of the catalog" posture in their own handler files
// before this map existed; hooks:status and notifications:peek join them
// here because no caller for either was found.
import type { Resolved, ListedSetting } from "../../../packages/rt-client/src/settings/resolve.ts";
import type { SnapshotResult, SnapshotStatus } from "../home-snapshot.ts";

export interface InternalCommands {
  "settings:get": { payload: { key?: string; repoIdentity?: string }; data: Resolved<unknown> };
  "settings:list": { payload: { repoIdentity?: string }; data: { settings: ListedSetting[] } };
  /** Diagnostics only, by its own doc comment (status.ts) -- never drained. */
  "notifications:peek": { payload: Record<string, never>; data: unknown[] };
  "home:snapshot": { payload: Record<string, never>; data: SnapshotResult };
  "home:snapshot-status": { payload: Record<string, never>; data: SnapshotStatus };
  "hooks:status": { payload: { repo?: string }; data: unknown };
}
export type InternalCommandName = keyof InternalCommands;
