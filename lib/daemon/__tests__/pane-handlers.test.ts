import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { HERDR_UNAVAILABLE, herdrRequest } from "../../herdr/client.ts";
import { fakeHerdr, HerdrFakeError, type FakeHerdrHandler } from "../../herdr/__tests__/fake-herdr.ts";
import { openStateDb } from "../../state/index.ts";
import { createChatHandlers } from "../handlers/chat.ts";
import { createPaneHandlers } from "../handlers/pane.ts";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops.length = 0;
});

let n = 0;
function freshDb() {
  return openStateDb(join(tmpdir(), `pane-h-${process.pid}-${n++}.db`));
}

const SNAPSHOT = {
  type: "session_snapshot",
  snapshot: {
    version: "0.8.0",
    protocol: 19,
    workspaces: [{ workspace_id: "w1", label: "acme", focused: false }],
    tabs: [],
    layouts: [],
    agents: [],
    panes: [
      { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "idle", cwd: "/tmp/acme", foreground_cwd: "/tmp/acme", terminal_title_stripped: "Evaluate codegen", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "sess-signed" }, revision: 1 },
      { pane_id: "w1:p2", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "working", cwd: "/tmp/other", terminal_title_stripped: "fred", revision: 1 },
      { pane_id: "w1:p3", terminal_id: "t3", workspace_id: "w1", tab_id: "w1:t2", focused: false, agent_status: "unknown", cwd: "/tmp", revision: 1 },
    ],
  },
};

const CSWAP_EXEC = async (argv: [string, ...string[]]) =>
  argv[1] === "list" ? { stdout: "Accounts:\n  1: me@x.y [Me]\n", stderr: "", exitCode: 0 } : { stdout: "main\n", stderr: "", exitCode: 0 };

function harness(handler: FakeHerdrHandler, extra: { repoIndex?: Record<string, string>; now?: () => number } = {}) {
  const { sock, seen, stop } = fakeHerdr(handler);
  stops.push(stop);
  const db = freshDb();
  const herdr: typeof herdrRequest = (method, params, opts) => herdrRequest(method, params, { ...opts, sockPath: sock });
  const exec = CSWAP_EXEC;
  const chat = createChatHandlers({ db, emitEvent: () => 0 });
  const pane = createPaneHandlers({ db, repoIndex: () => extra.repoIndex ?? {}, herdr, exec, now: extra.now ?? Date.now });
  return { db, seen, chat, pane };
}

test("pane:list lists only claude panes, joined to presence by session id, with rooms", async () => {
  const { chat, pane } = harness((method) => (method === "session.snapshot" ? SNAPSHOT : new HerdrFakeError("invalid_request", method)));
  const signed = await chat["chat:sign-in"]({ sessionId: "sess-signed", baseHandle: "meg", cwd: "/tmp/acme", repo: "acme", branch: "main", pane: "w1:p1" });
  if (!signed.ok) throw new Error(signed.error);
  await chat["chat:join"]({ room: "build", handle: signed.data.handle });

  const res = await pane["pane:list"]({});
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.panes.map((p) => p.paneId)).toEqual(["w1:p1", "w1:p2"]);
  const first = res.data.panes[0]!;
  expect(first).toMatchObject({ workspace: "acme", title: "Evaluate codegen", cwd: "/tmp/acme", repo: "acme", branch: "main", agentStatus: "idle", sessionId: "sess-signed" });
  expect(first.presence).toMatchObject({ handle: "meg", rooms: ["build"] });
  expect(first.presence!.status).not.toBe("offline");
});

test("pane:list falls back to the presence row's pane id when herdr has no session id", async () => {
  const { chat, pane } = harness((method) => (method === "session.snapshot" ? SNAPSHOT : new HerdrFakeError("invalid_request", method)));
  const signed = await chat["chat:sign-in"]({ sessionId: "sess-by-pane", baseHandle: "fred", cwd: "/tmp/other", pane: "w1:p2" });
  if (!signed.ok) throw new Error(signed.error);
  const res = await pane["pane:list"]({});
  if (!res.ok) throw new Error(res.error);
  expect(res.data.panes.find((p) => p.paneId === "w1:p2")!.presence?.handle).toBe("fred");
});

test("pane:list derives repo and branch for an unsigned pane without touching the presence table", async () => {
  const { pane } = harness((method) => (method === "session.snapshot" ? SNAPSHOT : new HerdrFakeError("invalid_request", method)));
  const res = await pane["pane:list"]({});
  if (!res.ok) throw new Error(res.error);
  const unsigned = res.data.panes.find((p) => p.paneId === "w1:p2")!;
  expect(unsigned.presence).toBeUndefined();
  expect(unsigned.branch).toBe("main");
  expect(unsigned.repo).toBeUndefined();
});

