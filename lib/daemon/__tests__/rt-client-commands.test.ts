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
import { COMMAND_NAMES } from "../../../packages/rt-client/src/commands.ts";
import type { HandlerContext } from "../handlers/types.ts";

// Handlers are only assembled here (never invoked), so the stub ctx/scanner
// just need to satisfy the types -- no factory reaches into them eagerly.
const stubCtx = {
  cache: { entries: {} },
  refreshCache: async () => {},
  loadCache: () => {},
  flushCache: () => {},
  log: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} },
  startedAt: Date.now(),
  portCacheRef: { ports: [], updatedAt: 0 },
  watchedConfigs: new Map(),
  repoIndex: () => ({}),
  checkAndRepairHooksPath: async () => false,
  startWatchingRepo: () => {},
  refreshStatusRef: { lastRefreshAt: 0 },
} as unknown as HandlerContext;

describe("rt-client command coverage", () => {
  test("every COMMAND_NAMES entry resolves to a daemon handler", () => {
    const handlers = buildRoutedHandlers({
      ctx: stubCtx,
      broadcast: () => {},
      systemProcessScanner: {} as any,
      worktree: { emit: () => {}, kick: () => {}, creationInFlight: () => null },
      eventsBus: createEventsBus({ dbPath: ":memory:", log: pino({ level: "silent" }) }),
    });
    for (const name of COMMAND_NAMES) {
      expect(handlers[name]).toBeDefined();
    }
  });
});
