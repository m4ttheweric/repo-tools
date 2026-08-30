/**
 * RT-88 rider: a wedged reconciler pass must not pin `inFlight` forever. A pass
 * that outlasts its deadline releases the latch (so `withReconcilerHeld` /
 * repos:locate and follow-up kicks proceed) while the pass finishes in the
 * background; too many such orphans refuse a new pass rather than piling up
 * (S094). The pass is made to wedge by stubbing `listWorktreesAsync` to hang.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import * as gitAsync from "../../worktree/git-async.ts";
import { closeStateDb } from "../../state/index.ts";
import { saveRegistry, type TreeRecord } from "../../worktree/registry.ts";
import { createWorktreeReconciler } from "../worktree-reconciler.ts";

function seedActivity(repoName: string): void {
  const rec: TreeRecord = {
    name: "x", path: join(tmpdir(), "rt-deadline-x"),
    kind: "ephemeral", state: "on-deck", branch: "b",
    createdAt: new Date().toISOString(),
  };
  saveRegistry(repoName, [rec]);
}

describe("reconciler pass deadline", () => {
  const origHome = process.env.HOME;
  let repoPath: string;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rt-deadline-home-")));
    closeStateDb();
    repoPath = realpathSync(mkdtempSync(join(tmpdir(), "rt-deadline-repo-")));
  });

  afterEach(() => {
    mock.restore();
    process.env.HOME = origHome;
    closeStateDb();
  });

  function silent(warns?: unknown[][]): Logger {
    return {
      info: () => {},
      warn: (...a: unknown[]) => { warns?.push(a); },
      error: () => {},
      debug: () => {},
    } as unknown as Logger;
  }

  test("a wedged pass releases the latch after the deadline so a hold proceeds", async () => {
    const repoName = "acme";
    seedActivity(repoName);
    spyOn(gitAsync, "listWorktreesAsync").mockImplementation(() => new Promise(() => {})); // hangs

    const reconciler = createWorktreeReconciler({
      cache: { entries: {} },
      repoIndex: () => ({ [repoName]: repoPath }),
      emit: () => {},
      log: silent(),
      passDeadlineMs: 50,
    });

    reconciler.kick();
    expect(reconciler.passInFlight()).toBe(true);

    const t0 = Date.now();
    await reconciler.withReconcilerHeld(async () => {}); // must not wait out the wedged pass
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("refuses a new pass once too many wedged passes are still running", async () => {
    const repoName = "acme";
    seedActivity(repoName);
    spyOn(gitAsync, "listWorktreesAsync").mockImplementation(() => new Promise(() => {}));

    const warns: unknown[][] = [];
    const reconciler = createWorktreeReconciler({
      cache: { entries: {} },
      repoIndex: () => ({ [repoName]: repoPath }),
      emit: () => {},
      log: silent(warns),
      passDeadlineMs: 30,
    });

    reconciler.kick();                 // pass 1 -> orphans at the deadline
    await Bun.sleep(60);
    reconciler.kick();                 // pass 2 -> orphans at the deadline
    await Bun.sleep(60);
    reconciler.kick();                 // cap hit -> refused, no new pass
    await Bun.sleep(10);

    expect(reconciler.passInFlight()).toBe(false);
    expect(warns.some((w) => String(w[1] ?? "").includes("skipped"))).toBe(true);
  });
});
