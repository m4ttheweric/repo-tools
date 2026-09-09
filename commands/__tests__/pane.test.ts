import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { paneAccounts, paneDirectories, paneFocus, paneList, panePeek, renderPaneFocus, paneSend, paneSpawn } from "../pane.ts";

let home: string;
let origHome: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let seen: Array<{ cmd: string; payload: unknown }> = [];
let replies: Record<string, unknown> = {};

beforeEach(() => {
  origHome = process.env.HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "rt-pane-cli-")));
  process.env.HOME = home;
  const sockDir = join(home, ".mattstack", "rt");
  mkdirSync(sockDir, { recursive: true });
  seen = [];
  server = Bun.serve({
    unix: join(sockDir, "rt.sock"),
    async fetch(req) {
      const cmd = new URL(req.url).pathname.slice(1);
      const payload = req.method === "POST" ? await req.json() : {};
      seen.push({ cmd, payload });
      return Response.json(replies[cmd] ?? { ok: false, error: `unknown command: ${cmd}` });
    },
  });
});

afterEach(() => {
  server?.stop(true);
  process.env.HOME = origHome;
});

async function run(fn: (args: string[]) => Promise<void>, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  const errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(" ")); });
  const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit sentinel"); });
  let code = 0;
  try {
    await fn(args);
  } catch (e) {
    if (e instanceof Error && e.message === "process.exit sentinel") code = (exitSpy.mock.calls.at(-1)?.[0] as number | undefined) ?? 1;
    else throw e;
  } finally {
    logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore();
  }
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

const PANE = { paneId: "w1:p1", workspace: "acme", title: "Evaluate codegen", cwd: "/repos/acme", repo: "acme", branch: "main", agentStatus: "idle", presence: { handle: "meg", status: "live", rooms: ["build"] } };

test("pane list --json prints the rows; plain prints one line per pane", async () => {
  const panes = [PANE, { ...PANE, paneId: "w1:p2", presence: undefined, title: "fred" }];
  replies = { "pane:list": { ok: true, data: { panes } } };
  const json = await run(paneList, ["--json"]);
  expect(JSON.parse(json.stdout)).toEqual({ ok: true, panes });
  const plain = await run(paneList, []);
  expect(plain.stdout).toContain("w1:p1");
  expect(plain.stdout).toContain("meg");
  expect(plain.stdout).toContain("not signed in");
});

test("pane list reports herdr unavailable and exits 1", async () => {
  replies = { "pane:list": { ok: false, error: "herdr unavailable: no socket" } };
  const r = await run(paneList, []);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("herdr unavailable");
});

test("pane peek passes the pane id and --lines", async () => {
  replies = { "pane:peek": { ok: true, data: { paneId: "w1:p1", lines: ["a", "b"] } } };
  const r = await run(panePeek, ["w1:p1", "--lines", "2"]);
  expect(seen[0]).toEqual({ cmd: "pane:peek", payload: { paneId: "w1:p1", lines: 2 } });
  expect(r.stdout).toBe("a\nb");
});

test("pane spawn passes every flag and prints the pane and readiness", async () => {
  replies = { "pane:spawn": { ok: true, data: { pane: PANE, ready: true } } };
  const r = await run(paneSpawn, ["--cwd", "/repos/acme", "--account", "Acme", "--model", "claude-fable-5", "--effort", "high", "--workspace", "chat", "--prompt", "read AGENTS.md", "--json"]);
  expect(seen[0]!.payload).toEqual({ cwd: "/repos/acme", account: "Acme", model: "claude-fable-5", effort: "high", workspace: "chat", prompt: "read AGENTS.md" });
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, ready: true, pane: { paneId: "w1:p1" } });
});

test("pane spawn requires --cwd", async () => {
  const r = await run(paneSpawn, []);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--cwd");
});

