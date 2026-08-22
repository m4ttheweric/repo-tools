#!/usr/bin/env bun

/**
 * rt daemon — entry point and orchestration layer.
 *
 * Runs as a long-lived Bun process managed by launchd.
 * Listens on a Unix domain socket at ~/.mattstack/rt/rt.sock (CLI/tray IPC) and on
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
import { join } from "path";
import type { Server } from "bun";

import { RT_DIR, DAEMON_PID_PATH } from "./daemon-config.ts";
import { getDaemonLogger, installCrashHandlers, redirectNativeStderr } from "./daemon-logger.ts";
import { onNotification } from "./notifier.ts";

import { SystemProcessScanner } from "./daemon/system-process-scanner.ts";

import { evictStaleDaemon } from "./daemon/boot-reconcile.ts";
import { resolveUserPath } from "./daemon/user-path.ts";
// Every state.db API is reached through the lib/state barrel, never through
// ./state/db.ts directly: importing the barrel is what guarantees every
// store module has registered its legacy-JSON importer before the one-shot
// v0->v1 migration runs (see lib/state/index.ts).
import { getBranchCacheStore, getStateDb, type BranchCacheStore } from "./state/index.ts";
import { createCacheRefresher } from "./daemon/cache-refresh.ts";
import { createWorktreeReconciler } from "./daemon/worktree-reconciler.ts";
import { loadRepoIndex, REPOS_JSON_PATH } from "./daemon/repo-index.ts";
import { primeTeamTrackingIdentityMap } from "./repo-tracking.ts";
import { createHooksGuard } from "./daemon/hooks-guard.ts";
import { buildRoutedHandlers } from "./daemon/command-router.ts";
import { startSocketServer } from "./daemon/socket-server.ts";
import { startApiServer, broadcast } from "./daemon/api-server.ts";
import { loadCronConfig, startCron } from "./daemon/cron.ts";
import { startPollers } from "./daemon/pollers.ts";
import { startHomeSnapshot } from "./daemon/home-snapshot.ts";
import {
  initFreshness,
  reconcileFreshness,
  type FreshnessEnv,
} from "./daemon/freshness.ts";
import { startDiscussionsPoller } from "./daemon/discussions-poller.ts";
import { createCleanup, installSignalHandlers } from "./daemon/shutdown.ts";
import { createEventsBus } from "./daemon/events-bus.ts";
import { pruneRuns } from "./runs/prune.ts";
import { pruneLogs } from "./log-janitor.ts";
import { getSetting } from "./settings/resolve.ts";
import { releaseEndpointsForWorktree } from "./daemon/handlers/endpoint.ts";
import type { HandlerContext } from "./daemon/handlers/types.ts";
import type { PortEntry } from "./port-scanner.ts";

// ─── Legacy state migration (RT-46) ──────────────────────────────────────────
// Must run BEFORE the logger's first write can create the new rt dir and turn
// a clean rename of a real legacy tree into a conflict. Idempotent — the CLI
// entry (cli.ts) also runs it, but `bun run lib/daemon.ts` skips cli.ts.
import { migrateLegacyRtDir, LEGACY_RT_LABEL, RT_DIR_LABEL, logsDir } from "./rt-paths.ts";
const rtMigration = migrateLegacyRtDir();

// ─── Logging ─────────────────────────────────────────────────────────────────
// Pino-backed structured logger. See lib/daemon-logger.ts. Top-level await
// initializes the singleton before any other startup code runs, so `log` is
// always usable from sync contexts (including catch blocks).

const loggerHandle = await getDaemonLogger();
const log = loggerHandle.logger;

if (rtMigration === "migrated") {
  log.info(`migrated legacy ${LEGACY_RT_LABEL} state to ${RT_DIR_LABEL}`);
} else if (rtMigration === "conflict") {
  log.warn(
    `rt state is split between ${LEGACY_RT_LABEL} and ${RT_DIR_LABEL} — the daemon reads only ` +
    `${RT_DIR_LABEL}; merge the legacy ${LEGACY_RT_LABEL} directory into it by hand, then delete it`,
  );
}

// ─── Daemon units ────────────────────────────────────────────────────────────

const systemProcessScanner = new SystemProcessScanner();

// Resolve the user's full PATH once at startup, and overlay it onto the
// daemon's own env so direct execSync calls (setup commands, agent
// invocations) inherit pnpm/doppler/bun without re-resolving the shell
// themselves.
{
  const resolvedPath = resolveUserPath(log);
  if (resolvedPath) process.env.PATH = resolvedPath;
}

// ─── Shared state ────────────────────────────────────────────────────────────

// The branch-cache store, opened LAZILY on purpose. Module scope must not
// touch state.db (spec "The database": no module-load db access); the daemon
// opens it in startDaemon(), before it serves anything. Everything below is
// wired at module scope, so it gets this façade: same BranchCacheStore
// surface, resolved on first use. `entries` is a getter, never a captured
// value, so it always yields the store's own live map object.
let branchCacheStore: BranchCacheStore | null = null;
function openBranchCacheStore(): BranchCacheStore {
  if (!branchCacheStore) branchCacheStore = getBranchCacheStore(getStateDb("daemon"));
  return branchCacheStore;
}
const cache: BranchCacheStore = {
  get entries() { return openBranchCacheStore().entries; },
  put:    (branch, entry)      => openBranchCacheStore().put(branch, entry),
  delete: (branch)             => openBranchCacheStore().delete(branch),
  reload: ()                   => openBranchCacheStore().reload(),
  gc:     (repos, maxAgeMs)    => openBranchCacheStore().gc(repos, maxAgeMs),
};
// Port scan cache, held as a single mutable ref so handler modules can read
// fresh values without getters. The port poller mutates it in place.
const portCacheRef = { ports: [] as PortEntry[], updatedAt: 0 };
// Refresh-cycle status ref (last successful cache refresh), also mutated in
// place so status handlers read a live value.
const refreshStatusRef = { lastRefreshAt: 0 };
const startedAt = Date.now();

const hooksGuard = createHooksGuard(log);

// Pane-communication events bus (RT-44): SQLite journal + in-memory waiters.
const eventsBus = createEventsBus({ dbPath: join(RT_DIR, "events.db"), log });
// Hourly retention sweep — cheap; rides its own interval rather than pollers
// because it needs no poller deps.
setInterval(() => eventsBus.sweep(), 60 * 60 * 1000);
// Boot-time sweep to handle frequent daemon restarts that would otherwise starve the hourly interval.
setTimeout(() => eventsBus.sweep(), 30_000);

// Age-floor prune of pipeline run dirs — daily; assertPrunable in prune.ts
// guards every deletion against the runs root.
setInterval(() => {
  try {
    const { removed } = pruneRuns();
    if (removed.length > 0) log.info({ removed: removed.length }, "pruned old pipeline runs");
  } catch (err) {
    log.warn({ err }, "runs prune failed");
  }
}, 24 * 60 * 60 * 1000);
// Boot-time prune to handle frequent daemon restarts that would otherwise starve the daily interval.
setTimeout(() => {
  try {
    const { removed } = pruneRuns();
    if (removed.length > 0) log.info({ removed: removed.length }, "pruned old pipeline runs");
  } catch (err) {
    log.warn({ err }, "runs prune failed");
  }
}, 60_000);

// Age-floor prune of every surface's rotated log files — daily; generalizes
// cli-logger.ts's own age sweep (which stays as-is for the cli surface) to
// every surface, since pino-roll's limit.count is a FILE floor, not a day
// floor. rt.logRetentionDays is read fresh each sweep (no caching) so a
// mid-run settings change takes effect on the next tick.
function logRetentionDays(): number {
  try {
    const v = getSetting<unknown>("rt.logRetentionDays").value;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 14;
  } catch {
    return 14;
  }
}
setInterval(() => {
  try {
    const { removed } = pruneLogs(logsDir(), logRetentionDays(), Date.now());
    if (removed.length > 0) log.info({ removed: removed.length }, "pruned old surface logs");
  } catch (err) {
    log.warn({ err }, "log prune failed");
  }
}, 24 * 60 * 60 * 1000);
// Boot-time sweep to handle frequent daemon restarts that would otherwise starve the daily interval.
setTimeout(() => {
  try {
    const { removed } = pruneLogs(logsDir(), logRetentionDays(), Date.now());
    if (removed.length > 0) log.info({ removed: removed.length }, "pruned old surface logs");
  } catch (err) {
    log.warn({ err }, "log prune failed");
  }
}, 60_000);

// Cron trigger layer (mechanism-only, MAT-161): sees every broadcast frame.
const cron = startCron(loadCronConfig(log), { log });
const emit: typeof broadcast = (type, data) => {
  broadcast(type, data);
  cron.onBroadcast(type, data);
  if (type === "worktree:disposed") {
    const d = data as { repo?: string; path?: string };
    if (d?.repo && d?.path) releaseEndpointsForWorktree({ log }, d.repo, d.path);
  }
};

// Worktree lifecycle reconciler: reconcile → merge reactor → freshen →
// replenish/shrink. Kicked detached off the tail of every cache refresh
// (see `worktreeKick` below), plus its own periodic pass isn't needed since
// the refresh timer already provides one.
const worktreeReconciler = createWorktreeReconciler({
  cache,
  repoIndex: loadRepoIndex,
  // `emit` (not bare `broadcast`), deliberately: reconciler events (e.g.
  // "worktree:freshened") should also reach the cron trigger layer, same as
  // every other broadcast frame.
  emit,
  log,
});

const refreshCache = createCacheRefresher({
  log, cache, refreshStatusRef, portCacheRef,
  repoIndex: loadRepoIndex,
  broadcast: emit,
  statusSnapshot: () => handleCommand("tray:status", {}),
  reconcileSubscriptions: () => reconcileFreshness(freshnessEnv),
  worktreeKick: worktreeReconciler.kick,
});

// Home-repo snapshot daemon (H2): watches ~/.mattstack/user, auto-commits
// everything outside a claimed zone, janitor-commits a zone left dirty past
// its threshold. Construction both builds and arms it (real defaults for
// everything but log/broadcast) — inert on its own if rt.homeSnapshot is
// disabled or ~/.mattstack/user isn't a git repo yet.
const homeSnapshot = startHomeSnapshot({
  log: loggerHandle.childLogger("home-snapshot"),
  broadcast: emit,
});

// ─── Handler context + command routing ───────────────────────────────────────

const handlerCtx: HandlerContext = {
  cache, refreshCache,
  log,
  startedAt,
  portCacheRef,
  watchedConfigs: hooksGuard.watchedConfigs,
  repoIndex: loadRepoIndex,
  checkAndRepairHooksPath: hooksGuard.checkAndRepairHooksPath,
  startWatchingRepo: hooksGuard.startWatchingRepo,
  refreshStatusRef,
};

/** Env bundle for the live-freshness subsystem. */
const freshnessEnv: FreshnessEnv = { ctx: handlerCtx, broadcast: emit };

