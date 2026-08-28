import { expect, test } from "bun:test";
import { agentGet, agentList, agentResume, agentStart, COMMAND_NAMES } from "../src/index.ts";
import { fakeDaemon } from "./fake-daemon.ts";

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

test("agentResume forwards workspace and tab", async () => {
  const fake = fakeDaemon({ "agent:resume": { ok: true, data: { id: "ag-1" } } });
  const res = await agentResume(
    { id: "ag-1", prompt: "go", workspace: "reviews", tab: "⟲ !5" },
    { sockPath: fake.sock },
  );
  fake.stop();
  expect(res.ok).toBe(true);
  const seen = fake.seen.find((s) => s.cmd === "agent:resume");
  expect(seen?.payload).toMatchObject({ id: "ag-1", prompt: "go", workspace: "reviews", tab: "⟲ !5" });
});
