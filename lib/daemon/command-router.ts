/**
 * Command router — assembles the extracted-handler map, built once at startup.
 *
 * Every IPC/REST command goes through a single map lookup in the daemon's
 * handleCommand; only the lifecycle-coupled `shutdown` fall-through remains
 * inline in daemon.ts.
 */

import type { Database } from "bun:sqlite";
import type { HandlerContext, HandlerMap, TypedHandlers } from "./handlers/types.ts";
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
import { createChatHandlers } from "./handlers/chat.ts";
import { createEndpointHandlers } from "./handlers/endpoint.ts";
import { createSettingsHandlers } from "./handlers/settings.ts";
import { createHomeHandlers } from "./handlers/home.ts";
import { createReposHandlers } from "./handlers/repos.ts";
import { reconcileFreshness, getFreshnessSnapshot } from "./freshness.ts";
import type { SystemProcessScanner } from "./system-process-scanner.ts";
import type { EventsBus } from "./events-bus.ts";
import type { HomeSnapshotHandle } from "./home-snapshot.ts";

// `TypedHandlers & HandlerMap`, not plain HandlerMap: the intersection makes
// this function the compile-time proof that every command in the rt-client
// catalog has a daemon handler. A catalog entry whose factory stops
// declaring it fails here, before the runtime exhaustiveness test in
// __tests__/rt-client-commands.test.ts ever runs (MAT-31).
export function buildRoutedHandlers(opts: {
  ctx: HandlerContext;
  broadcast: (type: string, data: any) => void;
  systemProcessScanner: SystemProcessScanner;
  /** Reconciler seams the worktree verbs drive (spec §7): claim events, replenish kicks, in-flight creates. */
  worktree: WorktreeHandlerOpts;
  /** Events bus backing events:emit/wait/list (RT-44). */
  eventsBus: EventsBus;
  /** Home-repo snapshot daemon (H2) — inert handle when disabled/not-a-repo. */
  homeSnapshot: HomeSnapshotHandle;
  /** Reconciler hold + hooks-guard rewire the repos:locate verb drives. */
  repos: {
    withReconcilerHeld: <T>(fn: () => Promise<T>) => Promise<T>;
    refreshWatchedRepos: () => void;
  };
  /**
   * state.db, for chat:* handlers (RT-48 Task 6). Passed in already-open
   * rather than resolved here with getStateDb(): this function is called at
   * the daemon's module-evaluation time, and state.db must not open before
   * startDaemon()'s explicit, ordered open (see lib/daemon.ts's branch-cache
   * facade comment).
   */
  chatDb: Database;
}): TypedHandlers & HandlerMap {
  const { ctx, broadcast, systemProcessScanner } = opts;
  const emitEvent = (topic: string, payload: unknown) => {
    const emittedAt = Date.now();
    const id = opts.eventsBus.emitAt(topic, payload, emittedAt);
    broadcast("event", { id, topic, payload, emittedAt });
  };
  // createChatHandlers also exposes `db` (its test-isolation seam); dropped
  // here so it never lands as a bogus "db" entry in the command map below.
  const { db: _chatDb, ...chatHandlers } = createChatHandlers({ db: opts.chatDb, emitEvent });
  return {
    ...createCacheHandlers(ctx),
    ...createHooksHandlers(ctx),
    ...createStatusHandlers(ctx),
    ...createMRHandlers(ctx, broadcast),
    ...createWorktreeHandlers(ctx, opts.worktree),
    ...createDiscussionHandlers(ctx, broadcast),
    ...createSystemProcessHandlers(systemProcessScanner, ctx),
    ...createSdmHandlers(ctx),
    ...createRunsHandlers(ctx, emitEvent),
    ...createSecretsHandlers(ctx),
    ...createProjectMRsHandlers(ctx, broadcast),
    ...createEventsHandlers(opts.eventsBus, broadcast),
    ...chatHandlers,
    ...createEndpointHandlers(ctx),
    ...createSettingsHandlers(),
    ...createHomeHandlers(opts.homeSnapshot),
    ...createReposHandlers({ ...opts.repos, emitEvent }),

    // Applies repo-tracking edits immediately (rt daemon track <repo>
    // live|poll|off) instead of waiting for the next refresh-tail reconcile.
    "freshness:reconcile": async () => {
      await reconcileFreshness({ ctx, broadcast });
      return { ok: true, data: getFreshnessSnapshot() };
    },
  };
}
