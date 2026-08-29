import { describe, test, expect } from "bun:test";
import { createFreshness, __test__, type FreshnessEnv } from "../freshness.ts";
import { fakeStore } from "./fake-cache-store.ts";

function fakeEnv(): FreshnessEnv {
  return {
    ctx: {
      cache: fakeStore(),
      repoIndex: () => ({}),
    } as unknown as FreshnessEnv["ctx"],
    broadcast: () => {},
  };
}

describe("createFreshness (R031)", () => {
  test("two instances hold independent watch maps (no shared module state)", () => {
    const unitA = createFreshness(fakeEnv());
    const unitB = createFreshness(fakeEnv());

    const watchesA = __test__.watchesOf(unitA);
    const watchesB = __test__.watchesOf(unitB);

    expect(watchesA).not.toBe(watchesB);
    expect(watchesA.size).toBe(0);
    expect(watchesB.size).toBe(0);

    watchesA.set("repo-x", { fake: true });

    expect(watchesA.size).toBe(1);
    expect(watchesB.size).toBe(0);
  });

  test("disposing one instance does not affect another instance's snapshot", () => {
    const unitA = createFreshness(fakeEnv());
    const unitB = createFreshness(fakeEnv());

    __test__.watchesOf(unitA).set("repo-x", {
      provider: {},
      projectPath: "x/y",
      dispose: () => {},
      projectId: null,
      state: "live",
      lastSyncedAt: null,
      lastEventId: null,
      processing: false,
      pending: [],
      gapFillTimer: null,
      disposed: false,
    });
    __test__.watchesOf(unitB).set("repo-y", {
      provider: {},
      projectPath: "a/b",
      dispose: () => {},
      projectId: null,
      state: "live",
      lastSyncedAt: null,
      lastEventId: null,
      processing: false,
      pending: [],
      gapFillTimer: null,
      disposed: false,
    });

    expect(Object.keys(unitA.getSnapshot())).toEqual(["repo-x"]);
    expect(Object.keys(unitB.getSnapshot())).toEqual(["repo-y"]);

    unitA.dispose();

    expect(Object.keys(unitA.getSnapshot())).toEqual([]);
    expect(Object.keys(unitB.getSnapshot())).toEqual(["repo-y"]);
  });
});
