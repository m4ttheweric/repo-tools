#!/usr/bin/env bun

/**
 * rt daemon — entry point and orchestration layer.
 *
 * Runs as a long-lived Bun process managed by launchd.
 * Listens on a Unix domain socket at ~/.rt/rt.sock (CLI/tray IPC) and on
 * 127.0.0.1:9401 (REST + WebSocket for external clients).
 *
 * Responsibilities:
 *  1. Watch .git/config for known repos → re-apply core.hooksPath if clobbered
 *  2. Proactively refresh branch/MR/Linear cache on a timer
 *  3. Serve cached data instantly to CLI commands via socket IPC
 *  4. Zero-config port discovery via lsof + CWD matching
 *
 * All subsystem logic lives in lib/daemon/ — this file only constructs the
 * units, wires them together, and owns process lifecycle (boot, signals,
 * shutdown).
 */

import { existsSync, mkdirSync, watch, writeFileSync } from "fs";
import type { Server } from "bun";

import { RT_DIR, DAEMON_PID_PATH } from "./daemon-config.ts";
import { repoDataDir } from "./rt-paths.ts";
import { getDaemonLogger, installCrashHandlers } from "./daemon-logger.ts";
import { onNotification } from "./notifier.ts";

import { StateStore }    from "./daemon/state-store.ts";
import { PortAllocator } from "./daemon/port-allocator.ts";
import { LogBuffer }     from "./daemon/log-buffer.ts";
import { AttachServer }  from "./daemon/attach-server.ts";
import { ProcessManager } from "./daemon/process-manager.ts";
import { HerdrClient } from "./daemon/herdr/client.ts";
import { PaneMap } from "./daemon/herdr/pane-map.ts";
import { HerdrProcessManager } from "./daemon/herdr-process-manager.ts";
import { SuspendManager } from "./daemon/suspend-manager.ts";
import { ProxyManager }  from "./daemon/proxy-manager.ts";
import { TunnelManager } from "./daemon/tunnel-manager.ts";
import { BounceManager } from "./daemon/bounce-manager.ts";
import { ExclusiveGroup } from "./daemon/exclusive-group.ts";
import { SystemProcessScanner } from "./daemon/system-process-scanner.ts";

import { evictStaleDaemon, reapOrphanProcesses } from "./daemon/boot-reconcile.ts";
import { collectRunnerPortLabels } from "./daemon/lane-config.ts";
import { createWiredRemedyEngine, startGlobalRemedyWatcher } from "./daemon/remedy-wiring.ts";
import { resolveUserPath } from "./daemon/user-path.ts";
import { createBranchCache } from "./daemon/branch-cache.ts";
import { createCacheRefresher } from "./daemon/cache-refresh.ts";
import { loadRepoIndex, REPOS_JSON_PATH } from "./daemon/repo-index.ts";
import { createHooksGuard } from "./daemon/hooks-guard.ts";
import { buildRoutedHandlers } from "./daemon/command-router.ts";
import { startSocketServer } from "./daemon/socket-server.ts";
import { startApiServer, broadcast } from "./daemon/api-server.ts";
import { restoreEndpointsOnBoot, wireForwardReconcile, type EndpointWiringDeps } from "./daemon/endpoint-wiring.ts";
import { startPollers } from "./daemon/pollers.ts";
import { wireProcessEvents } from "./daemon/process-events.ts";
import { portlessAvailable } from "./daemon/portless.ts";
import { restoreWatchers } from "./daemon/workspace-sync.ts";
import {
  initMRSubscriptions,
  reconcileMRSubscriptions,
  type MRSubscriptionEnv,
} from "./daemon/mr-subscriptions.ts";
import { startDiscussionsPoller } from "./daemon/discussions-poller.ts";
import { createCleanup, installSignalHandlers } from "./daemon/shutdown.ts";
import { describeRecords } from "./daemon/handlers/process.ts";
import type { HandlerContext } from "./daemon/handlers/types.ts";
import type { PortEntry } from "./port-scanner.ts";

// ─── Logging ─────────────────────────────────────────────────────────────────
// Pino-backed structured logger. See lib/daemon-logger.ts. Top-level await
// initializes the singleton before any other startup code runs, so `log` is
// always usable from sync contexts (including catch blocks).

const loggerHandle = await getDaemonLogger();
const log = loggerHandle.logger;

// ─── Daemon units (process management) ───────────────────────────────────────

const stateStore    = new StateStore();
const portAllocator = new PortAllocator();
const logBuffer     = new LogBuffer();
const attachServer  = new AttachServer({ logBuffer });

const useHerdr = process.env.RT_PROCESS_BACKEND === "herdr";
const herdrClient  = useHerdr ? new HerdrClient() : null;
const herdrPaneMap = useHerdr ? new PaneMap() : null;
const processManager: any = useHerdr
  ? new HerdrProcessManager({ client: herdrClient!, paneMap: herdrPaneMap!, stateStore })
  : new ProcessManager({ stateStore, logBuffer, attachServer });

