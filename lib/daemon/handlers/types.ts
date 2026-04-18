/**
 * Shared context passed to every extracted handler module.
 *
 * The daemon builds one of these at startup and passes it to each handler
 * factory. Handlers close over their dependencies instead of reaching into
 * module-level state — this is what makes them unit-testable in isolation.
 */

import type { ProcessManager } from "../process-manager.ts";
import type { StateStore } from "../state-store.ts";
import type { RemedyEngine } from "../remedy-engine.ts";
import type { SuspendManager } from "../suspend-manager.ts";
import type { ProxyManager } from "../proxy-manager.ts";
import type { AttachServer } from "../attach-server.ts";
import type { LogBuffer } from "../log-buffer.ts";
import type { ExclusiveGroup } from "../exclusive-group.ts";

/** Daemon-local cache entry shape (mirrors the inline definition in daemon.ts). */
export interface CacheEntry {
  ticket:    any;
  linearId:  string;
  mr:        any;
  fetchedAt: number;
}

/** Ring-buffer event pushed whenever a remedy fires; drained by UI polling. */
export interface RemedyEvent {
  id:      string;
  name:    string;
  success: boolean;
  firedAt: number;
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
  /** Live ring buffer of remedy events; drained by remedy:drain. */
  remedyEvents:   RemedyEvent[];
}

export type Handler    = (payload: any) => Promise<any>;
export type HandlerMap = Record<string, Handler>;
