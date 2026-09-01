/**
 * Background settling of claim-time ready steps (RT-96). The task runner is
 * exercised against a real registry and real zsh steps: settle outcomes are
 * asserted on the registry record and the event stream, not on mocks.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, readFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { closeStateDb } from "../../state/index.ts";
import { loadRegistry, saveRegistry, type TreeRecord } from "../registry.ts";
import { recoverPendingReady, startReadyTask, readyTaskFor } from "../ready-async.ts";

const repoName = "remote:acme";

function fakeLog(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
}

function makeTreeDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtready-async-")));
  execSync("git init -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -m init", {
    cwd: dir,
    shell: "/bin/zsh",
  });
  return dir;
}

function seedPending(path: string, name = "alpha"): TreeRecord {
  const rec: TreeRecord = {
    name,
    path,
    kind: "ephemeral",
    state: "claimed",
    branch: "rt-1-work",
    createdAt: new Date().toISOString(),
    claimedAt: new Date().toISOString(),
    readyPendingAt: new Date().toISOString(),
  };
  const trees = loadRegistry(repoName);
  trees.push(rec);
  saveRegistry(repoName, trees);
  return rec;
}

interface Ev { type: string; data: any }

function collector(): { emit: (type: string, data: unknown) => void; events: Ev[] } {
  const events: Ev[] = [];
  return { emit: (type, data) => events.push({ type, data: data as any }), events };
}

beforeEach(() => {
  process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtready-async-home-")));
  closeStateDb();
});

describe("startReadyTask", () => {
  test("success clears the pending marker, stamps readyAt, and emits ready-settled", async () => {
    const path = makeTreeDir();
    seedPending(path);
    const { emit, events } = collector();

    const settle = await startReadyTask({
      repoName, path, steps: [{ run: "true" }], emit, log: fakeLog(),
    });

    expect(settle.ok).toBe(true);
    const rec = loadRegistry(repoName).find((t) => t.path === path)!;
    expect(rec.readyPendingAt).toBeUndefined();
    expect(rec.readyAt).toBeTruthy();
    expect(rec.readyFailure).toBeUndefined();
    const ev = events.find((e) => e.type === "worktree:ready-settled");
    expect(ev).toBeDefined();
    expect(ev!.data).toMatchObject({ repo: repoName, tree: "alpha", ok: true });
  });

  test("failure records the failed step, clears pending, and emits ok:false", async () => {
    const path = makeTreeDir();
    seedPending(path);
    const { emit, events } = collector();

    const settle = await startReadyTask({
      repoName, path, steps: [{ run: "exit 3" }], emit, log: fakeLog(),
    });

    expect(settle.ok).toBe(false);
    if (!settle.ok) expect(settle.failedStep).toBe("exit 3");
    const rec = loadRegistry(repoName).find((t) => t.path === path)!;
    expect(rec.readyPendingAt).toBeUndefined();
    expect(rec.readyFailure).toBe("exit 3");
    expect(rec.readyAt).toBeUndefined();
    const ev = events.find((e) => e.type === "worktree:ready-settled");
    expect(ev!.data).toMatchObject({ repo: repoName, tree: "alpha", ok: false, failedStep: "exit 3" });
  });

  test("a second start for the same path joins the in-flight task instead of re-running", async () => {
    const path = makeTreeDir();
    seedPending(path);
    const { emit } = collector();
    const marker = join(path, "marker.txt");

    const first = startReadyTask({
      repoName, path,
      steps: [{ run: `sleep 0.3 && echo ran >> ${marker}` }],
      emit, log: fakeLog(),
    });
    expect(readyTaskFor(path)).not.toBeNull();
    const second = startReadyTask({
      repoName, path, steps: [{ run: `echo ran >> ${marker}` }], emit, log: fakeLog(),
    });

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readyTaskFor(path)).toBeNull();
  });

  test("recoverPendingReady restarts the settle for an orphaned pending tree", async () => {
    const path = makeTreeDir();
    seedPending(path);
    const { emit, events } = collector();

    const kicked = await recoverPendingReady({ repoName, repoPath: path, emit, log: fakeLog() });

    expect(kicked).toEqual(["alpha"]);
    const task = readyTaskFor(path);
    if (task) await task;
    const rec = loadRegistry(repoName).find((t) => t.path === path)!;
    expect(rec.readyPendingAt).toBeUndefined();
    expect(rec.readyAt).toBeTruthy();
    expect(events.find((e) => e.type === "worktree:ready-settled")?.data).toMatchObject({ ok: true });
  });

  test("recoverPendingReady leaves a tree with a live settle task alone", async () => {
    const path = makeTreeDir();
    seedPending(path);
    const { emit } = collector();
    const live = startReadyTask({
      repoName, path, steps: [{ run: "sleep 0.3" }], emit, log: fakeLog(),
    });

    const kicked = await recoverPendingReady({ repoName, repoPath: path, emit, log: fakeLog() });

    expect(kicked).toEqual([]);
    await live;
  });

  test("skips settling when the tree left the registry before the task ran", async () => {
    const path = makeTreeDir();
    const { emit, events } = collector();

    const settle = await startReadyTask({
      repoName, path, steps: [{ run: "true" }], emit, log: fakeLog(),
    });

    expect(settle.ok).toBe(false);
    if (!settle.ok) expect(settle.skipped).toBe("tree-gone");
    expect(events.find((e) => e.type === "worktree:ready-settled")).toBeUndefined();
  });
});
