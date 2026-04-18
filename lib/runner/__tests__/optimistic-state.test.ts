/**
 * mergeOptimisticStates unit tests.
 *
 * Covers the merge semantics that keep the UI's optimistic "starting"/"stopping"
 * transients visible for a minimum display window (and until the daemon confirms
 * the expected terminal state) before accepting daemon truth.
 */

import { describe, test, expect } from "bun:test";
import {
  mergeOptimisticStates,
  DEFAULT_MIN_TRANSIENT_MS,
} from "../optimistic-state.ts";
import type { EntryState } from "../../../commands/runner.tsx";

const MIN_MS = DEFAULT_MIN_TRANSIENT_MS; // 800

describe("mergeOptimisticStates", () => {
  test("no transients: returns daemon clone with empty expiredIds", () => {
    const daemonStates = new Map<string, EntryState>([
      ["a", "running"],
      ["b", "stopped"],
    ]);
    const currentStates = new Map<string, EntryState>([
      ["a", "running"],
      ["b", "stopped"],
    ]);

    const { merged, expiredIds } = mergeOptimisticStates({
      daemonStates,
      currentStates,
      optimisticSetAt: new Map(),
      now: 10_000,
    });

    expect(merged).not.toBe(daemonStates); // must be a clone
    expect(Object.fromEntries(merged)).toEqual({ a: "running", b: "stopped" });
    expect(expiredIds).toEqual([]);
  });

  test("optimistic 'starting' within minTransientMs is preserved even if daemon says 'running'", () => {
    const now = 10_000;
    const daemonStates = new Map<string, EntryState>([["a", "running"]]);
    const currentStates = new Map<string, EntryState>([["a", "starting"]]);
    const optimisticSetAt = new Map<string, number>([["a", now - 200]]); // age = 200 < 800

    const { merged, expiredIds } = mergeOptimisticStates({
      daemonStates,
      currentStates,
      optimisticSetAt,
      now,
      minTransientMs: MIN_MS,
    });

    expect(merged.get("a")).toBe("starting");
    expect(expiredIds).toEqual([]);
  });

  test("optimistic 'starting' past minTransientMs drops to daemon 'running'; id in expiredIds", () => {
    const now = 10_000;
    const daemonStates = new Map<string, EntryState>([["a", "running"]]);
    const currentStates = new Map<string, EntryState>([["a", "starting"]]);
    const optimisticSetAt = new Map<string, number>([["a", now - (MIN_MS + 200)]]);

    const { merged, expiredIds } = mergeOptimisticStates({
      daemonStates,
      currentStates,
      optimisticSetAt,
      now,
      minTransientMs: MIN_MS,
    });

    expect(merged.get("a")).toBe("running");
    expect(expiredIds).toEqual(["a"]);
  });

  test("optimistic 'starting' remains if daemon still reports 'starting' (fresh hasn't advanced)", () => {
    const now = 10_000;
    const daemonStates = new Map<string, EntryState>([["a", "starting"]]);
    const currentStates = new Map<string, EntryState>([["a", "starting"]]);
    // Well past the display window — but daemon hasn't advanced, so transient stays.
    const optimisticSetAt = new Map<string, number>([["a", now - 10_000]]);

    const { merged, expiredIds } = mergeOptimisticStates({
      daemonStates,
      currentStates,
      optimisticSetAt,
      now,
      minTransientMs: MIN_MS,
    });

    expect(merged.get("a")).toBe("starting");
    expect(expiredIds).toEqual([]);
  });

  test("optimistic 'stopping' within window preserved; past window with daemon 'stopped' → expiredIds", () => {
    const now = 10_000;

    // Within window: preserved.
    {
      const daemonStates = new Map<string, EntryState>([["a", "stopped"]]);
      const currentStates = new Map<string, EntryState>([["a", "stopping"]]);
      const optimisticSetAt = new Map<string, number>([["a", now - 100]]);

      const { merged, expiredIds } = mergeOptimisticStates({
        daemonStates,
        currentStates,
        optimisticSetAt,
        now,
        minTransientMs: MIN_MS,
      });

      expect(merged.get("a")).toBe("stopping");
      expect(expiredIds).toEqual([]);
    }

    // Past window + daemon 'stopped': dropped.
    {
      const daemonStates = new Map<string, EntryState>([["a", "stopped"]]);
      const currentStates = new Map<string, EntryState>([["a", "stopping"]]);
      const optimisticSetAt = new Map<string, number>([["a", now - (MIN_MS + 500)]]);

      const { merged, expiredIds } = mergeOptimisticStates({
        daemonStates,
        currentStates,
        optimisticSetAt,
        now,
        minTransientMs: MIN_MS,
      });

      expect(merged.get("a")).toBe("stopped");
      expect(expiredIds).toEqual(["a"]);
    }
  });

  test("'crashed' is an acceptable terminal for both 'starting' and 'stopping'", () => {
    const now = 10_000;
    // Past the display window so only the terminal-check branch decides.
    const optimisticSetAt = new Map<string, number>([
      ["a", now - (MIN_MS + 500)],
      ["b", now - (MIN_MS + 500)],
    ]);

    const daemonStates = new Map<string, EntryState>([
      ["a", "crashed"],
      ["b", "crashed"],
    ]);
    const currentStates = new Map<string, EntryState>([
      ["a", "starting"],
      ["b", "stopping"],
    ]);

    const { merged, expiredIds } = mergeOptimisticStates({
      daemonStates,
      currentStates,
      optimisticSetAt,
      now,
      minTransientMs: MIN_MS,
    });

    expect(merged.get("a")).toBe("crashed");
    expect(merged.get("b")).toBe("crashed");
    expect(expiredIds.sort()).toEqual(["a", "b"]);
  });

  test("missing entry in optimisticSetAt: age defaults to now, transient dropped when daemon terminal", () => {
    const now = 10_000;
    // No entry for "a" in optimisticSetAt → age defaults to now - 0 = 10_000 ≫ MIN_MS.
    const daemonStates = new Map<string, EntryState>([
      ["a", "running"],
      ["b", "stopped"],
    ]);
    const currentStates = new Map<string, EntryState>([
      ["a", "starting"],
      ["b", "stopping"],
    ]);

    const { merged, expiredIds } = mergeOptimisticStates({
      daemonStates,
      currentStates,
      optimisticSetAt: new Map(),
      now,
      minTransientMs: MIN_MS,
    });

    expect(merged.get("a")).toBe("running");
    expect(merged.get("b")).toBe("stopped");
    expect(expiredIds.sort()).toEqual(["a", "b"]);
  });
});
