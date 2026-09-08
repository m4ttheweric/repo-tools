import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createHerdStore, type HerdStore } from "../herd-store.ts";
import { createGatesStore, type GatesStore } from "../gates-store.ts";
import { createGateHandlers } from "../handlers/gate.ts";
import { createEventsBus } from "../events-bus.ts";
import { createHerdHandlers, type HerdDeps } from "../handlers/herd.ts";

const log = pino({ level: "silent" });
let dirs: string[] = [];
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

export function harness(over: Partial<HerdDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rt-herd-h-"));
  dirs.push(dir);
  const store = createHerdStore({ dbPath: join(dir, "herds.db"), log });
  const gateStore = createGatesStore({ dbPath: join(dir, "gates.db"), log });
  const bus = createEventsBus({ dbPath: join(dir, "events.db"), log });
  const gate = createGateHandlers(gateStore, bus, () => {}, { log });
  const chatCalls: Array<{ verb: string; payload: any }> = [];
  const chat = {
    "chat:sign-in": async (p: any) => { chatCalls.push({ verb: "sign-in", payload: p }); return { ok: true as const, data: { handle: p.baseHandle ?? "shepherd", baseHandle: p.baseHandle ?? "shepherd", sessionId: p.sessionId, room: p.room ?? null } }; },
    "chat:join": async (p: any) => { chatCalls.push({ verb: "join", payload: p }); return { ok: true as const, data: { handle: p.handle, memberCount: 1, unread: 0 } }; },
    "chat:post": async (p: any) => { chatCalls.push({ verb: "post", payload: p }); return { ok: true as const, data: { id: chatCalls.length, recipients: p.mentions ?? [], others: 0 } }; },
    "chat:archive": async (p: any) => { chatCalls.push({ verb: "archive", payload: p }); return { ok: true as const, data: { room: p.room, archivedAt: 1 } }; },
    // A minted herd id carries the wall clock, so the herd's own room is read
    // back off the store; the decoy row sits first so a handler that took the
    // first room instead of the herd's would read 9, not 3.
    "chat:rooms": async (p: any) => {
      chatCalls.push({ verb: "rooms", payload: p });
      const rooms = [
        { room: "herd-other-20260908-120000", unread: 9, memberCount: 2, lastActivity: 0 },
        ...store.list().map((hd) => ({ room: hd.room, unread: 3, memberCount: 2, lastActivity: 0 })),
      ];
      return { ok: true as const, data: { rooms } };
    },
  } as unknown as HerdDeps["chat"];
  const agentCalls: any[] = [];
  const agent = {
    "agent:start": async (p: any) => { agentCalls.push(p); return { ok: true as const, data: { id: "ag-1", sessionId: "sess-w1", paneId: "w9:p1", tabId: "w9:t1", workspaceId: "w9", repo: p.repo, cwd: p.cwd, surface: "herdr", provider: "claude" } }; },
  } as unknown as HerdDeps["agent"];
  const worktreeCalls: any[] = [];
  const worktree = {
    "worktree:provision": async (p: any) => { worktreeCalls.push({ verb: "provision", p }); return { ok: true, data: { tree: p.branch, path: `/w/${p.branch}`, branch: p.branch, wasOnDeck: false, readyAt: null, branchState: "new" } }; },
    "worktree:dispose": async (p: any) => { worktreeCalls.push({ verb: "dispose", p }); return { ok: true, data: { disposed: [p.tree], refused: [], recoverable: [] } }; },
  };
  const herdrCalls: string[][] = [];
  const deps: HerdDeps = {
    store, gateStore, gate, chat, agent, worktree,
    runWorktree: () => null,
    presenceHandleForSession: () => null,
    herdr: (async (method: string) => {
      if (method === "session.snapshot") return { ok: true, result: { snapshot: { panes: [{ pane_id: "w9:p1", agent_status: "working" }] } } };
      return { ok: false, code: "invalid_request", message: method };
    }) as unknown as HerdDeps["herdr"],
    herdrRunnerFor: () => async (args) => { herdrCalls.push(args); return { stdout: "{}", exitCode: 0 }; },
    lifecycle: { connected: () => true, watch: () => {} },
    hidden: { socketPath: () => "/tmp/hidden.sock", ensure: async () => "/tmp/hidden.sock", up: async () => false, stop: async () => {} },
    jobsRoot: join(dir, "herds"),
    log,
    ...over,
  };
  const h = createHerdHandlers(deps);
  return { h, store, gateStore, gate, chatCalls, agentCalls, worktreeCalls, herdrCalls, dir };
}

