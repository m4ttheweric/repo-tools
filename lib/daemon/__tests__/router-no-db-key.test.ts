/**
 * R028: chat/pane/agent handler factories take `db` in as a dependency; they
 * must not also return it as a handler-map entry. A stray non-function value
 * reaching the router's command map would be dispatched as a command handler
 * the first time something looked it up.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import pino from "pino";
import { openStateDb } from "../../state/index.ts";
import { createChatHandlers } from "../handlers/chat.ts";
import { createPaneHandlers } from "../handlers/pane.ts";
import { createAgentHandlers } from "../handlers/agent.ts";
import { buildRoutedHandlers } from "../command-router.ts";
import { createEventsBus } from "../events-bus.ts";
import { fakeStore } from "./fake-cache-store.ts";
import type { HandlerContext } from "../handlers/types.ts";

let n = 0;
function freshDb() {
  return openStateDb(join(tmpdir(), `router-no-db-${process.pid}-${n++}.db`));
}

function everyValueIsAFunction(map: Record<string, unknown>): boolean {
  return Object.values(map).every((v) => typeof v === "function");
}

describe("R028: db is not a handler-map entry", () => {
  test("createChatHandlers/createPaneHandlers/createAgentHandlers return only functions", () => {
    const db = freshDb();
    const combined = {
      ...createChatHandlers({ db, emitEvent: () => 0 }),
      ...createPaneHandlers({ db, repoIndex: () => ({}) }),
      ...createAgentHandlers({ db, emitEvent: () => 0 }),
    };
    expect(everyValueIsAFunction(combined)).toBe(true);
  });

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

  test("buildRoutedHandlers' assembled map has no non-function entries", () => {
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
      homeSnapshot: { stop: () => {}, runNow: async () => ({}) as any, pullNow: async () => ({}) as any, status: () => ({}) as any, ready: Promise.resolve() },
      repos: { withReconcilerHeld: async (fn) => fn(), refreshWatchedRepos: () => {} },
      stateDb: freshDb(),
    });
    expect(everyValueIsAFunction(handlers)).toBe(true);
  });
});