test("pane:list sorts listening, idle, deaf, then not signed in", async () => {
  const { chat, pane } = harness((method) => (method === "session.snapshot" ? SNAPSHOT : new HerdrFakeError("invalid_request", method)));
  const signed = await chat["chat:sign-in"]({ sessionId: "sess-p2", baseHandle: "fred", pane: "w1:p2" });
  if (!signed.ok) throw new Error(signed.error);
  const res = await pane["pane:list"]({});
  if (!res.ok) throw new Error(res.error);
  expect(res.data.panes.map((p) => p.paneId)).toEqual(["w1:p2", "w1:p1"]);
});

test("pane:list is herdr unavailable when the socket is missing", async () => {
  const db = freshDb();
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: join(tmpdir(), "absent-herdr.sock") });
  const pane = createPaneHandlers({ db, repoIndex: () => ({}), herdr });
  const res = await pane["pane:list"]({});
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.startsWith(HERDR_UNAVAILABLE)).toBe(true);
});

test("pane:peek reads the visible screen and drops trailing blank lines", async () => {
  const { pane, seen } = harness((method) =>
    method === "pane.read"
      ? { type: "pane_read", read: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", source: "visible", format: "text", text: "⏺ Read(x)\n  ⎿ 12 lines\n❯ \n\n\n", revision: 0, truncated: false } }
      : new HerdrFakeError("invalid_request", method),
  );
  const res = await pane["pane:peek"]({ paneId: "w1:p1", lines: 8 });
  if (!res.ok) throw new Error(res.error);
  expect(res.data).toEqual({ paneId: "w1:p1", lines: ["⏺ Read(x)", "  ⎿ 12 lines", "❯ "] });
  // fakeHerdr's seen entries also carry a per-request `id`; match the rest structurally.
  expect(seen[0]).toMatchObject({ method: "pane.read", params: { pane_id: "w1:p1", source: "visible", lines: 8 } });
});

test("pane:peek passes herdr's pane_not_found through as an error", async () => {
  const { pane } = harness(() => new HerdrFakeError("pane_not_found", "pane not found"));
  const res = await pane["pane:peek"]({ paneId: "w9:p9" });
  expect(res).toEqual({ ok: false, error: "pane_not_found: pane not found" });
});

test("pane:accounts parses cswap list through the injected exec", async () => {
  const db = freshDb();
  const exec = async (argv: [string, ...string[]]) =>
    argv[1] === "list"
      ? { stdout: "Accounts:\n  1: a@b.c [A]\n     └ 5h: 3%\n", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 1 };
  const pane = createPaneHandlers({ db, repoIndex: () => ({}), exec });
  const res = await pane["pane:accounts"]({});
  expect(res).toEqual({ ok: true, data: { accounts: [{ slot: 1, email: "a@b.c", alias: "A", headroom: "5h 3%" }] } });
});

test("pane:directories lists indexed repos and their registered worktrees, filtered by q", async () => {
  const db = freshDb();
  const pane = createPaneHandlers({
    db,
    repoIndex: () => ({ "remote:gitlab.com%2Facme%2Facme-dev": "/repos/acme-dev", "remote:github.com%2Fm%2Fchat": "/repos/chat" }),
    registry: (name) => (name.endsWith("acme-dev") ? [{ path: "/repos/acme-dev-wt-1", branch: "feat/one" }] : []),
  });
  const all = await pane["pane:directories"]({});
  if (!all.ok) throw new Error(all.error);
  expect(all.data.directories).toEqual([
    { path: "/repos/acme-dev", repo: "acme-dev" },
    { path: "/repos/acme-dev-wt-1", repo: "acme-dev", branch: "feat/one" },
    { path: "/repos/chat", repo: "chat" },
  ]);
  const filtered = await pane["pane:directories"]({ q: "wt-1" });
  if (!filtered.ok) throw new Error(filtered.error);
  expect(filtered.data.directories.map((d) => d.path)).toEqual(["/repos/acme-dev-wt-1"]);
});

test("pane:directories keeps other repos when one repo's registry throws", async () => {
  const db = freshDb();
  const pane = createPaneHandlers({
    db,
    repoIndex: () => ({ "remote:gitlab.com%2Facme%2Facme-dev": "/repos/acme-dev", "remote:github.com%2Fm%2Fchat": "/repos/chat" }),
    registry: (name) => {
      if (name.endsWith("acme-dev")) throw new Error("boom");
      return [];
    },
  });
  const res = await pane["pane:directories"]({});
  if (!res.ok) throw new Error(res.error);
  expect(res.data.directories).toEqual([
    { path: "/repos/acme-dev", repo: "acme-dev" },
    { path: "/repos/chat", repo: "chat" },
  ]);
});

function spawnFake(script: { statuses: string[]; screen?: string; agentGetFailures?: number }) {
  let getCalls = 0;
  let waitCalls = 0;
  const calls: string[] = [];
  const paneInfo = (status: string) => ({ pane_id: "w2:p7", terminal_id: "t7", workspace_id: "w2", tab_id: "w2:t3", focused: false, agent: "claude", agent_status: status, cwd: "/repos/acme-dev", terminal_title_stripped: "claude", revision: 3 });
  const handler: FakeHerdrHandler = (method, params) => {
    calls.push(method);
    switch (method) {
      case "workspace.list":
        return { type: "workspace_list", workspaces: [{ workspace_id: "w2", label: "chat", focused: false }] };
      case "workspace.create":
        return { type: "workspace_created", workspace: { workspace_id: "w3", label: params.label }, tab: { tab_id: "w3:t1" }, root_pane: paneInfo("unknown") };
      case "tab.create":
        return { type: "tab_created", tab: { tab_id: "w2:t3", workspace_id: "w2", label: params.label }, root_pane: paneInfo("unknown") };
      case "pane.send_input":
      case "pane.send_keys":
        return { type: "ok" };
      case "agent.get":
        if (getCalls++ < (script.agentGetFailures ?? 0)) return new HerdrFakeError("agent_not_found", "agent target w2:p7 not found");
        return { type: "agent_info", agent: paneInfo(script.statuses[Math.min(waitCalls, script.statuses.length - 1)]!) };
      case "agent.wait": {
        const status = script.statuses[Math.min(waitCalls++, script.statuses.length - 1)]!;
        if (status === "timeout") return new HerdrFakeError("timeout", "timed out waiting for agent status");
        return { type: "agent_info", agent: paneInfo(status) };
      }
      case "pane.read":
        return { type: "pane_read", read: { pane_id: "w2:p7", workspace_id: "w2", tab_id: "w2:t3", source: "visible", format: "text", text: script.screen ?? "", revision: 0, truncated: false } };
      case "agent.prompt":
        return { type: "agent_prompted", agent: paneInfo("working") };
      case "pane.get":
        return { type: "pane_info", pane: paneInfo(script.statuses[script.statuses.length - 1] === "timeout" ? "unknown" : script.statuses[script.statuses.length - 1]!) };
      case "session.snapshot":
        return { type: "session_snapshot", snapshot: { workspaces: [{ workspace_id: "w2", label: "chat" }], panes: [], tabs: [], layouts: [], agents: [], version: "0.8.0", protocol: 19 } };
      default:
        return new HerdrFakeError("invalid_request", method);
    }
  };
  return { handler, calls };
}

test("pane:spawn creates a tab in the chat workspace, launches claude, waits for idle and returns the pane ready", async () => {
  const { handler, calls } = spawnFake({ statuses: ["idle"], agentGetFailures: 2 });
  const { pane, seen } = harness(handler);
  const res = await pane["pane:spawn"]({ cwd: "/repos/acme-dev", account: "Me", model: "claude-fable-5", effort: "high" });
  if (!res.ok) throw new Error(res.error);
  expect(res.data.ready).toBe(true);
  expect(res.data.pane).toMatchObject({ paneId: "w2:p7", workspace: "chat", cwd: "/repos/acme-dev", agentStatus: "idle" });
  const tab = seen.find((s) => s.method === "tab.create")!;
  expect(tab.params).toMatchObject({ workspace_id: "w2", label: "acme-dev", cwd: "/repos/acme-dev", focus: false });
  const input = seen.find((s) => s.method === "pane.send_input")!;
  // shellQuote leaves strings matching ^[a-zA-Z0-9_./:@=-]+$ bare; only a value outside that set gets quotes.
  expect(input.params.text).toBe("cd /repos/acme-dev && cswap run Me --share-history -- claude --model claude-fable-5 --effort high");
  expect(input.params.keys).toEqual(["enter"]);
  expect(calls.filter((c) => c === "agent.get").length).toBeGreaterThanOrEqual(3);
  expect(calls).not.toContain("workspace.create");
});

test("pane:spawn creates the workspace when the label is missing and launches plain claude without an account", async () => {
  const { handler, calls } = spawnFake({ statuses: ["idle"] });
  const { pane, seen } = harness(handler);
  const res = await pane["pane:spawn"]({ cwd: "/repos/chat", workspace: "fleet" });
  if (!res.ok) throw new Error(res.error);
  expect(calls).toContain("workspace.create");
  expect(seen.find((s) => s.method === "workspace.create")!.params).toMatchObject({ label: "fleet", focus: false });
  expect(seen.find((s) => s.method === "pane.send_input")!.params.text).toBe("cd /repos/chat && claude");
});

test("pane:spawn quotes a cwd with a space", async () => {
  const { handler } = spawnFake({ statuses: ["idle"] });
  const { pane, seen } = harness(handler);
  const res = await pane["pane:spawn"]({ cwd: "/repos/my repo" });
  if (!res.ok) throw new Error(res.error);
  expect(seen.find((s) => s.method === "pane.send_input")!.params.text).toBe("cd '/repos/my repo' && claude");
});

test("pane:spawn answers the trust dialog once, then sends the opening prompt", async () => {
  const { handler, calls } = spawnFake({ statuses: ["blocked", "idle"], screen: "Do you trust the files in this folder?" });
  const { pane, seen } = harness(handler);
  const res = await pane["pane:spawn"]({ cwd: "/repos/chat", prompt: "read AGENTS.md" });
  if (!res.ok) throw new Error(res.error);
  expect(res.data.ready).toBe(true);
  expect(calls.filter((c) => c === "pane.send_keys")).toHaveLength(1);
  expect(seen.find((s) => s.method === "agent.prompt")!.params).toMatchObject({ target: "w2:p7", text: "read AGENTS.md", wait: { until: ["working"], timeout_ms: 5000 } });
});

test("pane:spawn returns ready:false with the pane when idle never arrives, and does not send the prompt", async () => {
  const { handler, calls } = spawnFake({ statuses: ["timeout"] });
  const { pane } = harness(handler);
  const res = await pane["pane:spawn"]({ cwd: "/repos/chat", prompt: "hi" });
  if (!res.ok) throw new Error(res.error);
  expect(res.data.ready).toBe(false);
  expect(res.data.pane.paneId).toBe("w2:p7");
  expect(calls).not.toContain("agent.prompt");
});

test("pane:spawn stops polling for registration at the wall-clock budget, not a fixed attempt count", async () => {
  // A slow-but-alive herdr: the agent never registers, and the clock jumps past
  // the budget after the first poll. A fixed attempt count would poll dozens of
  // times (each agent.get up to the 5s socket timeout); the deadline stops after one.
  let reads = 0;
  const now = () => (reads++ < 2 ? 1_000 : 1_000 + 10_000_000);
  const { handler, calls } = spawnFake({ statuses: ["idle"], agentGetFailures: 999 });
  const { pane } = harness(handler, { now });
  const res = await pane["pane:spawn"]({ cwd: "/repos/chat" });
  if (!res.ok) throw new Error(res.error);
  expect(res.data.ready).toBe(false);
  expect(calls.filter((c) => c === "agent.get").length).toBeLessThanOrEqual(2);
});

// S087: pane:spawn's worst-case daemon budget (register + idle wait + trust
// retry + prompt) exceeds rt-client's client-side timeout — the client
// gives up and reports failure while the daemon keeps working, so a retry
// spawns a second claude pane in the same cwd. Once the caller's own
// AbortSignal fires, the handler must stop spending further budget and
// return the pane it already created instead of continuing the full flow.
test("pane:spawn stops after tab creation once the caller's AbortSignal fires, returning the pane already created", async () => {
  const controller = new AbortController();
  const { handler, calls } = spawnFake({ statuses: ["idle"] });
  const abortingHandler: typeof handler = (method, params) => {
    if (method === "pane.send_input") controller.abort();
    return handler(method, params);
  };
  const { pane } = harness(abortingHandler);
  const res = await pane["pane:spawn"]({ cwd: "/repos/chat" }, controller.signal);
  if (!res.ok) throw new Error(res.error);
  expect(res.data.pane.paneId).toBe("w2:p7");
  expect(res.data.ready).toBe(false);
  expect(calls).not.toContain("agent.get");
  expect(calls).not.toContain("agent.wait");
});

test("pane:spawn refuses an unknown cswap account before touching herdr", async () => {
  const { handler, calls } = spawnFake({ statuses: ["idle"] });
  const { pane } = harness(handler);
  const res = await pane["pane:spawn"]({ cwd: "/repos/chat", account: "nobody" });
  expect(res).toEqual({ ok: false, error: 'unknown cswap account "nobody"' });
  expect(calls).toHaveLength(0);
});