const START = { name: "demo", repo: "gh:m4ttstack/rt", session: "sess-shep" };

describe("herd:start", () => {
  test("mints the id, records the room and workspace, signs in, joins, subscribes", async () => {
    const { h, store, gateStore, chatCalls } = harness();
    const res = await h["herd:start"](START);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.herd).toMatch(/^demo-\d{8}-\d{6}$/);
    expect(res.data.room).toBe(`herd-${res.data.herd}`);
    expect(res.data.workspace).toBe(`herd: ${res.data.herd}`);
    expect(res.data.hidden).toBe(false);
    const row = store.get(res.data.herd)!;
    expect(row).toMatchObject({ shepherdSession: "sess-shep", shepherdHandle: "shepherd", herdrSocket: null, status: "active" });
    expect(chatCalls.map((c) => c.verb)).toEqual(["sign-in", "join"]);
    expect(chatCalls[0]!.payload).toMatchObject({ sessionId: "sess-shep", baseHandle: "shepherd", noRoom: true });
    expect(chatCalls[1]!.payload).toMatchObject({ room: res.data.room, handle: "shepherd" });
    const subs = gateStore.subscriptions({ live: true });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ subjectPrefix: `herd:${res.data.herd}/`, session: "sess-shep" });
    expect(res.data.subscription).toBe(subs[0]!.id);
  });

  test("rejects an invalid name and a missing session", async () => {
    const { h } = harness();
    expect((await h["herd:start"]({ ...START, name: "Bad Name" })).ok).toBe(false);
    expect((await h["herd:start"]({ ...START, session: "" })).ok).toBe(false);
  });

  test("a session that already holds a handle is not re-signed-in; the herd uses that handle", async () => {
    const { h, store, chatCalls } = harness({ presenceHandleForSession: (s) => (s === "sess-shep" ? "kai" : null) });
    const res = await h["herd:start"](START);
    if (!res.ok) throw new Error(res.error);
    expect(res.data.handle).toBe("kai");
    expect(store.get(res.data.herd)!.shepherdHandle).toBe("kai");
    expect(chatCalls.map((c) => c.verb)).toEqual(["join"]);
    expect(chatCalls[0]!.payload).toMatchObject({ room: res.data.room, handle: "kai" });
  });

  test("two starts with the same name in the same second get distinct ids", async () => {
    const { h } = harness();
    const a = await h["herd:start"](START);
    const b = await h["herd:start"](START);
    if (!a.ok || !b.ok) throw new Error("start failed");
    expect(a.data.herd).not.toBe(b.data.herd);
    expect(b.data.herd).toMatch(/^demo-\d{8}-\d{6}(-2)?$/);
  });

  test("--hidden ensures the hidden server, records its socket, and asks lifecycle to watch it", async () => {
    const watched: string[] = [];
    const { h, store } = harness({ lifecycle: { connected: () => true, watch: (s) => { watched.push(s); } } });
    const res = await h["herd:start"]({ ...START, hidden: true });
    if (!res.ok) throw new Error(res.error);
    expect(store.get(res.data.herd)).toMatchObject({ hidden: true, herdrSocket: "/tmp/hidden.sock" });
    expect(watched).toEqual(["/tmp/hidden.sock"]);
  });
});

