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
 * Structure: `buildUnits(ctx)` assembles the ordered `DaemonUnit[]` that IS
 * the boot order (spec §5.1). Each unit's `start()` both constructs and arms
 * its subsystem and writes any shared handle onto the `BootContext`; `stop()`
 * runs in reverse. Nothing arms at import; only the `import.meta.main` call
 * to `startDaemon()` at the bottom does. The 12-entry order and reverse-stop
 * teardown are covered by `__tests__/boot-order.test.ts`.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Server } from "bun";
import type { Logger } from "pino";
import type { Database } from "bun:sqlite";

import { RT_DIR, DAEMON_PID_PATH } from "./daemon-config.ts";
import { resolveIntendedMode } from "./dev-mode.ts";
import {
  getDaemonLogger,
  installCrashHandlers,
  redirectNativeStderr,
  type DaemonLoggerHandle,
} from "./daemon-logger.ts";
import { onNotification } from "./notifier.ts";
import { appBundleRoot } from "./bundle-layout.ts";
import { reconcile as reconcileLinks } from "./deps/links.ts";
import { createRealProbes } from "./setup/probes.ts";

import { SystemProcessScanner } from "./daemon/system-process-scanner.ts";

import { parkUntilIntended, probeSocketHolder, daemonFlavor } from "./daemon/park.ts";
import { evictStaleDaemon } from "./daemon/boot-reconcile.ts";
import { resolveUserPath } from "./daemon/user-path.ts";
import { shortReqId, makeSuppressor } from "./daemon/command-attribution.ts";
import { unknownCommandReply } from "./daemon/unknown-command.ts";
// Every state.db API is reached through the lib/state barrel, never through
// ./state/db.ts directly: importing the barrel is what guarantees every
// store module has registered its legacy-JSON importer before the one-shot
// v0->v1 migration runs (see lib/state/index.ts).
import { getBranchCacheStore, getStateDb, closeStateDb, persistOrWarn, prunePresence, pruneMessages, pruneAgents, snapshotRegistryDeps, quickCheck, backupTo, stampedBackupPath, pruneStateBackups, setBusyLogSink, enqueueNotification, type BranchCacheStore } from "./state/index.ts";
import { createCacheRefresher } from "./daemon/cache-refresh.ts";
import { createWorktreeReconciler } from "./daemon/worktree-reconciler.ts";
import { loadRepoIndex } from "./daemon/repo-index.ts";
import { primeTeamTrackingIdentityMap } from "./repo-tracking.ts";
import { createHooksGuard } from "./daemon/hooks-guard.ts";
import { runBootIdentityMigration } from "./daemon/boot-migrate.ts";
import { runCapture } from "./subprocess.ts";
import { buildRoutedHandlers } from "./daemon/command-router.ts";
import { createChatDeliverySweep } from "./daemon/handlers/chat.ts";
import { startSocketServer } from "./daemon/socket-server.ts";
import { startApiServer, withApiPortParkRetry, broadcast, apiWsClientCount, clearWsClients } from "./daemon/api-server.ts";
import { deriveFailure } from "./daemon/failure.ts";
import { loadCronConfig, startCron } from "./daemon/cron.ts";
import { startPollers } from "./daemon/pollers.ts";
import { startHomeSnapshot } from "./daemon/home-snapshot.ts";
import { startAgentStatusPoller } from "./daemon/agent-status-poller.ts";
import { startNotifyBridge, type EventBridgeRule } from "./notify-bridge.ts";
import { herdrRequest } from "./herdr/client.ts";
import type { HerdrSnapshot } from "./daemon/handlers/pane.ts";
import {
  initFreshness,
  reconcileFreshness,
  disposeFreshness,
  getFreshnessSnapshot,
  type FreshnessEnv,
} from "./daemon/freshness.ts";
import { startLoopMonitor } from "./daemon/loop-monitor.ts";
import { createHealthSampler } from "./daemon/health-sampler.ts";
import { writeHeartbeat } from "./daemon/heartbeat-file.ts";
import { computeHealth } from "./daemon/health.ts";
import { isCrashLooping, readSupervisionState } from "./daemon/supervision-state.ts";
import { setSettingsWarnSink } from "./settings/resolve.ts";
import { createDiscussionsPoller } from "./daemon/discussions-poller.ts";
import { installSignalHandlers, removeRuntimeFiles } from "./daemon/shutdown.ts";
import { createEventsBus, type EventsBus } from "./daemon/events-bus.ts";
import {
  writeBreadcrumb,
  recordBootAttempt,
  recordDaemonReady,
  recordBootFailure,
  recordCleanExit,
  type BootPhase,
} from "./daemon/supervision-state.ts";
import { safeInterval, safeTimeout, scheduleSweep } from "./daemon/safe-timers.ts";
import { BOOT_DELAY_MS as CD_CACHE_BOOT_DELAY_MS, REFRESH_MS as CD_CACHE_REFRESH_MS, refreshCdCache } from "./daemon/cd-cache-refresh.ts";
import { pruneRuns } from "./runs/prune.ts";
import { pruneLogs } from "./log-janitor.ts";
import { getSetting } from "./settings/resolve.ts";
import { releaseEndpointsForWorktree } from "./daemon/handlers/endpoint.ts";
import type { HandlerContext } from "./daemon/handlers/types.ts";
import type { PortEntry } from "./port-scanner.ts";
import { runUnits, stopUnits, type DaemonUnit } from "./daemon/lifecycle.ts";

