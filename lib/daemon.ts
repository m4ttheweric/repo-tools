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
import { homedir } from "os";
import { join } from "path";
import type { Server } from "bun";

import { RT_DIR, DAEMON_PID_PATH } from "./daemon-config.ts";
import { resolveIntendedMode } from "./dev-mode.ts";
import { getDaemonLogger, installCrashHandlers, redirectNativeStderr } from "./daemon-logger.ts";
import { onNotification } from "./notifier.ts";
import { appBundleRoot } from "./bundle-layout.ts";
import { reconcile as reconcileLinks } from "./deps/links.ts";
import { createRealProbes } from "./setup/probes.ts";

import { SystemProcessScanner } from "./daemon/system-process-scanner.ts";

import { parkUntilIntended, probeSocketHolder, daemonFlavor } from "./daemon/park.ts";
import { evictStaleDaemon } from "./daemon/boot-reconcile.ts";
import { resolveUserPath } from "./daemon/user-path.ts";
// Every state.db API is reached through the lib/state barrel, never through
// ./state/db.ts directly: importing the barrel is what guarantees every
// store module has registered its legacy-JSON importer before the one-shot
// v0->v1 migration runs (see lib/state/index.ts).
import { clearAllArmed, getBranchCacheStore, getStateDb, persistOrWarn, prunePresence, type BranchCacheStore } from "./state/index.ts";
import { createCacheRefresher } from "./daemon/cache-refresh.ts";
import { createWorktreeReconciler } from "./daemon/worktree-reconciler.ts";
import { loadRepoIndex } from "./daemon/repo-index.ts";
import { primeTeamTrackingIdentityMap } from "./repo-tracking.ts";
import { createHooksGuard } from "./daemon/hooks-guard.ts";
import { runBootIdentityMigration } from "./daemon/boot-migrate.ts";
import { runCapture } from "./subprocess.ts";
import { buildRoutedHandlers } from "./daemon/command-router.ts";
import { startSocketServer } from "./daemon/socket-server.ts";
import { startApiServer, broadcast } from "./daemon/api-server.ts";
import { loadCronConfig, startCron } from "./daemon/cron.ts";
import { startPollers } from "./daemon/pollers.ts";
import { startHomeSnapshot } from "./daemon/home-snapshot.ts";
import { startAgentStatusPoller } from "./daemon/agent-status-poller.ts";
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

// Capture native panics (bypass JS entirely) at the fd level before anything
// else in this module runs, so a throw during any later module-scope
// construction (createEventsBus, cron, home-snapshot, …) lands in
// daemon-stderr.log instead of vanishing down whatever fd 2 the launcher gave
// us. Depends only on logsDir() and mkdirs its own dir; no logger needed yet.
redirectNativeStderr();

// Gates installCrashHandlers' unhandledRejection handler: fatal during boot
// (no socket/API bound yet, nothing to recover), advisory-only once ready.
let bootPhase: "booting" | "ready" = "booting";

const rtMigration = migrateLegacyRtDir();

// ─── Logging ─────────────────────────────────────────────────────────────────
// Pino-backed structured logger. See lib/daemon-logger.ts. Top-level await
// initializes the singleton before any other startup code runs, so `log` is
// always usable from sync contexts (including catch blocks).

const loggerHandle = await getDaemonLogger();
const log = loggerHandle.logger;

// Wire uncaughtException + unhandledRejection through pino as early as the
// logger allows: every module-scope side effect below this point
// (createEventsBus, cron, home-snapshot, sweep timers) can throw, and this
// must run BEFORE any of it does.
installCrashHandlers(loggerHandle, { booting: () => bootPhase === "booting" });

if (rtMigration === "migrated") {
  log.info(`migrated legacy ${LEGACY_RT_LABEL} state to ${RT_DIR_LABEL}`);
} else if (rtMigration === "conflict") {
  log.warn(
    `rt state is split between ${LEGACY_RT_LABEL} and ${RT_DIR_LABEL} — the daemon reads only ` +
    `${RT_DIR_LABEL}; merge the legacy ${LEGACY_RT_LABEL} directory into it by hand, then delete it`,
  );
}

// Flavor gate — MUST stay above every subsystem below: module scope arms
// cron, the home-snapshot auto-committer, and sweep intervals, and
// startDaemon() SIGTERMs the shared rt.pid. A wrong-flavor daemon that got
// past this line would kill the serving daemon and double-commit the home
// repo. Both entry paths (cli.ts `rt --daemon` and the shim's
// `bun run lib/daemon.ts`) converge here.
await parkUntilIntended({
  myFlavor: daemonFlavor(),
  resolveIntent: resolveIntendedMode,
  probeHolder: probeSocketHolder,
  sleep: (ms) => Bun.sleep(ms),
  log,
});

