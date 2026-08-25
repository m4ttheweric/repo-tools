/**
 * The hold `repos:locate` runs inside: a reconcile pass that observed a healed
 * index path against un-rewritten registry paths prunes every registry row as
 * "no matching worktree", taking the pool's claim state with it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { closeStateDb } from "../../state/index.ts";
import { createWorktreeReconciler } from "../worktree-reconciler.ts";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

/** An empty index makes each pass a no-op with real awaits — enough to observe pass boundaries without any git. */
function harness(order: string[]) {
  return createWorktreeReconciler({
    cache: { entries: {} },
    repoIndex: () => {
      order.push("pass");
      return {};
    },
    emit: () => {},
    log: silentLog,
  });
}

async function settle(reconciler: { passInFlight: () => boolean }): Promise<void> {
  for (let i = 0; i < 200 && reconciler.passInFlight(); i++) await Bun.sleep(5);
}

describe("withReconcilerHeld", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-hold-home-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  test("a pass already in flight finishes before the held fn runs", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    reconciler.kick();
    await reconciler.withReconcilerHeld(async () => {
      order.push("fn");
    });

    expect(order).toEqual(["pass", "fn"]);
  });

  test("a kick during the hold starts no pass until the fn settles", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    await reconciler.withReconcilerHeld(async () => {
      reconciler.kick();
      await Bun.sleep(10);
      expect(order).toEqual([]);
      order.push("fn-done");
    });

    await settle(reconciler);
    expect(order).toEqual(["fn-done", "pass"]);
  });

  test("two holders serialize", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    await Promise.all([
      reconciler.withReconcilerHeld(async () => {
        order.push("a-start");
        await Bun.sleep(10);
        order.push("a-end");
      }),
      reconciler.withReconcilerHeld(async () => {
        order.push("b-start");
        await Bun.sleep(1);
        order.push("b-end");
      }),
    ]);

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  test("a throwing fn releases the hold", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    await expect(
      reconciler.withReconcilerHeld(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    reconciler.kick();
    await settle(reconciler);
    expect(order).toEqual(["pass"]);
  });

  test("the fn's value comes back to the caller", async () => {
    const reconciler = harness([]);
    expect(await reconciler.withReconcilerHeld(async () => 42)).toBe(42);
  });
});
