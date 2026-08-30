/**
 * checkAndNotify's fired-ledger hygiene (RT-48 "Store-by-store" item 4,
 * review r1 finding 11): at the cycle tail, `fired` keys belonging to
 * branches with no branch-cache entry this cycle are dropped, so an evicted
 * branch (branch-cache GC, or simply absent from this cycle's cacheEntries)
 * can never leak a stale key that would suppress a real notification if the
 * branch returns.
 *
 * `notify()` is mocked out (same convention as
 * lib/__tests__/runaway-process-notifications.test.ts) so these tests never
 * touch the notify_queue, the tray socket, or the 10s CLI-notifier fallback
 * timer — only the persisted kv state (`fired`/`branches`) is under test.
 *
 * HOME isolation is the repo-wide bun test preload (test-setup.ts); the
 * state.db singleton is reset between tests via closeStateDb() so cycles
 * within one test share persistence but tests never leak into each other.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as notifierModule from "../notifier.ts";
import { closeStateDb, getNotifierStateBlob } from "../state/index.ts";
import { composeKey } from "../state/branch-cache.ts";

interface NotifierStateShape {
  branches: Record<string, unknown>;
  ports: Record<string, unknown>;
  fired: string[];
}

function emptyState(): NotifierStateShape {
  return { branches: {}, ports: {}, fired: [] };
}

function readState(): NotifierStateShape {
  return getNotifierStateBlob<NotifierStateShape>(emptyState());
}

function mrEntry(pipelineStatus: string) {
  return {
    ticket: null,
    linearId: "",
    fetchedAt: 0,
    mr: {
      author: { id: "gitlab:123" },
      state: "opened",
      pipeline: { status: pipelineStatus },
      blockers: { awaitingApprovals: true, hasConflicts: false },
      reviews: { isApproved: false },
      statusDetail: "unchecked",
    },
  };
}

afterEach(() => {
  mock.restore();
  closeStateDb();
});

describe("checkAndNotify fired-ledger hygiene", () => {
  test("an evicted branch's fired key is dropped from persisted state", () => {
    spyOn(notifierModule.__test__.getDefaultNotifier(), "notify").mockImplementation(() => {});

    // Cycle 1: baseline (branch-a's pipeline running).
    notifierModule.checkAndNotify({ "branch-a": mrEntry("running") }, undefined, 123);
    // Cycle 2: running -> failed. Fires and persists the pipeline:failed key.
    notifierModule.checkAndNotify({ "branch-a": mrEntry("failed") }, undefined, 123);

    const key = notifierModule.__test__.firedKey("pipeline:failed", "branch-a");
    expect(readState().fired).toContain(key);

    // Cycle 3: branch-a is gone from this cycle's cache entries (GC eviction,
    // or simply not refreshed) — hygiene must drop its fired key.
    notifierModule.checkAndNotify({}, undefined, 123);

    const state = readState();
    expect(state.fired).not.toContain(key);
    expect(state.branches["branch-a"]).toBeUndefined();
  });

  test("a returning branch can re-notify: the stale key from before eviction no longer suppresses it", () => {
    const notifySpy = spyOn(notifierModule.__test__.getDefaultNotifier(), "notify").mockImplementation(() => {});

    notifierModule.checkAndNotify({ "branch-a": mrEntry("running") }, undefined, 123);
    notifierModule.checkAndNotify({ "branch-a": mrEntry("failed") }, undefined, 123);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    // Evicted for a cycle — hygiene drops the stale key (previous test
    // covers this assertion in isolation; here it's the setup for re-arming).
    notifierModule.checkAndNotify({}, undefined, 123);

    // Branch returns: first re-sighting is a fresh baseline (no `was`
    // snapshot to diff against yet), so no transition fires here.
    notifierModule.checkAndNotify({ "branch-a": mrEntry("running") }, undefined, 123);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    // Same running -> failed transition as before. Without the hygiene fix,
    // the never-cleared key from the first firing would silently suppress
    // this — it must fire again.
    notifierModule.checkAndNotify({ "branch-a": mrEntry("failed") }, undefined, 123);
    expect(notifySpy).toHaveBeenCalledTimes(2);

    const key = notifierModule.__test__.firedKey("pipeline:failed", "branch-a");
    expect(readState().fired).toContain(key);
  });
});

describe("checkAndNotify: composite-key repo scoping (S069/Task 10)", () => {
  test("evicting one repo's branch does not prune the other repo's fired key", () => {
    spyOn(notifierModule.__test__.getDefaultNotifier(), "notify").mockImplementation(() => {});

    const keyA = composeKey("repo-a", "main");
    const keyB = composeKey("repo-b", "main");

    // Cycle 1: both repos' "main" baseline (same bare branch, distinct
    // composite keys...the collision this task fixes).
    notifierModule.checkAndNotify({ [keyA]: mrEntry("running"), [keyB]: mrEntry("running") }, undefined, 123);
    // Cycle 2: repo-a's pipeline fails; repo-b's stays running. Fires and
    // persists repo-a's pipeline:failed key, keyed by the FULL composite key.
    notifierModule.checkAndNotify({ [keyA]: mrEntry("failed"), [keyB]: mrEntry("running") }, undefined, 123);

    const firedKeyA = notifierModule.__test__.firedKey("pipeline:failed", keyA);
    expect(readState().fired).toContain(firedKeyA);

    // Cycle 3: repo-a's branch is evicted (GC, or just absent this cycle);
    // repo-b's "main" is still present under its own composite key.
    notifierModule.checkAndNotify({ [keyB]: mrEntry("running") }, undefined, 123);

    const state = readState();
    expect(state.fired).not.toContain(firedKeyA);
    // repo-b's own baseline snapshot survives untouched by repo-a's eviction.
    expect(state.branches[keyB]).toBeDefined();
  });
});

describe("pruneFiredForEvictedBranches (unit)", () => {
  test("keeps only keys reconstructable from the live branch set", () => {
    const fired = new Set([
      notifierModule.__test__.firedKey("mr:merged", "evicted"),
      notifierModule.__test__.firedKey("pipeline:failed", "live"),
    ]);
    notifierModule.__test__.pruneFiredForEvictedBranches(fired, ["live"]);
    expect([...fired]).toEqual([notifierModule.__test__.firedKey("pipeline:failed", "live")]);
  });

  test("an empty live set drops every key", () => {
    const fired = new Set([notifierModule.__test__.firedKey("mr:ready", "any-branch")]);
    notifierModule.__test__.pruneFiredForEvictedBranches(fired, []);
    expect(fired.size).toBe(0);
  });
});
