import { describe, test, expect } from "bun:test";
import { applyProcessChanged, groupByRepoWorktree } from "./processes.ts";
import type { ProcessRecord, ProcessChangedEvent } from "./types.ts";

function proc(p: Partial<ProcessRecord> & { id: string }): ProcessRecord {
  return { cmd: "cmd", cwd: "/x", state: "stopped", ...p };
}

describe("applyProcessChanged", () => {
  test("patches state/pid/exitCode of the matching process", () => {
    const list = [proc({ id: "a", state: "stopped" }), proc({ id: "b", state: "running", pid: 1 })];
    const ev: ProcessChangedEvent = { id: "a", from: "stopped", to: "running", pid: 42 };
    const next = applyProcessChanged(list, ev);
    expect(next.find((p) => p.id === "a")).toMatchObject({ state: "running", pid: 42 });
  });

  test("leaves other processes untouched", () => {
    const list = [proc({ id: "a", state: "stopped" }), proc({ id: "b", state: "running", pid: 1 })];
    const next = applyProcessChanged(list, { id: "a", from: "stopped", to: "running" });
    expect(next.find((p) => p.id === "b")).toMatchObject({ state: "running", pid: 1 });
  });

  test("records exitCode on a crash transition", () => {
    const list = [proc({ id: "a", state: "running", pid: 9 })];
    const next = applyProcessChanged(list, { id: "a", from: "running", to: "crashed", exitCode: 1 });
    expect(next.find((p) => p.id === "a")).toMatchObject({ state: "crashed", exitCode: 1 });
  });

  test("returns the list unchanged for an unknown id (caller refetches)", () => {
    const list = [proc({ id: "a" })];
    const next = applyProcessChanged(list, { id: "ghost", from: "stopped", to: "running" });
    expect(next).toEqual(list);
  });

  test("does not mutate the input list", () => {
    const list = [proc({ id: "a", state: "stopped" })];
    applyProcessChanged(list, { id: "a", from: "stopped", to: "running" });
    expect(list[0]!.state).toBe("stopped");
  });
});

describe("groupByRepoWorktree", () => {
  test("groups by repo then worktree, sorted", () => {
    const list = [
      proc({ id: "1", repo: "beta", worktree: "/b/main", branch: "main" }),
      proc({ id: "2", repo: "alpha", worktree: "/a/main", branch: "main" }),
      proc({ id: "3", repo: "alpha", worktree: "/a/feat", branch: "feat" }),
    ];
    const groups = groupByRepoWorktree(list);
    expect(groups.map((g) => g.repo)).toEqual(["alpha", "beta"]);
    expect(groups[0]!.worktrees.map((w) => w.worktree)).toEqual(["/a/feat", "/a/main"]);
    expect(groups[0]!.worktrees[0]!.processes.map((p) => p.id)).toEqual(["3"]);
  });

  test("processes without a repo land in an 'ungrouped' bucket", () => {
    const groups = groupByRepoWorktree([proc({ id: "x" })]);
    expect(groups.map((g) => g.repo)).toContain("ungrouped");
  });
});