// Legacy state migration (RT-46). Must run BEFORE the logger's first write can
// create the new rt dir and turn a clean rename of a real legacy tree into a
// conflict, so it is the first thing unit 1 does, above redirectNativeStderr.
// Idempotent: the CLI entry (cli.ts) also runs it, but `bun run lib/daemon.ts`
// skips cli.ts.
import { migrateLegacyRtDir, migrateLegacyPluginsDir, LEGACY_RT_LABEL, RT_DIR_LABEL, logsDir } from "./rt-paths.ts";

type HandleCommand = (cmd: string, payload: any, signal?: AbortSignal) => Promise<any>;

export interface HandleCommandDeps {
  routeCommand: (cmd: string, payload: any, signal?: AbortSignal) => Promise<any>;
  /** Read as `ctx.log` on every call (not captured once), so this stays
   *  correct across the boot-time swap from the bootstrap logger to the real
   *  one (unit 1 reassigns `ctx.log` after `buildUnits` has already wired
   *  this closure). */
  ctx: { log: Logger };
  rejectSuppressor: ReturnType<typeof makeSuppressor>;
  redactDigest: (payload: any) => Record<string, unknown>;
  currentCmd: { cmd: string | null };
  slowCommandMs?: number;
}

/**
 * Wraps `routeCommand` with request-id stamping, reject/slow-command logging,
 * and a handler-throw safety net (R035): a thrown error becomes an additive
 * `{ ok: false, error, failure: { code, message } }` envelope instead of
 * propagating to the transport as an uncaught exception. `error` stays the
 * plain string every rt-client wrapper already displays; `failure` is the
 * new structured key, filled from the same throw.
 */
export function createHandleCommand(deps: HandleCommandDeps): HandleCommand {
  const { routeCommand, ctx, rejectSuppressor, redactDigest, currentCmd } = deps;
  const slowCommandMs = deps.slowCommandMs ?? 2000;
  return async (cmd, payload, signal) => {
    const t0 = Date.now();
    const reqId = shortReqId();
    const caller = payload && typeof payload._client === "string" ? payload._client : "unknown";
    currentCmd.cmd = cmd;
    try {
      const result = await routeCommand(cmd, payload, signal);
      const durationMs = Date.now() - t0;
      if (result && result.ok === false) {
        const key = `${cmd}|${result.error ?? ""}`;
        const { emit: shouldEmit, suppressed } = rejectSuppressor.check(key, Date.now());
        if (shouldEmit) {
          ctx.log.warn(
            { reqId, cmd, caller, error: result.error, durationMs, digest: redactDigest(payload), ...(suppressed ? { suppressed } : {}) },
            "command rejected",
          );
        }
        return { ...result, reqId };
      }
      if (durationMs > slowCommandMs) {
        ctx.log.info({ reqId, cmd, caller, durationMs }, "command handled (slow)");
      } else {
        ctx.log.debug({ reqId, cmd, caller, durationMs }, "command handled");
      }
      return result;
    } catch (err) {
      ctx.log.error({ err, reqId, cmd, caller, durationMs: Date.now() - t0, digest: redactDigest(payload) }, "command failed");
      const { code, message } = deriveFailure(err);
      return { ok: false, error: message, failure: { code, message }, reqId };
    } finally {
      currentCmd.cmd = null;
    }
  };
}

/**
 * The out-of-process / process-global operations a unit performs, injected so
 * the in-process boot test can supply fakes (servers, pid, crash/signal
 * handlers) without binding sockets or mutating the test runner's process.
 * Production supplies `realSeams()`.
 */
export interface BootSeams {
  redirectNativeStderr: () => void;
  /** Flavor/park gate; seamed so the boot test isn't subject to ambient dev-mode intent (which would park a source build indefinitely). */
  parkGate: (log: Logger) => Promise<void>;
  /** Login-shell PATH scrape (spawns shells); seamed so the boot test stays hermetic. */
  resolveUserPath: (log: Logger) => Promise<string>;
  installCrashHandlers: (handle: DaemonLoggerHandle, opts: { booting?: () => boolean }) => void;
  installSignalHandlers: (opts: {
    cleanup: () => void | Promise<void>;
    flushLogs: () => void;
    log: Logger;
    wasVerbShutdown: () => boolean;
  }) => void;
  bindApiServer: (handleCommand: HandleCommand, log: Logger) => Promise<Server<any>>;
  bindSocketServer: (handleCommand: HandleCommand, log: Logger) => Server<any>;
  writePid: (pid: number) => void;
  closeStateDb: () => void;
}

/**
 * Mutable state shared across units and read by `startDaemon`'s fatal-boot
 * handler. Units fill in the handles later units (or the test) consume by
 * name here rather than through a module singleton.
 */
export interface BootContext {
  seams: BootSeams;
  servers: { socket?: Server<any>; api?: Server<any> };
  log: Logger;
  loggerHandle?: DaemonLoggerHandle;
  stateDb?: Database;
  units: DaemonUnit[];
  bootPhase: "booting" | "ready";
  currentPhase: BootPhase;
  /** Optional ordered-event recorder for the boot-order test; unused in production. */
  spy?: string[];
}