describe("herd:resume / status / close", () => {
  async function started(over: Partial<HerdDeps> = {}) {
    const hx = harness(over);
    const res = await hx.h["herd:start"](START);
    if (!res.ok) throw new Error(res.error);
    return { ...hx, herd: res.data.herd, room: res.data.room };
  }

  test("resume re-subscribes with the new session and returns gates, unread, status", async () => {
    const { h, store, gateStore, herd } = await started();
    store.upsertJob({ herd, name: "cv-1", worktree: "/w/cv-1", handle: "cv-1", status: "active", pane: "w9:p1" });
    gateStore.open({ subject: `herd:${herd}/cv-1`, kind: "question", questions: [{ id: "q", label: "?", multi: false, options: ["a", "b"] }] });
    const res = await h["herd:resume"]({ herd, session: "sess-shep-2" });
    if (!res.ok) throw new Error(res.error);
    expect(store.get(herd)!.shepherdSession).toBe("sess-shep-2");
    expect(gateStore.subscriptions({ live: true, session: "sess-shep-2" })).toHaveLength(1);
    expect(res.data.gates).toHaveLength(1);
    expect(res.data.unread).toBe(3);
    expect(res.data.status.jobs[0]).toMatchObject({ name: "cv-1", openGate: res.data.gates[0]!.id, paneStatus: "working" });
  });

  test("resume on an unknown herd fails", async () => {
    const { h } = harness();
    expect((await h["herd:resume"]({ herd: "nope", session: "s" })).ok).toBe(false);
  });

  test("status reports lifecycleConnected, hiddenUp null for a visible herd, and the shepherd's subscription row", async () => {
    const { h, gateStore, herd } = await started();
    const res = await h["herd:status"]({ herd });
    if (!res.ok) throw new Error(res.error);
    expect(res.data).toMatchObject({ lifecycleConnected: true, hiddenUp: null, unread: 3 });
    const sub = gateStore.subscriptions({ live: true })[0]!;
    expect(res.data.subscription).toEqual({ id: sub.id, dead: false, lastDelivery: null });
  });

  test("status surfaces an answered gate whose nudge never landed", async () => {
    const { h, store, gateStore, herd } = await started();
    store.upsertJob({ herd, name: "cv-1", worktree: "/w", handle: "cv-1", status: "active", pane: "w9:p1" });
    const g = gateStore.open({ subject: `herd:${herd}/cv-1`, kind: "question", questions: [{ id: "q", label: "?", multi: false, options: ["a"] }], nudge: { session: "sess-w1" } }).row.id;
    store.setJobStatus(herd, "cv-1", "at-gate", { lastGate: g });
    gateStore.answer(g, { q: "a" }, "shepherd");
    gateStore.markDelivery(g, "dead-pane");
    const res = await h["herd:status"]({ herd });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.jobs[0]).toMatchObject({ openGate: null, lastGateStatus: "answered", lastGateDelivery: "dead-pane" });
  });

  test("close closes the pane on the herd's socket and marks the job closed", async () => {
    const { h, store, herd, herdrCalls } = await started();
    store.upsertJob({ herd, name: "cv-1", worktree: "/w/cv-1", handle: "cv-1", status: "active", pane: "w9:p1" });
    const res = await h["herd:close"]({ herd, job: "cv-1" });
    expect(res.ok).toBe(true);
    expect(herdrCalls).toContainEqual(["pane", "close", "w9:p1"]);
    expect(store.getJob(herd, "cv-1")!.status).toBe("closed");
  });

  test("close on a job with no pane still marks it closed", async () => {
    const { h, store, herd, herdrCalls } = await started();
    store.upsertJob({ herd, name: "cv-1", worktree: "/w/cv-1", handle: "cv-1", status: "crashed" });
    const res = await h["herd:close"]({ herd, job: "cv-1" });
    expect(res.ok).toBe(true);
    expect(herdrCalls).toEqual([]);
    expect(store.getJob(herd, "cv-1")!.status).toBe("closed");
  });
});
