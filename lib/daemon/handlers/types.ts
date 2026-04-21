/**
 * Shared context passed to every extracted handler module.
 *
 * The daemon builds one of these at startup and passes it to each handler
 * factory. Handlers close over their dependencies instead of reaching into
 * module-level state — this is what makes them unit-testable in isolation.
 */

import type { FSWatcher } from "fs";
import type { ProcessManager } from "../process-manager.ts";
import type { StateStore } from "../state-store.ts";
import type { RemedyEngine } from "../remedy-engine.ts";
import type { SuspendManager } from "../suspend-manager.ts";
import type { ProxyManager } from "../proxy-manager.ts";
import type { AttachServer } from "../attach-server.ts";
import type { LogBuffer } from "../log-buffer.ts";
import type { ExclusiveGroup } from "../exclusive-group.ts";
import type { PortAllocator } from "../port-allocator.ts";
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
}

/** Ring-buffer event pushed whenever a remedy fires; drained by UI polling. */
export interface RemedyEvent {
  id:      string;
  name:    string;
  success: boolean;
  firedAt: number;
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
  processManager: ProcessManager;
  stateStore:     StateStore;
  remedyEngine:   RemedyEngine;
  suspendManager: SuspendManager;
  proxyManager:   ProxyManager;
  attachServer:   AttachServer;
  logBuffer:      LogBuffer;
  exclusiveGroup: ExclusiveGroup;
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
  /** Live ring buffer of remedy events; drained by remedy:drain. */
  remedyEvents:   RemedyEvent[];

  // ── Extensions for hooks/status/ports/groups/workspace handlers ────────────

  /** Ephemeral port allocator for daemon-managed processes. */
  portAllocator:  PortAllocator;
  /** Daemon logger; handlers write side-effect logs through this. */
  log:            (msg: string) => void;
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
  checkAndRepairHooksPath: (repoName: string, repoPath: string) => boolean;
  /** Start a directory watch over a repo's .git/config and run an initial check. */
  startWatchingRepo:       (repoName: string, repoPath: string) => void;
  /** Holder for the last cache-refresh timestamp (0 = never). */
  refreshStatusRef:        { lastRefreshAt: number };
}

export type Handler    = (payload: any) => Promise<any>;
export type HandlerMap = Record<string, Handler>;