function realSeams(): BootSeams {
  return {
    redirectNativeStderr,
    parkGate: (log) =>
      parkUntilIntended({
        myFlavor: daemonFlavor(),
        resolveIntent: resolveIntendedMode,
        probeHolder: probeSocketHolder,
        sleep: (ms) => Bun.sleep(ms),
        log,
      }),
    resolveUserPath,
    installCrashHandlers,
    installSignalHandlers,
    bindApiServer: (handleCommand, log) =>
      withApiPortParkRetry(() => startApiServer({ handleCommand, log }), { sleep: (ms) => Bun.sleep(ms), log }),
    bindSocketServer: (handleCommand, log) => startSocketServer({ handleCommand, log }),
    writePid: (pid) => writeFileSync(DAEMON_PID_PATH, String(pid)),
    closeStateDb,
  };
}

/** A stand-in logger used only until unit 1 installs the real one on the ctx. */
function bootstrapLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, level: "info" } as unknown as Logger;
}

export function makeBootContext(seamOverrides: Partial<BootSeams> = {}): BootContext {
  return {
    seams: { ...realSeams(), ...seamOverrides },
    servers: {},
    log: bootstrapLogger(),
    bootPhase: "booting",
    currentPhase: "start",
    units: [],
  };
}

/**
 * Builds the ordered `DaemonUnit[]`: the single source of truth for boot
 * order (spec §5.1). Every subsystem the daemon used to arm at module scope
 * is constructed inside the `start()` of its unit; shared handles are held in
 * this function's closure and mirrored onto `ctx` where the test or the
 * fatal-boot handler needs them.
 */
