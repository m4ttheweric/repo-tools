/**
 * buildProcessRecords unit tests — pure merge of raw ProcessManager entries,
 * state/pid lookups, and worktree resolution into the enriched record an
 * external consumer (GUI) reads. No git, no filesystem, no daemon.
 */

import { describe, test, expect } from "bun:test";
import { buildProcessRecords } from "../process-records.ts";
import type { WorktreeInfo } from "../resolve-worktree.ts";

const WORKTREES: WorktreeInfo[] = [
  { repo: "assured", path: "/repos/assured-primary", branch: "main" },
];

const RAW = [
  {
    id: "1-assured-primary",
    config: { cmd: "npm run dev", cwd: "/repos/assured-primary/apps/adjuster", env: { PORT: "10001" } },
    startedAt: 1000,
    exitCode: undefined,
  },
];

describe("buildProcessRecords", () => {
  test("merges config, state, pid, timing and worktree into one record", () => {
    const records = buildProcessRecords(
      RAW,
      (id) => (id === "1-assured-primary" ? "running" : "stopped"),
      (id) => (id === "1-assured-primary" ? 4242 : undefined),
      WORKTREES,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      id: "1-assured-primary",
      cmd: "npm run dev",
      cwd: "/repos/assured-primary/apps/adjuster",
      env: { PORT: "10001" },
      kind: undefined,
      state: "running",
      pid: 4242,
      startedAt: 1000,
      exitCode: undefined,
      repo: "assured",
      worktree: "/repos/assured-primary",
      branch: "main",
      url: undefined,
      port: 10001,
    });
  });

  test("leaves repo/worktree/branch undefined when cwd matches no worktree", () => {
    const records = buildProcessRecords(
      [{ id: "x", config: { cmd: "c", cwd: "/elsewhere" } }],
      () => "stopped",
      () => undefined,
      WORKTREES,
    );
    expect(records[0]?.repo).toBeUndefined();
    expect(records[0]?.worktree).toBeUndefined();
    expect(records[0]?.branch).toBeUndefined();
  });

  test("defaults unknown state to stopped via the provided lookup", () => {
    const records = buildProcessRecords(
      [{ id: "x", config: { cmd: "c", cwd: "/repos/assured-primary" } }],
      () => "stopped",
      () => undefined,
      WORKTREES,
    );
    expect(records[0]?.state).toBe("stopped");
  });

  test("exposes portless url/port from the process env", () => {
    const recs = buildProcessRecords(
      [{ id: "p1", config: { cmd: "x", cwd: "/a/wt/app", env: { PORT: "10001", PORTLESS_URL: "https://app.localhost" } }, startedAt: 1 }],
      () => "running",
      () => 123,
      [],
    );
    expect(recs[0].url).toBe("https://app.localhost");
    expect(recs[0].port).toBe(10001);
  });

  test("url/port absent when env has no portless vars", () => {
    const recs = buildProcessRecords(
      [{ id: "p1", config: { cmd: "x", cwd: "/a" }, startedAt: 1 }],
      () => "running", () => undefined, [],
    );
    expect(recs[0].url).toBeUndefined();
    expect(recs[0].port).toBeUndefined();
  });
});