// ─── Daemon units ────────────────────────────────────────────────────────────

const systemProcessScanner = new SystemProcessScanner();

// Resolve the user's full PATH once at startup and overlay it onto the daemon's
// own env. Under launchd the inherited PATH is /usr/bin:/bin:/usr/sbin:/sbin, so
// without this nothing the daemon spawns can find node, pnpm, doppler or bun.
// runCapture forwards process.env explicitly (lib/subprocess.ts) because
// Bun.spawn would otherwise ignore this assignment.
{
  const resolvedPath = resolveUserPath(log);
  if (resolvedPath) process.env.PATH = resolvedPath;
}

// The launchd agent plist's EnvironmentVariables.PATH is the static
// /usr/bin:/bin:/usr/sbin:/sbin — it never sees the bundle rt actually runs
// from. Deriving the bundle dir from our own execPath and prepending it (and
// ~/.local/bin, where tagged links live) fixes only children spawned with
// `env: process.env` — mutating process.env.PATH does not affect Bun.spawn's
// OWN executable resolution, which resolved at process start.
{
  // Call-time HOME (mirrors rt-paths.ts's own home()), not a module-load
  // constant — this file's PATH resolution above already follows the same
  // discipline every sibling module in this repo does.
  const home = (): string => process.env.HOME ?? homedir();
  const root = appBundleRoot();
  const prefix = [root ? join(root, "Contents", "Helpers") : null, join(home(), ".local", "bin")].filter(
    (p): p is string => p !== null,
  );
  process.env.PATH = [...prefix, process.env.PATH].filter(Boolean).join(":");
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

// Injected at compile time via `bun build --define RT_VERSION='"v1.x.x"'` (see cli.ts) —
// undefined when running from source, which is also how daemonFlavor() tells dev from prod.
declare const RT_VERSION: string | undefined;
// Only a dev daemon runs from a real checkout, so only dev can shell out for the commit
// it's serving from; a prod binary has no working tree to ask.
const sourceRev = daemonFlavor() === "dev"
  ? await runCapture(["git", "rev-parse", "--short", "HEAD"], { cwd: import.meta.dir, timeoutMs: 5_000 })
      .then((r) => r.stdout.trim() || null)
      .catch(() => null)
  : null;
const identity = {
  flavor: daemonFlavor(),
  version: typeof RT_VERSION !== "undefined" ? RT_VERSION : "source",
  sourceRev,
  startedAt,
} as const;

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

// Herdr agent-status transitions write no run event, so the mirror on run
// summaries needs its own change detector. Same bus frame shape as
// command-router's emitEvent.
const agentStatusPoller = startAgentStatusPoller({
  emitEvent: (topic, payload) => {
    const emittedAt = Date.now();
    const id = eventsBus.emitAt(topic, payload, emittedAt);
    emit("event", { id, topic, payload, emittedAt });
  },
  log: loggerHandle.childLogger("agent-status"),
});

// ─── Handler context + command routing ───────────────────────────────────────

const handlerCtx: HandlerContext = {
  cache, refreshCache,
  log,
  startedAt,
  identity,
  portCacheRef,
  watchedConfigs: hooksGuard.watchedConfigs,
  repoIndex: loadRepoIndex,
  checkAndRepairHooksPath: hooksGuard.checkAndRepairHooksPath,
  startWatchingRepo: hooksGuard.startWatchingRepo,
  refreshStatusRef,
};

/** Env bundle for the live-freshness subsystem. */
const freshnessEnv: FreshnessEnv = { ctx: handlerCtx, broadcast: emit };

// Assigned in startDaemon(), after openBranchCacheStore() — chat handlers
// need state.db open, and module scope must not touch it (same rule as the
// branch-cache facade above).
let routedHandlers: ReturnType<typeof buildRoutedHandlers> | undefined;

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
  const routed = routedHandlers?.[cmd];
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
  agentStatusPoller.stop();
  cleanupCore();
};

// ─── Entry ───────────────────────────────────────────────────────────────────