test("pane accounts and directories render", async () => {
  replies = {
    "pane:accounts": { ok: true, data: { accounts: [{ slot: 1, email: "a@b.c", alias: "A", headroom: "5h 3%" }] } },
    "pane:directories": { ok: true, data: { directories: [{ path: "/repos/chat", repo: "chat" }] } },
  };
  expect((await run(paneAccounts, [])).stdout).toContain("A");
  const d = await run(paneDirectories, ["--q", "chat"]);
  expect(seen.at(-1)).toEqual({ cmd: "pane:directories", payload: { q: "chat" } });
  expect(d.stdout).toContain("/repos/chat");
});

test("pane send forwards the text and HERDR_PANE_ID as callerPane", async () => {
  replies = { "pane:send": { ok: true, data: { paneId: "w1:p2", delivered: "accepted" } } };
  const orig = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = "w1:p1";
  try {
    const r = await run(paneSend, ["w1:p2", "--text", "standup in 5"]);
    expect(seen[0]).toEqual({ cmd: "pane:send", payload: { paneId: "w1:p2", text: "standup in 5", callerPane: "w1:p1" } });
    expect(r.stdout).toBe("w1:p2 accepted");
    expect(r.code).toBe(0);
  } finally {
    if (orig === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = orig;
  }
});

test("pane send from inside a bg pane sends callerPane as a bg: ref", async () => {
  replies = { "pane:send": { ok: true, data: { paneId: "w1:p2", delivered: "accepted" } } };
  const origPane = process.env.HERDR_PANE_ID;
  const origSession = process.env.HERDR_SESSION;
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_SESSION = "bg";
  try {
    await run(paneSend, ["w1:p2", "--text", "standup in 5"]);
    expect(seen[0]).toEqual({ cmd: "pane:send", payload: { paneId: "w1:p2", text: "standup in 5", callerPane: "bg:w1:p1" } });
  } finally {
    if (origPane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = origPane;
    if (origSession === undefined) delete process.env.HERDR_SESSION; else process.env.HERDR_SESSION = origSession;
  }
});

test("pane send prints the outcome and does not exit non-zero on refused", async () => {
  replies = { "pane:send": { ok: true, data: { paneId: "w1:p2", delivered: "refused", reason: "at a prompt" } } };
  const r = await run(paneSend, ["w1:p2", "--text", "x"]);
  expect(r.stdout).toContain("refused");
  expect(r.stdout).toContain("at a prompt");
  expect(r.code).toBe(0);
});

test("pane send --json prints the PaneSendResult and exits 0 on refused", async () => {
  const result = { paneId: "w1:p2", delivered: "refused", reason: "at a prompt" };
  replies = { "pane:send": { ok: true, data: result } };
  const r = await run(paneSend, ["w1:p2", "--text", "x", "--json"]);
  expect(JSON.parse(r.stdout)).toEqual({ ok: true, ...result });
  expect(r.code).toBe(0);
});

test("pane send omits callerPane when HERDR_PANE_ID is unset", async () => {
  replies = { "pane:send": { ok: true, data: { paneId: "w1:p2", delivered: "queued" } } };
  const orig = process.env.HERDR_PANE_ID;
  delete process.env.HERDR_PANE_ID;
  try {
    await run(paneSend, ["w1:p2", "--text", "hi"]);
    expect(seen[0]).toEqual({ cmd: "pane:send", payload: { paneId: "w1:p2", text: "hi" } });
  } finally {
    if (orig !== undefined) process.env.HERDR_PANE_ID = orig;
  }
});

test("pane send --text - reads a multi-line body from stdin", async () => {
  replies = { "pane:send": { ok: true, data: { paneId: "w1:p2", delivered: "accepted" } } };
  const orig = process.env.HERDR_PANE_ID;
  delete process.env.HERDR_PANE_ID;
  const stdinSpy = spyOn(Bun.stdin, "stream").mockImplementation(() => new Response("line one\nline two").body!);
  try {
    await run(paneSend, ["w1:p2", "--text", "-"]);
    expect(seen[0]).toEqual({ cmd: "pane:send", payload: { paneId: "w1:p2", text: "line one\nline two" } });
  } finally {
    stdinSpy.mockRestore();
    if (orig !== undefined) process.env.HERDR_PANE_ID = orig;
  }
});

test("pane send requires a pane and --text", async () => {
  const noPane = await run(paneSend, ["--text", "x"]);
  expect(noPane.code).toBe(1);
  expect(noPane.stderr).toContain("usage");
  const noText = await run(paneSend, ["w1:p2"]);
  expect(noText.code).toBe(1);
  expect(noText.stderr).toContain("usage");
});

test("pane send exits non-zero when the daemon fails", async () => {
  replies = { "pane:send": { ok: false, error: "herdr unavailable: no socket" } };
  const r = await run(paneSend, ["w1:p2", "--text", "x"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("herdr unavailable");
});

// ─── pane focus (Task 7: bg refs / attend) ─────────────────────────────────

test("renderPaneFocus prints focused/not-focused for a plain result", () => {
  expect(renderPaneFocus({ paneId: "w1:p1", focused: true })).toBe("w1:p1 focused");
  expect(renderPaneFocus({ paneId: "w1:p1", focused: false })).toBe("w1:p1 not focused");
});

test("renderPaneFocus prints the attend line when attendTab is set, regardless of focused", () => {
  expect(renderPaneFocus({ paneId: "bg:w1:p1", focused: true, attendTab: "wv:t9" }))
    .toBe("attached bg:w1:p1 in tab wv:t9; detach with ctrl+b q, then close the tab");
});

test("pane focus fills callerWorkspace from HERDR_WORKSPACE_ID and renders the attend line for a bg focus", async () => {
  replies = { "pane:focus": { ok: true, data: { paneId: "bg:w1:p1", focused: true, attendTab: "wv:t9" } } };
  const orig = process.env.HERDR_WORKSPACE_ID;
  process.env.HERDR_WORKSPACE_ID = "wv";
  try {
    const r = await run(paneFocus, ["bg:w1:p1"]);
    expect(seen[0]).toEqual({ cmd: "pane:focus", payload: { paneId: "bg:w1:p1", callerWorkspace: "wv" } });
    expect(r.stdout).toBe("attached bg:w1:p1 in tab wv:t9; detach with ctrl+b q, then close the tab");
    expect(r.code).toBe(0);
  } finally {
    if (orig === undefined) delete process.env.HERDR_WORKSPACE_ID;
    else process.env.HERDR_WORKSPACE_ID = orig;
  }
});

test("pane focus omits callerWorkspace when HERDR_WORKSPACE_ID is unset, and prints the plain focused line", async () => {
  replies = { "pane:focus": { ok: true, data: { paneId: "w1:p1", focused: true } } };
  const orig = process.env.HERDR_WORKSPACE_ID;
  delete process.env.HERDR_WORKSPACE_ID;
  try {
    const r = await run(paneFocus, ["w1:p1"]);
    expect(seen[0]).toEqual({ cmd: "pane:focus", payload: { paneId: "w1:p1" } });
    expect(r.stdout).toBe("w1:p1 focused");
  } finally {
    if (orig !== undefined) process.env.HERDR_WORKSPACE_ID = orig;
  }
});

test("pane focus --json passes attendTab through untouched", async () => {
  replies = { "pane:focus": { ok: true, data: { paneId: "bg:w1:p1", focused: true, attendTab: "wv:t9" } } };
  const r = await run(paneFocus, ["bg:w1:p1", "--json"]);
  expect(JSON.parse(r.stdout)).toEqual({ ok: true, paneId: "bg:w1:p1", focused: true, attendTab: "wv:t9" });
});

test("pane focus exits non-zero when the daemon fails (e.g. no HERDR_WORKSPACE_ID for a bg ref)", async () => {
  replies = { "pane:focus": { ok: false, error: "focus for a background pane must run from a herdr pane; HERDR_WORKSPACE_ID is unset" } };
  const r = await run(paneFocus, ["bg:w1:p1"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("HERDR_WORKSPACE_ID is unset");
});