export function buildUnits(ctx: BootContext): DaemonUnit[] {
  const { seams } = ctx;

  // ─── Shared handles (assigned as units start; read by later units) ─────────
  let loggerHandle: DaemonLoggerHandle;
  let log: Logger = ctx.log;
  let eventsBus: EventsBus;
  let identity: {
    flavor: "dev" | "prod";
    version: string;
    sourceRev: string | null;
    startedAt: number;
  };
  let hooksGuard: ReturnType<typeof createHooksGuard>;
  let cron: ReturnType<typeof startCron>;
  let worktreeReconciler: ReturnType<typeof createWorktreeReconciler>;
  let refreshCache: () => Promise<void>;
  let homeSnapshot: ReturnType<typeof startHomeSnapshot>;
  let agentStatusPoller: ReturnType<typeof startAgentStatusPoller>;
  let notifyBridgeStop: (() => void) | undefined;
  let healthSampler: ReturnType<typeof createHealthSampler>;
  let healthInterval: ReturnType<typeof setInterval> | null = null;
  let loopMon: ReturnType<typeof startLoopMonitor>;
  let handlerCtx: HandlerContext;
  let freshnessEnv: FreshnessEnv;
  let routedHandlers: ReturnType<typeof buildRoutedHandlers> | undefined;
  let pollersHandle: ReturnType<typeof startPollers> | null = null;
  let discussionsPoller: ReturnType<typeof createDiscussionsPoller> | null = null;
  let freshnessInitTimer: ReturnType<typeof setTimeout> | null = null;

  const sweepHandles: Array<{ stop(): void }> = [];
  // Shared with buildRoutedHandlers (phase 7) below, so the delivery sweep
  // (phase 6) and a normal chat:post/chat:dm push serialize through the
  // same per-(room,handle) chain instead of racing each other.
  const chatDeliveryChains = new Map<string, Promise<void>>();

  // ─── Plain, non-arming shared refs ─────────────────────────────────────────
  const systemProcessScanner = new SystemProcessScanner();

  // The branch-cache store, opened LAZILY: everything below is wired before the
  // state.db unit opens it, so it gets this façade: same BranchCacheStore
  // surface, resolved on first use. `entries` is a getter, never a captured
  // value, so it always yields the store's own live map object.
  let branchCacheStore: BranchCacheStore | null = null;
  const openBranchCacheStore = (): BranchCacheStore => {
    if (!branchCacheStore) branchCacheStore = getBranchCacheStore(getStateDb("daemon"));
    return branchCacheStore;
  };
  const cache: BranchCacheStore = {
    get entries() { return openBranchCacheStore().entries; },
    put:    (branch, entry)      => openBranchCacheStore().put(branch, entry),
    delete: (branch)             => openBranchCacheStore().delete(branch),
    reload: ()                   => openBranchCacheStore().reload(),
    gc:     (repos, maxAgeMs)    => openBranchCacheStore().gc(repos, maxAgeMs),
  };
  // Port scan cache, held as a single mutable ref so handler modules read fresh
  // values without getters; the port poller mutates it in place.
  const portCacheRef = { ports: [] as PortEntry[], updatedAt: 0 };
  // Refresh-cycle status ref (last cycle's outcome), also mutated in place.
  const refreshStatusRef = { lastRefreshAt: 0, lastSuccessAt: 0, failedRepos: 0, enrichErrors: 0 };
  const startedAt = Date.now();
  // In-flight command name, polled by the loop monitor to spot a handler that
  // never returns. Captured by the monitor's `currentCmd` closure.
  const currentCmd: { cmd: string | null } = { cmd: null };

  const rejectSuppressor = makeSuppressor(60_000);
  const SLOW_COMMAND_MS = 2000;

  // Set by the `shutdown` verb before it exits, so a bare OS signal arriving
  // mid-teardown is still distinguishable from the intentional stop.
  let shuttingDownViaVerb = false;

  // Reverse-order teardown; the shutdown verb and the signal handlers both
  // route through this.
  let units: DaemonUnit[] = [];
  const stopAll = (): Promise<void> => stopUnits(units, log);

  // Tracks the finer-grained boot phase for the breadcrumb file and for
  // attributing a fatal boot error to the phase it happened in. Db-free
  // (writeBreadcrumb only writes a file).
  const setPhase = (phase: BootPhase): void => {
    ctx.currentPhase = phase;
    writeBreadcrumb(phase);
  };

  // Injected at compile time via `bun build --define RT_VERSION=...` (see
  // cli.ts): undefined when running from source, which is also how
  // daemonFlavor() tells dev from prod.
  const rtVersion = (): string => (typeof RT_VERSION !== "undefined" ? RT_VERSION : "source");

  // ─── Serving-core closures (defined once, invoked once units are wired) ────

  // Both fan-out reactions (cron, worktree:disposed) fire off eventsBus.fanOut,
  // keyed on the real (type, data) pair (not a wrapped "event" frame), so the
  // cron trigger match and the type check see exactly what they did as inline
  // branches. fanOut does NOT persist (only command-router's emitEvent path
  // writes rows), so emit() still writes zero rows to events.db.
  const emit: typeof broadcast = (type, data) => {
    broadcast(type, data);
    eventsBus.fanOut(type, data);
  };

  /** Loggable, secret-free summary of a command payload: top-level key names
   *  plus a whitelist of identifying fields safe to echo into logs. */
  const redactDigest = (payload: any): Record<string, unknown> => {
    if (!payload || typeof payload !== "object") return {};
    const keys = Object.keys(payload);
    const pick = (k: string): Record<string, unknown> => (payload[k] !== undefined ? { [k]: payload[k] } : {});
    return { keys, ...pick("repo"), ...pick("repoName"), ...pick("branch"), ...pick("iid"), ...pick("room") };
  };

  const routeCommand = async (cmd: string, payload: any, signal?: AbortSignal): Promise<any> => {
    const routed = routedHandlers?.[cmd];
    if (routed) return routed(payload, signal);

    switch (cmd) {
      case "shutdown":
        log.info("received shutdown command");
        // Set before the delay, not inside the callback: a bare SIGTERM in the
        // 100ms window must see this flag already true, or the signal handler
        // treats an intentional stop as a crash (exit 1, launchd respawns).
        shuttingDownViaVerb = true;
        // Delay teardown so this response is written first, then stopUnits
        // force-closes all in-flight connections, including the one that
        // carried the shutdown request.
        setTimeout(() => {
          void (async () => {
            recordCleanExit("shutdown", 0);
            await stopAll();
            loggerHandle.flush?.();
            process.exit(0);
          })();
        }, 100);
        return { ok: true, message: "shutting down" };

      default:
        return unknownCommandReply(cmd, rtVersion());
    }
  };

  const handleCommand: HandleCommand = createHandleCommand({
    routeCommand,
    ctx,
    rejectSuppressor,
    redactDigest,
    currentCmd,
    slowCommandMs: SLOW_COMMAND_MS,
  });

  /** Not cached: computeHealth is pure/cheap and every input is a live ref or a
   *  fast getter, so recomputing per call keeps the snapshot honest without a
   *  staleness window. */
  const buildHealthSnapshot = () => {
    const now = Date.now();
    const sup = readSupervisionState();
    const failuresLastHour = sup.recentFailures.filter((f) => f.at > now - 60 * 60_000).length;
    return computeHealth({
      now,
      uptimeMs: now - startedAt,
      mem: process.memoryUsage(),
      rssBaseline: healthSampler.rssBaseline(),
      wsClients: apiWsClientCount(),
      watchers: hooksGuard.watchedConfigs.size,
      freshness: getFreshnessSnapshot(),
      refresh: {
        lastSuccessAt: refreshStatusRef.lastSuccessAt,
        failedRepos: refreshStatusRef.failedRepos,
        enrichErrors: refreshStatusRef.enrichErrors,
      },
      refreshIntervalMs: 5 * 60_000,
      eventLoop: { ...loopMon.stats },
      supervisionFailuresLastHour: failuresLastHour,
      crashLooping: isCrashLooping(sup, now),
      loggerDegraded: loggerHandle.loggerDegraded?.() ?? false,
      recoveredErrorRateLastWindow: loggerHandle.recoveredErrorCount?.() ?? 0,
      freeBytes: healthSampler.freeBytes(),
    });
  };

  const logRetentionDays = (): number => {
    try {
      const v = getSetting<unknown>("rt.logRetentionDays").value;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 14;
    } catch {
      return 14;
    }
  };

  // ─── The ordered unit list ─────────────────────────────────────────────────

  units = [
    // 1: stderr redirect + logger + crash handlers, first so any later throw
    // is captured; depends on nothing but paths.
    {
      name: "logger",
      async start() {
        const rtMigration = migrateLegacyRtDir();
        const pluginsMigration = migrateLegacyPluginsDir();
        seams.redirectNativeStderr();
        loggerHandle = await getDaemonLogger();
        log = loggerHandle.logger;
        ctx.loggerHandle = loggerHandle;
        ctx.log = log;
        // R052: route lib/state/busy.ts's busy-write warn/error lines onto
        // this process's own daemon surface, via the same childLogger a
        // handler's ctx.log would use — not the module's own dynamic
        // getDaemonLogger() default, which a CLI process sharing this code
        // would also fall into.
        setBusyLogSink({
          warn: (module, context, message) => loggerHandle!.childLogger(module).warn(context, message),
          error: (module, context, message) => loggerHandle!.childLogger(module).error(context, message),
        });
        // Route the settings resolver's dedup'd warn sink into structured
        // logging so a hot-path getSetting on a disallowed-scope key surfaces
        // once here instead of the resolver's console fallback.
        setSettingsWarnSink((m) => log.warn({ src: "settings" }, m));
        seams.installCrashHandlers(loggerHandle, { booting: () => ctx.bootPhase === "booting" });
        setPhase("start");
        if (pluginsMigration === "migrated") log.info("moved user plugins from rt/plugins to user/plugins");
        else if (pluginsMigration === "conflict") log.warn("plugins exist in both rt/plugins (retired) and user/plugins; only user/plugins is read");
        if (rtMigration === "migrated") {
          log.info(`migrated legacy ${LEGACY_RT_LABEL} state to ${RT_DIR_LABEL}`);
        } else if (rtMigration === "conflict") {
          log.warn(
            `rt state is split between ${LEGACY_RT_LABEL} and ${RT_DIR_LABEL}: the daemon reads only ` +
            `${RT_DIR_LABEL}; merge the legacy ${LEGACY_RT_LABEL} directory into it by hand, then delete it`,
          );
        }
      },
      stop() {},
    },

    // 2: flavor/park gate. MUST precede every subsystem that arms: below it
    // arm cron, the home-snapshot auto-committer and sweeps, and shutdown
    // SIGTERMs the shared rt.pid: a wrong-flavor daemon past this line would
    // kill the serving daemon and double-commit the home repo.
    {
      name: "park-gate",
      async start() {
        await seams.parkGate(log);
      },
      stop() {},
    },

    // 3: PATH resolution, before any unit that spawns git or herdr. Phase 6
    // made resolveUserPath async; this unit awaits it.
    {
      name: "path-resolution",
      async start() {
        // The user's full PATH overlaid onto the daemon's env: under launchd
        // the inherited PATH is /usr/bin:/bin:/usr/sbin:/sbin, so without this
        // nothing the daemon spawns can find node, pnpm, doppler or bun.
        // runCapture forwards process.env explicitly (Bun.spawn ignores this
        // assignment for its OWN executable resolution, which resolved at start).
        const resolvedPath = await seams.resolveUserPath(log);
        if (resolvedPath) process.env.PATH = resolvedPath;
        // Prepend the bundle's Helpers dir and ~/.local/bin (where tagged links
        // live). Call-time HOME (mirrors rt-paths.ts's own home()), not a
        // module-load constant.
        const home = (): string => process.env.HOME ?? homedir();
        const root = appBundleRoot();
        const prefix = [root ? join(root, "Contents", "Helpers") : null, join(home(), ".local", "bin")].filter(
          (p): p is string => p !== null,
        );
        process.env.PATH = [...prefix, process.env.PATH].filter(Boolean).join(":");
      },
      stop() {},
    },

    // 4: events.db (createEventsBus, with the quarantine guard).
    {
      name: "events-db",
      start() {
        // events-bus mkdirs its own dir; do RT_DIR too so the pid write and
        // state.db open below never race a missing parent.
        mkdirSync(RT_DIR, { recursive: true });
        eventsBus = createEventsBus({ dbPath: join(RT_DIR, "events.db"), log });
        setPhase("events-db");
      },
      stop() {
        eventsBus.close();
      },
    },

    // 5: state.db (open + migrate) before serving, per the state.db spec's
    // contention rule. The one long transaction is the legacy-JSON import; it
    // must never land inside the event loop, so a mid-import CLI blocks here.
    {
      name: "state-db",
      start() {
        setPhase("state-db");
        openBranchCacheStore();
        ctx.stateDb = getStateDb("daemon");
        recordBootAttempt();
        log.info({ count: Object.keys(cache.entries).length }, "branch cache loaded from state.db");
        // Integrity check, not a boot gate (R055): a state.db that fails
        // quick_check should be loud, not fatal -- the daemon still has a
        // repo-index-backed cache path and rt state restore is the recovery,
        // not a crash loop.
        const problems = quickCheck(ctx.stateDb);
        if (problems.length > 0) log.warn({ problems }, "state.db failed PRAGMA quick_check");
        // One-shot re-key of every legacy NAME-keyed store row onto its
        // serialized repo identity. Fire-and-forget: it must be on the boot
        // path (before anything prunes the repo index) but not block the
        // socket bind: a prune only arrives as a command to a running daemon.
        runBootIdentityMigration(log).catch((err) => {
          log.warn({ err }, "boot identity migration failed");
        });
        // Best-effort presence prune at startup; a concurrent CLI writer's
        // SQLITE_BUSY must not abort startup before the socket binds.
        let prunedPresence = 0;
        persistOrWarn("daemon", () => { prunedPresence = prunePresence(Date.now(), getStateDb("daemon"), snapshotRegistryDeps()); }, { op: "prunePresence" });
        if (prunedPresence > 0) log.info({ prunedPresence }, "chat: pruned stale presence rows at daemon startup");
      },
      stop() {
        seams.closeStateDb();
      },
    },

    // 6: background subsystems: hooks guard, cron, reconciler, home-snapshot,
    // agent-status poller, health sampler, loop monitor, and the sweep units.
    {
      name: "background-subsystems",
      async start() {
        // Daemon self-description. Only a dev daemon runs from a real checkout,
        // so only dev can shell out for the commit it serves from.
        const sourceRev = daemonFlavor() === "dev"
          ? await runCapture(["git", "rev-parse", "--short", "HEAD"], { cwd: import.meta.dir, timeoutMs: 5_000 })
              .then((r) => r.stdout.trim() || null)
              .catch(() => null)
          : null;
        identity = { flavor: daemonFlavor(), version: rtVersion(), sourceRev, startedAt };

        hooksGuard = createHooksGuard(log);

        // Periodic sweeps (events retention, run prune, log prune): each gets a
        // boot-time fire plus its recurring interval via scheduleSweep, and its
        // stop handle joins the reverse-stop below.
        sweepHandles.push(scheduleSweep(
          "events-sweep",
          () => { eventsBus.sweep(); },
          { bootDelayMs: 30_000, intervalMs: 60 * 60 * 1000 },
          log,
        ));
        sweepHandles.push(scheduleSweep(
          "runs-prune",
          () => {
            const { removed } = pruneRuns();
            if (removed.length > 0) log.info({ removed: removed.length }, "pruned old pipeline runs");
          },
          { bootDelayMs: 60_000, intervalMs: 24 * 60 * 60 * 1000 },
          log,
        ));
        // rt.logRetentionDays is read fresh each sweep so a mid-run settings
        // change takes effect on the next tick.
        sweepHandles.push(scheduleSweep(
          "logs-prune",
          () => {
            const { removed } = pruneLogs(logsDir(), logRetentionDays(), Date.now(),
              (phase, err, file) => log.warn({ err, phase, file }, "log prune step failed"));
            if (removed.length > 0) log.info({ removed: removed.length }, "pruned old surface logs");
          },
          { bootDelayMs: 60_000, intervalMs: 24 * 60 * 60 * 1000 },
          log,
        ));
        sweepHandles.push(scheduleSweep(
          "chat-prune",
          () => {
            const { removed } = pruneMessages(getStateDb("daemon"));
            if (removed > 0) log.info({ removed }, "pruned old chat messages");
          },
          { bootDelayMs: 60_000, intervalMs: 24 * 60 * 60 * 1000 },
          log,
        ));
        sweepHandles.push(scheduleSweep(
          "agents-prune",
          () => {
            const { removed } = pruneAgents(getStateDb("daemon"));
            if (removed > 0) log.info({ removed }, "pruned old agent records");
          },
          { bootDelayMs: 60_000, intervalMs: 24 * 60 * 60 * 1000 },
          log,
        ));
        sweepHandles.push(scheduleSweep(
          "state-backup",
          () => {
            backupTo(getStateDb("daemon"), stampedBackupPath());
            const { removed } = pruneStateBackups();
            if (removed.length > 0) log.info({ removed: removed.length }, "pruned old state.db backups");
          },
          { bootDelayMs: 60_000, intervalMs: 24 * 60 * 60 * 1000 },
          log,
        ));
        // Catches a chat delivery that neither deliverPost's own retry nor a
        // later post to the same recipient recovered -- the case a 2-party
        // DM at a wait-point can hit, since neither side sends again.
        const chatDeliverySweep = createChatDeliverySweep({
          db: getStateDb("daemon"),
          deliveryChains: chatDeliveryChains,
          log: loggerHandle.childLogger("chat"),
        });
        sweepHandles.push(scheduleSweep(
          "chat-delivery-sweep",
          async () => { await chatDeliverySweep(); },
          { bootDelayMs: 30_000, intervalMs: 30_000 },
          log,
        ));
        // Keeps cd-cache.json warm for `rt cd`; uses the async repo-index
        // builder, never execSync, since this runs on the daemon thread.
        sweepHandles.push(scheduleSweep(
          "cd-cache-refresh",
          () => refreshCdCache(loggerHandle.childLogger("cd-cache")),
          { bootDelayMs: CD_CACHE_BOOT_DELAY_MS, intervalMs: CD_CACHE_REFRESH_MS },
          log,
        ));

        // Cron trigger layer (mechanism-only): sees every broadcast frame.
        cron = startCron(loadCronConfig(log), { log });
        eventsBus.onBroadcast((type, data) => cron.onBroadcast(type, data));
        eventsBus.onBroadcast((type, data) => {
          if (type !== "worktree:disposed") return;
          const d = data as { repo?: string; path?: string };
          if (d?.repo && d?.path) releaseEndpointsForWorktree({ log }, d.repo, d.path);
        });

        // Worktree lifecycle reconciler. Kicked detached off the tail of every
        // cache refresh; `emit` (not bare broadcast) so reconciler events also
        // reach the cron trigger layer.
        worktreeReconciler = createWorktreeReconciler({
          cache,
          repoIndex: loadRepoIndex,
          emit,
          log,
        });

        refreshCache = createCacheRefresher({
          log, cache, refreshStatusRef, portCacheRef,
          repoIndex: loadRepoIndex,
          broadcast: emit,
          statusSnapshot: () => handleCommand("tray:status", {}),
          reconcileSubscriptions: () => reconcileFreshness(freshnessEnv),
          worktreeKick: worktreeReconciler.kick,
        });

        // Home-repo snapshot daemon: watches ~/.mattstack/user, auto-commits
        // outside a claimed zone. Construction builds and arms it; inert on its
        // own if rt.homeSnapshot is disabled or ~/.mattstack/user isn't a repo.
        homeSnapshot = startHomeSnapshot({
          log: loggerHandle.childLogger("home-snapshot"),
          broadcast: emit,
        });

        // Herdr agent-status transitions write no run event, so the mirror on
        // run summaries needs its own change detector.
        agentStatusPoller = startAgentStatusPoller({
          emitEvent: (topic, payload) => {
            const emittedAt = Date.now();
            const id = eventsBus.emitAt(topic, payload, emittedAt);
            emit("event", { id, topic, payload, emittedAt });
          },
          log: loggerHandle.childLogger("agent-status"),
        });

        // Settings-driven notifier event bridge: turns a matching
        // events-bus broadcast into a queued desktop notification,
        // suppressed when the event's paneId is the currently focused
        // herdr pane. rules() re-reads rt.notify.eventBridges per event so
        // a settings edit takes effect live, without a daemon restart.
        const notifyBridgeLog = loggerHandle.childLogger("notify-bridge");
        notifyBridgeStop = startNotifyBridge({
          onBroadcast: eventsBus.onBroadcast,
          rules: (): EventBridgeRule[] => {
            let raw: unknown;
            try {
              raw = getSetting<unknown>("rt.notify.eventBridges").value;
            } catch (err) {
              notifyBridgeLog.warn({ err }, "rt.notify.eventBridges: getSetting threw");
              return [];
            }
            if (raw === undefined) return [];
            if (!Array.isArray(raw)) {
              notifyBridgeLog.warn({ raw }, "rt.notify.eventBridges must be an array; ignoring");
              return [];
            }
            const rules: EventBridgeRule[] = [];
            for (const entry of raw) {
              const e = entry as Partial<EventBridgeRule> | null;
              if (
                e && typeof e === "object" &&
                typeof e.pattern === "string" && typeof e.category === "string" &&
                typeof e.title === "string" && typeof e.message === "string"
              ) {
                rules.push({ pattern: e.pattern, category: e.category, title: e.title, message: e.message });
              } else {
                notifyBridgeLog.warn({ entry }, "rt.notify.eventBridges: skipping invalid rule entry");
              }
            }
            return rules;
          },
          enqueue: enqueueNotification,
          paneFocused: async (paneId: string): Promise<boolean> => {
            try {
              const snap = await herdrRequest<{ snapshot: HerdrSnapshot }>("session.snapshot", {});
              if (!snap.ok) return false;
              const pane = snap.result.snapshot.panes.find((p) => p.pane_id === paneId);
              return pane?.focused === true;
            } catch {
              return false;
            }
          },
          log: notifyBridgeLog,
        });

        // 5-min metrics log + the two cached signals health needs.
        healthSampler = createHealthSampler({
          log,
          rtDir: RT_DIR,
          wsClients: apiWsClientCount,
          watchers: () => hooksGuard.watchedConfigs.size,
          startedAt,
        });
        healthSampler.sample(); // seed baseline/free now, don't wait 5min
        healthInterval = safeInterval(() => healthSampler.sample(), 5 * 60_000, "health-sample", log);

        // 250ms event-loop drift monitor; also writes the cross-process
        // liveness heartbeat file every ~2s. Both timers unref'd and db-free.
        loopMon = startLoopMonitor({
          log,
          currentCmd: () => currentCmd.cmd,
          onHeartbeat: (at, seq) => writeHeartbeat(RT_DIR, { at, seq }),
        });
      },
      stop() {
        loopMon?.stop();
        if (healthInterval) clearInterval(healthInterval);
        agentStatusPoller?.stop();
        notifyBridgeStop?.();
        homeSnapshot?.stop();
        for (const h of sweepHandles) h.stop();
        cron?.dispose();
        hooksGuard?.closeAll();
      },
    },

    // 7: handlers (buildRoutedHandlers over the started subsystems).
    {
      name: "handlers",
      start() {
        handlerCtx = {
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
          getHealth: buildHealthSnapshot,
          heartbeatSeq: loopMon.seq,
          setLogLevel: (l) => { log.level = l; log.info({ level: l }, "log level changed"); },
          getLogLevel: () => log.level,
        };
        freshnessEnv = { ctx: handlerCtx, broadcast: emit };
        routedHandlers = buildRoutedHandlers({
          ctx: handlerCtx,
          broadcast: emit,
          systemProcessScanner,
          worktree: {
            emit,
            kick: worktreeReconciler.kick,
            creationInFlight: worktreeReconciler.creationInFlight,
            withReconcilerHeld: worktreeReconciler.withReconcilerHeld,
          },
          eventsBus,
          homeSnapshot,
          repos: {
            withReconcilerHeld: worktreeReconciler.withReconcilerHeld,
            refreshWatchedRepos: hooksGuard.refreshWatchedRepos,
          },
          stateDb: getStateDb("daemon"),
          chatDeliveryChains,
        });
      },
      stop() {},
    },

    // 8: API server. A failed bind exits fatally (fatal-boot handler), and
    // binding API before the unix socket means that exit never strands a
    // socket-bound zombie. evictStaleDaemon first, so an orphan holding the
    // socket/port is gone before either bind.
    {
      name: "api-server",
      async start() {
        await evictStaleDaemon(log);
        // Auto-unlink any tagged tool link whose tool now has a genuine user
        // copy elsewhere on PATH. reconcile() is synchronous; setTimeout(0)
        // pushes it past the server binds and pid write below.
        setTimeout(() => {
          try {
            const { removed } = reconcileLinks(createRealProbes());
            if (removed.length > 0) log.info({ removed }, "deps: auto-unlinked tools now shadowed by a user copy");
          } catch (err) {
            log.warn({ err }, "deps: link reconcile failed");
          }
        }, 0);
        log.info("daemon starting");
        setPhase("api");
        ctx.servers.api = await seams.bindApiServer(handleCommand, log);
      },
      stop() {
        try { ctx.servers.api?.stop(true); } catch { /* server already stopped */ }
        clearWsClients();
      },
    },

    // 9: socket server.
    {
      name: "socket-server",
      start() {
        setPhase("socket");
        ctx.servers.socket = seams.bindSocketServer(handleCommand, log);
      },
      stop() {
        try { ctx.servers.socket?.stop(true); } catch { /* server already stopped */ }
      },
    },

    // 10: rt.pid, written only after both servers are bound: a boot that fails
    // before this point must never leave a live-pid file with no servers.
    {
      name: "rt-pid",
      start() {
        seams.writePid(process.pid);
      },
      stop() {
        // Reverse-stop runs this before the server units stop; the ownership
        // check keeps that safe (unlinks only if rt.pid still names this pid).
        removeRuntimeFiles({ log });
      },
    },

    // 11: pollers, freshness, discussions poller (plus the serving-startup
    // kicks that follow the pid write today).
    {
      name: "pollers",
      start() {
        // Wire notification broadcasts to WebSocket clients.
        onNotification(emit);
        // Discover and watch repos.
        hooksGuard.refreshWatchedRepos();
        // Team tracking intent resolves through a primed identity→name map;
        // the 60s hooks-scan poller is the only re-prime mechanism now that the
        // repo index lives in state.db.
        primeTeamTrackingIdentityMap(loadRepoIndex()).catch((err) => {
          log.warn({ err }, "repo-tracking: failed to prime team-intent identity map");
        });

        pollersHandle = startPollers({
          log, refreshCache, portCacheRef, broadcast: emit, systemProcessScanner,
          repoIndex: loadRepoIndex,
          checkAndRepairHooksPath: hooksGuard.checkAndRepairHooksPath,
        });

        // Kick off the events watchers once the first refresh has populated the
        // cache with repoName stamps. reconcileFreshness (via the cache
        // refresher) follows repo-index changes from there.
        freshnessInitTimer = safeTimeout(() => {
          initFreshness(freshnessEnv).catch((err) => {
            log.error({ err }, "freshness: init failed");
          });
        }, 7000, "freshness-init", log);

        // Background sweep for new MR comments → `discussions:new-comments`.
        discussionsPoller = createDiscussionsPoller({ ctx: handlerCtx, broadcast: emit });
        discussionsPoller.start();
      },
      stop() {
        if (freshnessInitTimer) clearTimeout(freshnessInitTimer);
        // disposeFreshness/reconcileFreshness operate on the shared default
        // core the handlers, cache-refresh and command-router also read, so the
        // daemon drives that core rather than a forked createFreshness instance
        // (adopting the instance is 5.3's per-factory dep work).
        disposeFreshness();
        discussionsPoller?.stop();
        pollersHandle?.stop();
      },
    },

    // 12: signal handlers, then the ready breadcrumb.
    {
      name: "ready",
      start() {
        seams.installSignalHandlers({
          cleanup: stopAll,
          flushLogs: () => loggerHandle.flush?.(),
          log,
          wasVerbShutdown: () => shuttingDownViaVerb,
        });
        ctx.bootPhase = "ready";
        recordDaemonReady();
        setPhase("ready");
        log.info({ pid: process.pid }, "daemon ready");
      },
      stop() {},
    },
  ];

  ctx.units = units;
  return units;
}

/**
 * Construct the boot context, run the ordered units, and on any unit-start
 * failure log fatal + record the boot-failure phase + exit(1) (runUnits has
 * already stopped the units that did start, in reverse). Signal handlers are
 * installed by the ready unit; the shutdown verb and signals both derive
 * teardown from stopUnits.
 */
export async function startDaemon(opts?: { seams?: Partial<BootSeams> }): Promise<void> {
  const ctx = makeBootContext(opts?.seams ?? {});
  const units = buildUnits(ctx);
  try {
    await runUnits(units, ctx.log);
  } catch (err) {
    ctx.log.fatal?.({ err }, "daemon boot failed");
    recordBootFailure(ctx.currentPhase, String(err));
    try { ctx.loggerHandle?.flush?.(); } catch (flushErr) { ctx.log.warn?.({ err: flushErr }, "daemon boot log flush failed"); }
    process.exit(1);
  }
}

// Injected at compile time via `bun build --define RT_VERSION='"v1.x.x"'`.
declare const RT_VERSION: string | undefined;

// Auto-run when executed directly (source mode: bun run lib/daemon.ts).
if (import.meta.main) {
  startDaemon();
}
