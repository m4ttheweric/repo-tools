/**
 * Coverage check: every command name the typed rt-client catalog declares
 * (`COMMAND_NAMES` in packages/rt-client) must resolve to a real handler in
 * the daemon's assembled command map. Built the same way lib/daemon.ts does
 * -- via `buildRoutedHandlers` -- so this catches a command added to the
 * catalog with no matching daemon-side handler (or a typo'd name on either
 * side) without needing a live daemon.
 */

import { describe, expect, test } from "bun:test";
import pino from "pino";
import { buildRoutedHandlers } from "../command-router.ts";
import { createEventsBus } from "../events-bus.ts";
import { createGatesStore } from "../gates-store.ts";
import { COMMAND_NAMES } from "../../../packages/rt-client/src/commands.ts";
import type { HandlerContext } from "../handlers/types.ts";
import { fakeStore } from "./fake-cache-store.ts";
import { openStateDb } from "../../state/index.ts";

// Handlers are only assembled here (never invoked), so the stub ctx/scanner
// just need to satisfy the types -- no factory reaches into them eagerly.
const stubCtx = {
  cache: fakeStore({}),
  refreshCache: async () => {},
  log: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} },
  startedAt: Date.now(),
  portCacheRef: { ports: [], updatedAt: 0 },
  watchedConfigs: new Map(),
  repoIndex: () => ({}),
  checkAndRepairHooksPath: async () => false,
  startWatchingRepo: () => {},
  refreshStatusRef: { lastRefreshAt: 0 },
} as unknown as HandlerContext;

// The commands wave 2 (MAT-31) left uncataloged: every remaining daemon
// command with an out-of-process consumer (rt CLI, tray, VS Code extension),
// plus cache:read (R013/R016). Daemon-internal verbs with no such consumer
// (settings:get/list, notifications:peek, home:snapshot*, hooks:status) are
// deliberately excluded -- see lib/daemon/handlers/types.ts's InternalCommands.
const WAVE_3_COMMAND_NAMES = [
  "cache:read",
  "branch:enrich",
  "cache:refresh",
  "daemon:log-level",
  "discussions:diffs",
  "discussions:refresh",
  "discussions:reply",
  "discussions:resolve",
  "endpoint:claim",
  "endpoint:lookup",
  "endpoint:release",
  "endpoint:status",
  "freshness:reconcile",
  "hooks:repair",
  "hooks:watch",
  "mr:action",
  "mr:fetch-job-detail",
  "mr:fetch-job-trace",
  "notifications",
  "ping",
  "ports",
  "repos",
  "repos:locate",
  "sdm:catalog",
  "sdm:recents",
  "sdm:reconnect",
  "sdm:snapshot",
  "status",
  "system-processes",
  "tcc:check",
  "tray:status",
  "worktree:adopt",
  "worktree:create",
  "worktree:dispose",
  "worktree:freshen",
  "worktree:list",
  "worktree:provision",
  "worktree:restore",
] as const;

describe("rt-client command coverage", () => {
  test("COMMAND_NAMES includes cache:read and every wave-3 command (B2)", () => {
    for (const name of WAVE_3_COMMAND_NAMES) {
      expect(COMMAND_NAMES).toContain(name);
    }
  });

  test("every COMMAND_NAMES entry resolves to a daemon handler", () => {
    const handlers = buildRoutedHandlers({
      ctx: stubCtx,
      broadcast: () => {},
      systemProcessScanner: {} as any,
      worktree: {
        emit: () => {},
        kick: () => {},
        creationInFlight: () => null,
        withReconcilerHeld: async (fn) => fn(),
      },
      eventsBus: createEventsBus({ dbPath: ":memory:", log: pino({ level: "silent" }) }),
      gatesStore: createGatesStore({ dbPath: ":memory:", log: pino({ level: "silent" }) }),
      homeSnapshot: { stop: () => {}, runNow: async () => ({}) as any, pullNow: async () => ({}) as any, status: () => ({}) as any, ready: Promise.resolve() },
      teamSnapshots: { stop() {}, rescan: async () => {}, status: () => [], pullNow: async () => ({ outcome: "skipped", detail: null }), ready: Promise.resolve() },
      repos: { withReconcilerHeld: async (fn) => fn(), refreshWatchedRepos: () => {} },
      stateDb: openStateDb(":memory:"),
    });
    for (const name of COMMAND_NAMES) {
      expect(handlers[name]).toBeDefined();
    }
  });
});
