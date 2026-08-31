import { test, expect } from "bun:test";
import { isAlive, planReconcile, readRegistry, registerWorkspace, unregisterWorkspace } from "../workspace-registry.ts";

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
