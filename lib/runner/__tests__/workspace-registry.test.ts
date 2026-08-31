import { test, expect } from "bun:test";
import { isAlive, planReconcile, planTmuxReconcile, readRegistry, registerWorkspace, unregisterWorkspace } from "../workspace-registry.ts";

test("isAlive: the current process is alive, a pid that cannot exist is not", () => {
  expect(isAlive(process.pid)).toBe(true);
  expect(isAlive(2147483646)).toBe(false);
});

test("registerWorkspace then readRegistry round-trips the pid; unregisterWorkspace removes it", () => {
  registerWorkspace("wZZ", 4242);
  expect(readRegistry().get("wZZ")).toBe(4242);

  unregisterWorkspace("wZZ");
  expect(readRegistry().has("wZZ")).toBe(false);
});

test("planReconcile: closes runner workspaces with no live owner, leaves live-owned and non-runner workspaces alone, and drops stale registry entries", () => {
  const alivePid = 111;
  const workspaces = [
    { id: "a", label: "rt-runner-a" }, // registry pid alive: kept
    { id: "b", label: "rt-runner-b" }, // registry pid dead: closed
    { id: "c", label: "rt-runner-c" }, // no registry entry: closed
    { id: "d", label: "Islands Fencing" }, // not a runner workspace: never touched
  ];
  const registry = new Map<string, number>([
    ["a", alivePid],
    ["b", 999998],
    ["e", 999997], // no matching workspace: stale record
  ]);
  const alive = (pid: number) => pid === alivePid;

  const plan = planReconcile(workspaces, registry, alive);

  expect(plan.closeWorkspaceIds).toEqual(["b", "c"]);
  expect(plan.closeWorkspaceIds).not.toContain("a");
  expect(plan.closeWorkspaceIds).not.toContain("d");
  expect(plan.removeRegistryIds).toContain("b");
  expect(plan.removeRegistryIds).toContain("e");
  expect(plan.removeRegistryIds).not.toContain("a");
  expect(plan.removeRegistryIds).not.toContain("d");
});

test("planTmuxReconcile: dead-owner sockets are queued to kill and remove; live-owner sockets are left alone", () => {
  const alivePid = 222;
  const registry = new Map<string, number>([
    ["/tmp/live.sock", alivePid],
    ["/tmp/dead.sock", 999996],
  ]);
  const alive = (pid: number) => pid === alivePid;

  const plan = planTmuxReconcile(registry, alive);

  expect(plan.killSocketIds).toEqual(["/tmp/dead.sock"]);
  expect(plan.removeIds).toEqual(["/tmp/dead.sock"]);
});

test("registerWorkspace/unregisterWorkspace/readRegistry under kind \"tmux\" do not collide with the default \"workspaces\" kind", () => {
  registerWorkspace("shared-id", 4243);
  registerWorkspace("shared-id", 4244, "tmux");

  expect(readRegistry().get("shared-id")).toBe(4243);
  expect(readRegistry("tmux").get("shared-id")).toBe(4244);

  unregisterWorkspace("shared-id");
  expect(readRegistry().has("shared-id")).toBe(false);
  expect(readRegistry("tmux").has("shared-id")).toBe(true);

  unregisterWorkspace("shared-id", "tmux");
  expect(readRegistry("tmux").has("shared-id")).toBe(false);
});