async function runDaemon(): Promise<void> {
  try {
    mkdirSync(RT_DIR, { recursive: true });

    // If a previous daemon process is still alive (orphan from a failed
    // restart), evict it before we bind the socket.
    evictStaleDaemon(log);

    // Auto-unlink any tagged tool link whose tool now has a genuine user copy
    // elsewhere on PATH (e.g. the user ran `brew install gh` after rt linked
    // the bundled one). reconcile() itself is synchronous (a ~/.local/bin
    // readDir plus a handful of stats) — wrapping the call in `async` alone
    // would NOT defer it, since nothing inside actually awaits. setTimeout(0)
    // is what actually pushes it past the rest of this function: the PID
    // write, openBranchCacheStore, and both server binds below all run first,
    // on this same synchronous pass, before the timer callback ever fires.
    setTimeout(() => {
      try {
        const { removed } = reconcileLinks(createRealProbes());
        if (removed.length > 0) log.info({ removed }, "deps: auto-unlinked tools now shadowed by a user copy");
      } catch (err) {
        log.warn({ err }, "deps: link reconcile failed");
      }
    }, 0);

    log.info("daemon starting");

    // Open state.db and build the in-memory branch-cache map BEFORE serving
    // (spec "Migration & contention"): the one long transaction is the
    // legacy-JSON import, and it must never land inside the event loop. If a
    // CLI process is mid-import right now, we block here, in startup.
    openBranchCacheStore();
    log.info({ count: Object.keys(cache.entries).length }, "branch cache loaded from state.db");

    // one-shot re-key of every legacy NAME-keyed store row onto its
    // serialized repo identity. Fire-and-forget (not awaited) like the PATH
    // reconcile above — the ordering guarantee this depends on (running before
    // anything prunes the repo index) only needs this to be on the boot path,
    // not blocking the socket bind; a prune only ever arrives as a command sent
    // to an already-running daemon.
    runBootIdentityMigration(log).catch((err) => {
      log.warn({ err }, "boot identity migration failed");
    });

    routedHandlers = buildRoutedHandlers({
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
      repos: {
        withReconcilerHeld: worktreeReconciler.withReconcilerHeld,
        refreshWatchedRepos: hooksGuard.refreshWatchedRepos,
      },
      stateDb: getStateDb("daemon"),
    });

    // No waiter outlives the daemon, so every armed_at set at boot is stale;
    // clearing must finish before the socket listens, or an agent that arms
    // in the gap has its fresh armed_at wiped.
    const clearedArmed = clearAllArmed();
    if (clearedArmed > 0) log.info({ clearedArmed }, "chat: cleared stale armed_at from previous daemon run");

    // Daemon startup is one of the two moments a handle is about to be
    // needed (spec "Pruning"); sign-in is the other, inside signIn itself.
    // Pruning is best-effort cleanup, so a concurrent CLI writer's
    // SQLITE_BUSY must not abort startup before the socket binds.
    let prunedPresence = 0;
    persistOrWarn("daemon", () => { prunedPresence = prunePresence(Date.now()); }, { op: "prunePresence" });
    if (prunedPresence > 0) log.info({ prunedPresence }, "chat: pruned stale presence rows at daemon startup");

    // Socket server (Unix socket for CLI/tray) + REST/WS server (external clients)
    servers.socket = startSocketServer({ handleCommand, log });
    servers.api = await startApiServer({ handleCommand, log });

    // Only write rt.pid once both servers are actually bound — a boot that
    // fails before this point must never leave a live-pid file with no
    // socket/API behind it.
    writeFileSync(DAEMON_PID_PATH, String(process.pid));

    // Wire notification broadcasts to WebSocket clients
    onNotification(emit);

    // Discover and watch repos
    hooksGuard.refreshWatchedRepos();

    // Team tracking intent (mattstack.tracking) resolves through a primed
    // identity→name map, not live derivation — loadRepoTracking is sync and
    // runs on every freshness tick. Team intent is inert until this completes.
    // The repo index moved into state.db (RT-50): there is no file to fs.watch
    // for new-repo changes any more, so the 60s hooks-scan poller (pollers.ts)
    // is the only re-prime mechanism now, not just the reliable one.
    primeTeamTrackingIdentityMap(loadRepoIndex()).catch((err) => {
      log.warn({ err }, "repo-tracking: failed to prime team-intent identity map");
    });

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

    bootPhase = "ready";
    log.info({ pid: process.pid }, "daemon ready");
  } catch (err) {
    log.fatal({ err }, "daemon boot failed");
    // Task 9 adds recordBootFailure(currentPhase, err) here.
    try { loggerHandle.flush?.(); } catch { /* */ }
    process.exit(1);
  }
}

// runDaemon() never rejects — it logs fatal and exit(1)s internally on any
// boot failure, so this wrapper needs no catch of its own.
export async function startDaemon(): Promise<void> {
  await runDaemon();
}

// Auto-run when executed directly (source mode: bun run lib/daemon.ts)
if (import.meta.main) {
  startDaemon();
}