const suspendManager = new SuspendManager({ processManager, stateStore });
const proxyManager   = new ProxyManager();
const bounceManager  = new BounceManager();
const exclusiveGroup = new ExclusiveGroup({ suspendManager, stateStore });
const systemProcessScanner = new SystemProcessScanner();
const tunnelManager  = new TunnelManager({ processManager });

// ─── Remedy engine (auto-detect errors → run fix → restart) ─────────────────

const { remedyEngine, remedyEvents } = createWiredRemedyEngine({
  processManager, stateStore, broadcast, log,
});
const stopGlobalRemedyWatcher = startGlobalRemedyWatcher({ remedyEngine, log });

// Wire circular reference: AttachServer needs ProcessManager for output subscriptions
if (!useHerdr) attachServer.setProcessManager(processManager);
// Wire SuspendManager into ProcessManager so kill() can resume warm processes
if (!useHerdr) processManager.suspendManager = suspendManager;

// Prune orphaned port allocations left by removed runner entries or crashed
// daemon restarts (labels derived from persisted runner configs).
try {
  const pruned = portAllocator.pruneToLabels(collectRunnerPortLabels());
  if (pruned > 0) log.info({ pruned }, "pruned stale port allocations");
} catch { /* best-effort; don't crash daemon startup on prune failure */ }

// Resolve the user's full PATH once at startup, and overlay it onto the
// daemon's own env so direct execSync calls outside ProcessManager (setup
// commands, agent invocations) inherit pnpm/doppler/bun without re-resolving
// the shell themselves.
{
  const resolvedPath = resolveUserPath(log);
  processManager.userPath = resolvedPath || process.env.PATH;
  if (resolvedPath) process.env.PATH = resolvedPath;
}

// ─── Shared state ────────────────────────────────────────────────────────────

const { cache, loadCache, flushCache } = createBranchCache(log);
// Port scan cache, held as a single mutable ref so handler modules can read
// fresh values without getters. The port poller mutates it in place.
const portCacheRef = { ports: [] as PortEntry[], updatedAt: 0 };
// Refresh-cycle status ref (last successful cache refresh), also mutated in
// place so status handlers read a live value.
const refreshStatusRef = { lastRefreshAt: 0 };
const startedAt = Date.now();

const hooksGuard = createHooksGuard(log);

const refreshCache = createCacheRefresher({
  log, cache, loadCache, refreshStatusRef, portCacheRef,
  repoIndex: loadRepoIndex,
  broadcast,
  statusSnapshot: () => handleCommand("tray:status", {}),
  reconcileSubscriptions: () => reconcileMRSubscriptions(mrSubEnv),
});

// ─── Handler context + command routing ───────────────────────────────────────

/** Live allowlist of a repo's running-process origins, for the bounce guard. */
function liveOriginsFor(repo: string): () => Set<string> {
  return () => {
    const origins = new Set<string>();
    for (const rec of describeRecords(handlerCtx)) {
      if (rec.repo === repo && rec.state === "running" && rec.url) {
        try { origins.add(new URL(rec.url).origin); } catch { /* skip bad url */ }
      }
    }
    return origins;
  };
}

const handlerCtx: HandlerContext = {
  processManager, stateStore, remedyEngine, suspendManager, proxyManager,
  tunnelManager,
  attachServer, logBuffer, exclusiveGroup,
  cache, refreshCache, loadCache, flushCache, remedyEvents,
  portAllocator,
  portlessAvailable: () => portlessAvailable(),
  log,
  startedAt,
  portCacheRef,
  watchedConfigs: hooksGuard.watchedConfigs,
  repoIndex: loadRepoIndex,
  checkAndRepairHooksPath: hooksGuard.checkAndRepairHooksPath,
  startWatchingRepo: hooksGuard.startWatchingRepo,
  refreshStatusRef,
  repoDataDirOf: (repo) => repoDataDir(repo),
  bounceManager,
  liveOriginsFor,
};

/** Env bundle for the MR subscription subsystem. */
const mrSubEnv: MRSubscriptionEnv = { ctx: handlerCtx, broadcast };

const routedHandlers = buildRoutedHandlers({ ctx: handlerCtx, broadcast, systemProcessScanner });

