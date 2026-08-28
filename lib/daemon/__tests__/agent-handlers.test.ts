import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../../state/index.ts";
import { createAgentHandlers, type HeadlessChild } from "../handlers/agent.ts";
import type { HerdrRunner } from "../../agent-herdr.ts";

let n = 0;
const REPO = "remote:example.com%2Fa%2Fb";

function okRunner(calls: string[][]): HerdrRunner {
  return async (args) => {
    calls.push(args);
    if (args[0] === "workspace" && args[1] === "list") return { stdout: JSON.stringify({ result: { workspaces: [] } }), exitCode: 0 };
    if (args[0] === "workspace" && args[1] === "create")
      return { stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } } }), exitCode: 0 };
    return { stdout: "{}", exitCode: 0 };
  };
}

function fresh(over: {
  runner?: HerdrRunner;
  spawn?: (argv: string[], cwd: string) => HeadlessChild;
  emit?: (t: string, p?: unknown) => void;
  insertAgentFn?: (...args: unknown[]) => void;
} = {}) {
  const db = openStateDb(join(tmpdir(), `agent-h-${process.pid}-${n++}.db`));
  return createAgentHandlers({
    db,
    emitEvent: over.emit ?? (() => 0),
    herdrRunner: over.runner,
    spawnHeadless: over.spawn,
    insertAgentFn: over.insertAgentFn as typeof import("../../state/index.ts").insertAgent | undefined,
  });
}

test("agent:start herdr records pane ids and a minted session uuid", async () => {
  const calls: string[][] = [];
  const h = fresh({ runner: okRunner(calls) });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr", model: "haiku" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(res.data).toMatchObject({ surface: "herdr", paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", model: "haiku" });
  const paneRun = calls.find((c) => c[0] === "pane" && c[1] === "run");
  expect(paneRun?.[3]).toContain(`'--session-id' '${res.data.sessionId}'`);
  expect(paneRun?.[3]).toContain("cd '/tmp/x'");
});

// Pins the rollback: a launch failure must not leave a phantom record that
// never launched, was never resumed, and can never finish.
test("agent:start herdr rolls back the inserted record when launch fails", async () => {
  const throwingRunner: HerdrRunner = async () => {
    throw new Error("herdr unavailable");
  };
  const h = fresh({ runner: throwingRunner });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr" });
  expect(res.ok).toBe(false);
  const list = await h["agent:list"]({});
  if (!list.ok) throw new Error("unreachable");
  expect(list.data.agents).toHaveLength(0);
});

// Pins the guard: a no-op insert (standing in for runCriticalWrite giving up
// after sustained SQLITE_BUSY) must block the launch, not just the record.
test("agent:start refuses to launch when the insert did not persist", async () => {
  const calls: string[][] = [];
  let spawnCalled = false;
  const h = fresh({
    runner: okRunner(calls),
    spawn: () => {
      spawnCalled = true;
      return { exited: Promise.resolve(0), stdout: async () => "{}" };
    },
    insertAgentFn: () => {},
  });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toMatch(/not recorded/);
  expect(calls).toHaveLength(0);
  expect(spawnCalled).toBe(false);
});

test("agent:start headless refuses a missing prompt", async () => {
  const h = fresh();
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", surface: "headless" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toMatch(/prompt/);
});

test("agent:start headless finishes the record and emits agent/done", async () => {
  const emitted: string[] = [];
  let resolveExit!: (c: number) => void;
  const child: HeadlessChild = {
    exited: new Promise<number>((r) => (resolveExit = r)),
    stdout: async () => JSON.stringify({ result: "ok" }),
  };
  const h = fresh({ spawn: () => child, emit: (t) => emitted.push(t) });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", surface: "headless", prompt: "go" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.finishedAt).toBeUndefined();
  resolveExit(0);
  await new Promise((r) => setTimeout(r, 20));
  const got = await h["agent:get"]({ id: res.data.id });
  if (!got.ok) throw new Error("unreachable");
  expect(got.data.exitCode).toBe(0);
  expect(got.data.resultPath).toBeTruthy();
  expect(emitted).toContain(`agent/done/${res.data.id}`);
});

// Pins the ordering invariant: insertAgent runs before spawnHeadless is ever
// called, so an already-resolved `exited` (the tightest possible race) still
// finds its row when finishAgent's completion callback runs.
test("agent:start headless whose exit resolves immediately still finds its own row", async () => {
  const child: HeadlessChild = {
    exited: Promise.resolve(0),
    stdout: async () => JSON.stringify({ result: "ok" }),
  };
  const h = fresh({ spawn: () => child });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", surface: "headless", prompt: "go" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  await new Promise((r) => setTimeout(r, 20));
  const got = await h["agent:get"]({ id: res.data.id });
  if (!got.ok) throw new Error("unreachable");
  expect(got.data.exitCode).toBe(0);
  expect(got.data.finishedAt).toBeGreaterThan(0);
});

test("agent:resume herdr uses ↺ tab label and --resume, overwrites pane ids", async () => {
  const calls: string[][] = [];
  const h = fresh({ runner: okRunner(calls) });
  const started = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr", label: "job7" });
  if (!started.ok) throw new Error("unreachable");
  calls.length = 0;
  const resumed = await h["agent:resume"]({ id: started.data.id });
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) throw new Error("unreachable");
  const tabArg = calls.find((c) => c[0] === "tab" && c[1] === "rename")?.[3] ?? calls.find((c) => c[1] === "create" && c[0] === "tab")?.[5];
  expect(tabArg).toBe("↺ job7");
  const paneRun = calls.find((c) => c[0] === "pane" && c[1] === "run");
  expect(paneRun?.[3]).toContain(`'--resume' '${started.data.sessionId}'`);
  expect(paneRun?.[3]).not.toContain("--session-id");
  expect(resumed.data.lastResumedAt).toBeGreaterThan(0);
});

test("agent:resume headless without prompt is refused; unknown id errors", async () => {
  const h = fresh({ runner: okRunner([]) });
  const missing = await h["agent:resume"]({ id: "ag-ffffffff" });
  expect(missing.ok).toBe(false);
  const started = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr" });
  if (!started.ok) throw new Error("unreachable");
  const res = await h["agent:resume"]({ id: started.data.id, surface: "headless" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toMatch(/prompt/);
});

test("agent:resume honors workspace and tab overrides", async () => {
  const calls: string[][] = [];
  const h = fresh({ runner: okRunner(calls) });
  const started = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr", label: "L" });
  if (!started.ok) throw new Error("unreachable");
  calls.length = 0;
  const resumed = await h["agent:resume"]({ id: started.data.id, workspace: "reviews", tab: "⟲ !5" });
  expect(resumed.ok).toBe(true);
  expect(calls.find((c) => c[0] === "workspace" && c[1] === "create")?.[3]).toBe("reviews");
  const tabArg = calls.find((c) => c[0] === "tab" && c[1] === "rename")?.[3]
    ?? calls.find((c) => c[0] === "tab" && c[1] === "create")?.[5];
  expect(tabArg).toBe("⟲ !5");
});

test("agent:list filters by repo", async () => {
  const h = fresh({ runner: okRunner([]) });
  await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "a", surface: "herdr" });
  await h["agent:start"]({ repo: "remote:other%2Fr", cwd: "/tmp/y", prompt: "b", surface: "herdr", tab: "t2" });
  const res = await h["agent:list"]({ repo: REPO });
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.agents).toHaveLength(1);
});
