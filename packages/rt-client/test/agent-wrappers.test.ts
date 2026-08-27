import { expect, test } from "bun:test";
import { agentGet, agentList, agentResume, agentStart, COMMAND_NAMES } from "../src/index.ts";

test("agent wrappers are exported functions", () => {
  for (const fn of [agentStart, agentResume, agentGet, agentList]) {
    expect(typeof fn).toBe("function");
  }
});

test("agent commands are cataloged", () => {
  const names: string[] = [...COMMAND_NAMES];
  for (const name of ["agent:start", "agent:resume", "agent:get", "agent:list"]) {
    expect(names).toContain(name);
  }
});

test("wrappers degrade to ok:false with no daemon", async () => {
  const res = await agentGet({ id: "ag-00000000" }, { sockPath: "/nonexistent/rt.sock" });
  expect(res.ok).toBe(false);
});