async function handleCommand(cmd: string, payload: any): Promise<any> {
  const routed = routedHandlers[cmd];
  if (routed) return routed(payload);

  switch (cmd) {
    case "shutdown":
      log.info("received shutdown command");
      // Delay cleanup so this response can be written first — cleanup()
      // force-closes all in-flight connections, including the one that
      // carried the shutdown request.
      setTimeout(() => {
        cleanup();
        loggerHandle.flush?.();
        process.exit(0);
      }, 100);
      return { ok: true, message: "shutting down" };

    default:
      return { ok: false, error: `unknown command: ${cmd}` };
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

// `Server<any>` matches the inferred type Bun.serve() returns for these
// configs (the websocket data type is unconstrained). Don't narrow further —
// it makes server.upgrade() require an explicit data arg.
const servers: { socket?: Server<any>; api?: Server<any> } = {};

const cleanup = createCleanup({
  servers, useHerdr, processManager, proxyManager, bounceManager,
  tunnelManager, attachServer, hooksGuard, stopGlobalRemedyWatcher,
  flushCache, log,
});

// ─── Entry ───────────────────────────────────────────────────────────────────

export function startDaemon(): void {
  mkdirSync(RT_DIR, { recursive: true });

  // Wire uncaughtException + unhandledRejection through pino. Must run BEFORE
  // any async work that could throw uncaught.
  installCrashHandlers(loggerHandle);

  // If a previous daemon process is still alive (orphan from a failed
  // restart), evict it before we bind the socket.
  evictStaleDaemon(log);

  log.info("daemon starting");
  writeFileSync(DAEMON_PID_PATH, String(process.pid));

  // Surface invalid state transitions so drift in VALID_TRANSITIONS shows up
  // in the daemon log instead of being silently permitted.
  stateStore.onInvalidTransition((id, prev, next) => {
    log.warn({ id, prev, next }, "stateStore: invalid transition");
  });

  if (useHerdr) {
    // Herdr backend: reconcile the pane map against live herdr panes on boot.
    processManager.reconcileOnBoot().catch((err: unknown) => {
      log.error({ err }, "herdr: reconcileOnBoot failed");
    });
  } else {
    reapOrphanProcesses(stateStore, log);
  }

  loadCache();
  log.info({ count: Object.keys(cache.entries).length }, "cache loaded from disk");

  // Socket server (Unix socket for CLI/tray) + REST/WS server (external clients)
  servers.socket = startSocketServer({ handleCommand, log });
  servers.api = startApiServer({ handleCommand, log, useHerdr, herdrPaneMap, processManager, logBuffer });

  // Wire notification broadcasts to WebSocket clients
  onNotification(broadcast);

  // Wire process state transitions to WebSocket clients as `process:changed`
  // so external consumers get live updates instead of polling process:states.
  wireProcessEvents({
    onStateChange: (cb) => stateStore.onStateChange(cb),
    pidOf: (id) => stateStore.getPid(id),
    exitCodeOf: (id) => processManager.getExitCode(id),
    broadcast,
  });

  // Discover and watch repos
  hooksGuard.refreshWatchedRepos();

  // Restore workspace sync watchers
  try {
    restoreWatchers(loadRepoIndex());
  } catch (err) {
    log.error({ err }, "workspace-sync: failed to restore watchers");
  }

  // Restore canonical endpoints (forward proxies + bounce relays) that were
  // active before this daemon restart, and lazily (re)bind forward proxies as
  // their target processes come up.
  const endpointDeps: EndpointWiringDeps = {
    stateStore, processManager, proxyManager, bounceManager,
    repoIndex: loadRepoIndex,
    repoDataDirOf: (repo) => repoDataDir(repo),
    liveOriginsFor,
    log,
  };
  restoreEndpointsOnBoot(endpointDeps);
  wireForwardReconcile(endpointDeps);

  // Watch repos.json for changes (new repos added)
  if (existsSync(REPOS_JSON_PATH)) {
    watch(REPOS_JSON_PATH, () => {
      log.info("repos.json changed; refreshing watched repos");
      hooksGuard.refreshWatchedRepos();
    });
  }

  // Periodic background work: cache refresh, port scan, system-process scan,
  // hooks-guard fallback rescan.
  startPollers({
    log, refreshCache, portCacheRef, broadcast, systemProcessScanner,
    repoIndex: loadRepoIndex,
    checkAndRepairHooksPath: hooksGuard.checkAndRepairHooksPath,
  });

  // Kick off live MR subscriptions once the first refresh has populated the
  // cache with iids + repoName stamps. reconcileMRSubscriptions inside the
  // cache refresher picks up the slack from there.
  setTimeout(() => {
    initMRSubscriptions(mrSubEnv).catch((err) => {
      log.error({ err }, "mr-subscriptions: init failed");
    });
  }, 7000);

  // Background sweep for new MR comments → `discussions:new-comments` events.
  startDiscussionsPoller({ ctx: handlerCtx, broadcast });

  // Graceful shutdown on all termination signals
  installSignalHandlers({ cleanup, flushLogs: () => loggerHandle.flush?.(), log });

  log.info({ pid: process.pid }, "daemon ready");
}

// Auto-run when executed directly (source mode: bun run lib/daemon.ts)
if (import.meta.main) {
  startDaemon();
}