const routedHandlers = buildRoutedHandlers({
  ctx: handlerCtx,
  broadcast: emit,
  systemProcessScanner,
  worktree: {
    emit,
    kick: worktreeReconciler.kick,
    creationInFlight: worktreeReconciler.creationInFlight,
  },
  eventsBus,
  homeSnapshot,
});

async function handleCommand(cmd: string, payload: any, signal?: AbortSignal): Promise<any> {
  const t0 = Date.now();
  try {
    const result = await routeCommand(cmd, payload, signal);
    if (result && result.ok === false) {
      log.warn({ cmd, error: result.error, durationMs: Date.now() - t0 }, "command rejected");
    } else {
      log.debug({ cmd, durationMs: Date.now() - t0 }, "command handled");
    }
    return result;
  } catch (err) {
    log.error({ err, cmd, durationMs: Date.now() - t0 }, "command failed");
    throw err;
  }
}

async function routeCommand(cmd: string, payload: any, signal?: AbortSignal): Promise<any> {
  const routed = routedHandlers[cmd];
  if (routed) return routed(payload, signal);

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

const cleanupCore = createCleanup({ servers, hooksGuard, log });
const cleanup = (): void => {
  cron.dispose();
  eventsBus.close();
  homeSnapshot.stop();
  cleanupCore();
};

// ─── Entry ───────────────────────────────────────────────────────────────────

export function startDaemon(): void {
  mkdirSync(RT_DIR, { recursive: true });

  // Capture native panics (bypass JS entirely) at the fd level, then wire
  // uncaughtException + unhandledRejection through pino. Must run BEFORE
  // any async work that could throw uncaught.
  redirectNativeStderr();
  installCrashHandlers(loggerHandle);

  // If a previous daemon process is still alive (orphan from a failed
  // restart), evict it before we bind the socket.
  evictStaleDaemon(log);

  log.info("daemon starting");
  writeFileSync(DAEMON_PID_PATH, String(process.pid));

  // Open state.db and build the in-memory branch-cache map BEFORE serving
  // (spec "Migration & contention"): the one long transaction is the
  // legacy-JSON import, and it must never land inside the event loop. If a
  // CLI process is mid-import right now, we block here, in startup.
  openBranchCacheStore();
  log.info({ count: Object.keys(cache.entries).length }, "branch cache loaded from state.db");

  // Socket server (Unix socket for CLI/tray) + REST/WS server (external clients)
  servers.socket = startSocketServer({ handleCommand, log });
  servers.api = startApiServer({ handleCommand, log });

  // Wire notification broadcasts to WebSocket clients
  onNotification(emit);

  // Discover and watch repos
  hooksGuard.refreshWatchedRepos();

  // Team tracking intent (mattstack.tracking) resolves through a primed
  // identity→name map, not live derivation — loadRepoTracking is sync and
  // runs on every freshness tick. Team intent is inert until this completes.
  // The RELIABLE re-prime is the 60s hooks-scan poller (pollers.ts); the
  // repos.json watch below is best-effort only — see its own comment.
  primeTeamTrackingIdentityMap(loadRepoIndex()).catch((err) => {
    log.warn({ err }, "repo-tracking: failed to prime team-intent identity map");
  });

  // Watch repos.json for changes (new repos added). Best-effort: repos.json
  // is typically rewritten via an atomic rename, which changes the file's
  // inode, and fs.watch on most platforms stops delivering events after
  // that — this fires once, maybe, and the 60s poller is what actually
  // keeps the team-tracking identity map current.
  if (existsSync(REPOS_JSON_PATH)) {
    watch(REPOS_JSON_PATH, () => {
      log.info("repos.json changed; refreshing watched repos");
      hooksGuard.refreshWatchedRepos();
      primeTeamTrackingIdentityMap(loadRepoIndex()).catch((err) => {
        log.warn({ err }, "repo-tracking: failed to re-prime team-intent identity map");
      });
    });
  }

  // Periodic background work: cache refresh, port scan, system-process scan,
  // hooks-guard fallback rescan.
  startPollers({
    log, refreshCache, portCacheRef, broadcast: emit, systemProcessScanner,
    repoIndex: loadRepoIndex,
    checkAndRepairHooksPath: hooksGuard.checkAndRepairHooksPath,
  });

  // Kick off the events watchers once the first refresh has populated the
  // cache with repoName stamps. reconcileFreshness inside the cache refresher
  // follows repo-index changes from there.
  setTimeout(() => {
    initFreshness(freshnessEnv).catch((err) => {
      log.error({ err }, "freshness: init failed");
    });
  }, 7000);

  // Background sweep for new MR comments → `discussions:new-comments` events.
  startDiscussionsPoller({ ctx: handlerCtx, broadcast: emit });

  // Sandbox ground-truth reconcile: port-forwards, dev-ports mirroring, and
  // typed-event → notification fan-out (no-op while no controller answers).

  // Graceful shutdown on all termination signals
  installSignalHandlers({ cleanup, flushLogs: () => loggerHandle.flush?.(), log });

  log.info({ pid: process.pid }, "daemon ready");
}

// Auto-run when executed directly (source mode: bun run lib/daemon.ts)
if (import.meta.main) {
  startDaemon();
}
