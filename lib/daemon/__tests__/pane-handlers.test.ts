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
    workspaces: [{ workspace_id: "w1", label: "assured", focused: false }],
    tabs: [],
    layouts: [],
    agents: [],
    panes: [
      { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "idle", cwd: "/tmp/assured", foreground_cwd: "/tmp/assured", terminal_title_stripped: "Evaluate codegen", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "sess-signed" }, revision: 1 },
      { pane_id: "w1:p2", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "working", cwd: "/tmp/other", terminal_title_stripped: "fred", revision: 1 },
      { pane_id: "w1:p3", terminal_id: "t3", workspace_id: "w1", tab_id: "w1:t2", focused: false, agent_status: "unknown", cwd: "/tmp", revision: 1 },
    ],
  },
};

function harness(handler: FakeHerdrHandler, extra: { repoIndex?: Record<string, string> } = {}) {
  const { sock, seen, stop } = fakeHerdr(handler);
  stops.push(stop);
  const db = freshDb();
  const herdr: typeof herdrRequest = (method, params, opts) => herdrRequest(method, params, { ...opts, sockPath: sock });
  const exec = async () => ({ stdout: "feat/branch\n", stderr: "", exitCode: 0 });
  const chat = createChatHandlers({ db, emitEvent: () => 0 });
  const pane = createPaneHandlers({ db, repoIndex: () => extra.repoIndex ?? {}, herdr, exec, now: Date.now });
  return { db, seen, chat, pane };
}

test("pane:list lists only claude panes, joined to presence by session id, with rooms", async () => {
  const { chat, pane } = harness((method) => (method === "session.snapshot" ? SNAPSHOT : new HerdrFakeError("invalid_request", method)));
  const signed = await chat["chat:sign-in"]({ sessionId: "sess-signed", baseHandle: "meg", cwd: "/tmp/assured", repo: "assured", branch: "main", pane: "w1:p1" });
  if (!signed.ok) throw new Error(signed.error);
  await chat["chat:join"]({ room: "build", handle: signed.data.handle });

  const res = await pane["pane:list"]({});
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.panes.map((p) => p.paneId)).toEqual(["w1:p1", "w1:p2"]);
  const first = res.data.panes[0]!;
  expect(first).toMatchObject({ workspace: "assured", title: "Evaluate codegen", cwd: "/tmp/assured", repo: "assured", branch: "main", agentStatus: "idle", sessionId: "sess-signed" });
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
  expect(unsigned.branch).toBe("feat/branch");
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
