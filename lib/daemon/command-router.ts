/**
 * Command router — assembles the extracted-handler map, built once at startup.
 *
 * Every IPC/REST command goes through a single map lookup in the daemon's
 * handleCommand; only the lifecycle-coupled `shutdown` fall-through remains
 * inline in daemon.ts.
 */

import type { Database } from "bun:sqlite";
import type { Handler, HandlerContext, HandlerMap, TypedHandlers } from "./handlers/types.ts";
import { createCacheHandlers }     from "./handlers/cache.ts";
import { createHooksHandlers }     from "./handlers/hooks.ts";
import { createStatusHandlers }    from "./handlers/status.ts";
import { createMRHandlers }        from "./handlers/mr.ts";
import { createWorktreeHandlers, type WorktreeHandlerOpts } from "./handlers/worktree.ts";
import { createDiscussionHandlers } from "./handlers/discussions.ts";
import { createSystemProcessHandlers } from "./handlers/system-processes.ts";
import { createSdmHandlers } from "./handlers/sdm.ts";
import { createRunsHandlers } from "./handlers/runs.ts";
import { createSecretsHandlers } from "./handlers/secrets.ts";
import { createProjectMRsHandlers } from "./handlers/project-mrs.ts";
import { createEventsHandlers } from "./handlers/events.ts";
import { createGateHandlers } from "./handlers/gate.ts";
import { createChatHandlers } from "./handlers/chat.ts";
import { createAgentHandlers } from "./handlers/agent.ts";
import { createPaneHandlers } from "./handlers/pane.ts";
import { createEndpointHandlers } from "./handlers/endpoint.ts";
import { createSettingsHandlers } from "./handlers/settings.ts";
import { createHomeHandlers } from "./handlers/home.ts";
import { createTeamSnapshotHandlers } from "./handlers/team-snapshot.ts";
import { createReposHandlers } from "./handlers/repos.ts";
import { reconcileFreshness, getFreshnessSnapshot } from "./freshness.ts";
import { wrapWithDemand } from "./demand-tracker.ts";
import type { SystemProcessScanner } from "./system-process-scanner.ts";
import type { EventsBus } from "./events-bus.ts";
import type { GatesStore } from "./gates-store.ts";
import type { GatePush } from "./gate-push.ts";
import type { HomeSnapshotHandle } from "./home-snapshot.ts";
import type { TeamSnapshotsHandle } from "./team-snapshots.ts";

