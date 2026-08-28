import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentFallback, HEADLESS_NEEDS_DAEMON } from "../agent-fallback.ts";
import { openStateDb, insertAgent, newAgentId } from "../../lib/state/index.ts";
import type { HerdrRunner } from "../../lib/agent-herdr.ts";

let n = 0;
const REPO = "remote:example.com%2Fa%2Fb";
const tmp = () => join(tmpdir(), `agent-fb-${process.pid}-${n++}.db`);

const okRunner = (calls: string[][]): HerdrRunner => async (args) => {
  calls.push(args);
  if (args[0] === "workspace" && args[1] === "list") return { stdout: JSON.stringify({ result: { workspaces: [] } }), exitCode: 0 };
  if (args[0] === "workspace" && args[1] === "create")
    return { stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } } }), exitCode: 0 };
  return { stdout: "{}", exitCode: 0 };
};

test("herdr start records and journals herdr argv", async () => {
  const db = openStateDb(tmp());
  const calls: string[][] = [];
  const res = await runAgentFallback("agent:start",
    { repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr" }, { db, herdrRunner: okRunner(calls) });
  expect(res.ok).toBe(true);
  expect(calls.some((c) => c[0] === "pane" && c[1] === "run")).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  const got = await runAgentFallback("agent:get", { id: (res.data as { id: string }).id }, { db });
  expect(got.ok).toBe(true);
});

test("refuses headless start before spawning", async () => {
  const db = openStateDb(tmp());
  const spy = { called: false };
  const res = await runAgentFallback("agent:start",
    { repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "headless" },
    { db, spawnHeadless: () => { spy.called = true; return { exited: Promise.resolve(0), stdout: async () => "" }; } });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toBe(HEADLESS_NEEDS_DAEMON);
  expect(spy.called).toBe(false);
});

test("refuses resume of a headless record (surface from record)", async () => {
  const db = openStateDb(tmp());
  const rec = { id: newAgentId(), repo: REPO, cwd: "/tmp/x", provider: "claude" as const, surface: "headless" as const, sessionId: crypto.randomUUID(), createdAt: Date.now() };
  insertAgent(rec, db);
  const res = await runAgentFallback("agent:resume", { id: rec.id }, { db });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toBe(HEADLESS_NEEDS_DAEMON);
});

test("list returns records", async () => {
  const db = openStateDb(tmp());
  const calls: string[][] = [];
  await runAgentFallback("agent:start", { repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr" }, { db, herdrRunner: okRunner(calls) });
  const res = await runAgentFallback("agent:list", { repo: REPO }, { db });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect((res.data as { agents: unknown[] }).agents.length).toBe(1);
});