// The exported return type is the plain `Record<string, Handler>` a router
// lookup needs; the exhaustiveness proof against the rt-client catalog
// (MAT-31) still runs on the `handlers` local below, typed `TypedHandlers &
// HandlerMap`: that intersection's index signature is also what rejects a
// non-function value (e.g. a factory that erroneously returns `db`) as a
// compile error, before the runtime exhaustiveness test in
// __tests__/rt-client-commands.test.ts ever runs.
export function buildRoutedHandlers(opts: {
  ctx: HandlerContext;
  broadcast: (type: string, data: any) => void;
  systemProcessScanner: SystemProcessScanner;
  /** Reconciler seams the worktree verbs drive (spec §7): claim events, replenish kicks, in-flight creates. */
  worktree: WorktreeHandlerOpts;
  /** Events bus backing events:emit/wait/list (RT-44). */
  eventsBus: EventsBus;
  /** Gates store backing gate:* (BOARD-20/21). */
  gatesStore: GatesStore;
  /** Pane push + subscription fan-out for gate:open/gate:answer (BOARD-20/21
      W1 task 6). Omitted callers (most router-level tests) get gate.ts's
      own no-op default. */
  gatePush?: GatePush;
  /** Home-repo snapshot daemon (H2) — inert handle when disabled/not-a-repo. */
  homeSnapshot: HomeSnapshotHandle;
  /** One snapshot engine per team clone under ~/.mattstack/teams. */
  teamSnapshots: TeamSnapshotsHandle;
  /** Reconciler hold + hooks-guard rewire the repos:locate verb drives. */
  repos: {
    withReconcilerHeld: <T>(fn: () => Promise<T>) => Promise<T>;
    refreshWatchedRepos: () => void;
  };
  /**
   * state.db, for chat:* and agent:* handlers. Passed in already-open
   * rather than resolved here with getStateDb(): this function is called at
   * the daemon's module-evaluation time, and state.db must not open before
   * startDaemon()'s explicit, ordered open (see lib/daemon.ts's branch-cache
   * facade comment).
   */
  stateDb: Database;
  /**
   * Shared with the daemon's periodic chat delivery sweep (lib/daemon.ts),
   * so a sweep re-delivery chains behind an in-flight chat:post/chat:dm
   * delivery to the same recipient instead of racing it. A caller with no
   * sweep (most tests) omits this and createChatHandlers falls back to its
   * own private map.
   */
  chatDeliveryChains?: Map<string, Promise<void>>;
}): Record<string, Handler> {
  const { ctx, broadcast, systemProcessScanner } = opts;
  // The bus owns frame-building + persistence (R020, events-bus.ts); this
  // just keeps the "event"-wrapped WS broadcast contract rt-client's relay
  // depends on (packages/rt-client/src/relay.ts: `type === "event"`, topic
  // in `data.topic`).
  const emitEvent = (topic: string, payload: unknown): number => {
    const frame = opts.eventsBus.emitEvent(topic, payload);
    broadcast("event", frame);
    return frame.id;
  };
  const chatHandlers = createChatHandlers({
    db: opts.stateDb, emitEvent, repoIndex: ctx.repoIndex, log: ctx.log, deliveryChains: opts.chatDeliveryChains,
  });
  const paneHandlers = createPaneHandlers({ db: opts.stateDb, repoIndex: ctx.repoIndex });
  const agentHandlers = createAgentHandlers({ db: opts.stateDb, emitEvent, log: ctx.log });
  const handlers: TypedHandlers & HandlerMap = {
    ...createCacheHandlers({ cache: ctx.cache, refreshCache: ctx.refreshCache }),
    ...createHooksHandlers({
      repoIndex: ctx.repoIndex,
      checkAndRepairHooksPath: ctx.checkAndRepairHooksPath,
      startWatchingRepo: ctx.startWatchingRepo,
    }),
    ...createStatusHandlers({
      getHealth: ctx.getHealth, startedAt: ctx.startedAt, identity: ctx.identity, heartbeatSeq: ctx.heartbeatSeq,
      repoIndex: ctx.repoIndex, watchedConfigs: ctx.watchedConfigs, cache: ctx.cache, portCacheRef: ctx.portCacheRef,
      refreshStatusRef: ctx.refreshStatusRef, log: ctx.log, setLogLevel: ctx.setLogLevel, getLogLevel: ctx.getLogLevel,
    }),
    ...createMRHandlers({ repoIndex: ctx.repoIndex, cache: ctx.cache, log: ctx.log }, broadcast),
    ...createWorktreeHandlers({ repoIndex: ctx.repoIndex, cache: ctx.cache, log: ctx.log }, opts.worktree),
    ...createDiscussionHandlers({ repoIndex: ctx.repoIndex, cache: ctx.cache }, broadcast),
    ...createSystemProcessHandlers(systemProcessScanner, { portCacheRef: ctx.portCacheRef, cache: ctx.cache }),
    ...createSdmHandlers({ log: ctx.log }),
    ...createRunsHandlers({ log: ctx.log }, emitEvent),
    ...createSecretsHandlers({ log: ctx.log }),
    ...createProjectMRsHandlers({ repoIndex: ctx.repoIndex, log: ctx.log }, broadcast),
    ...createEventsHandlers(opts.eventsBus, broadcast),
    ...createGateHandlers(opts.gatesStore, opts.eventsBus, broadcast, { push: opts.gatePush, log: ctx.log }),
    ...chatHandlers,
    ...agentHandlers,
    ...paneHandlers,
    ...createEndpointHandlers({ log: ctx.log, repoIndex: ctx.repoIndex }),
    ...createSettingsHandlers(),
    ...createHomeHandlers(opts.homeSnapshot),
    ...createTeamSnapshotHandlers(opts.teamSnapshots),
    ...createReposHandlers({ ...opts.repos, emitEvent }),

    // Applies repo-tracking edits immediately (rt daemon track <repo>
    // live|poll|off) instead of waiting for the next refresh-tail reconcile.
    "freshness:reconcile": async () => {
      await reconcileFreshness({ ctx, broadcast });
      return { ok: true, data: getFreshnessSnapshot() };
    },
  };
  // A tray/CLI/console read of any scan-backed command means "someone is
  // watching", which un-gates the background scans (see pollers.ts, S058/S093).
  return wrapWithDemand(handlers, ["ports", "system-processes", "tray:status"]);
}
