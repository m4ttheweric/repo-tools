import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync } from "fs";
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
  // One ordered log across both fakes, for the cases where what matters is
  // which call came first (chat identity before the trust wait).
  const order: string[] = [];
  const chat = {
    "chat:sign-in": async (p: any) => { chatCalls.push({ verb: "sign-in", payload: p }); order.push("chat:sign-in"); return { ok: true as const, data: { handle: p.baseHandle ?? "shepherd", baseHandle: p.baseHandle ?? "shepherd", sessionId: p.sessionId, room: p.room ?? null } }; },
    "chat:join": async (p: any) => { chatCalls.push({ verb: "join", payload: p }); order.push("chat:join"); return { ok: true as const, data: { handle: p.handle, memberCount: 1, unread: 0 } }; },
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
  // Socket-side herdr: `session.snapshot` for status, plus the trust-dialog
  // sequence. `trust` is the knob set: how many `agent.get` calls fail before
  // the agent registers, what `agent.wait` settles at, and what `pane.read`
  // hands back.
  const socketCalls: Array<{ method: string; params: any; sock: any }> = [];
  const screen = { text: "$ claude\nworking...\n" };
  const trust = { registerFailures: 0, waitOk: true, waitStatus: "blocked" };
  const deps: HerdDeps = {
    store, gateStore, gate, chat, agent, worktree,
    runWorktree: () => null,
    presenceHandleForSession: () => null,
    herdr: (async (method: string, params: any, o: any) => {
      socketCalls.push({ method, params, sock: o?.sockPath ?? null });
      order.push(`herdr:${method}`);
      if (method === "session.snapshot") return { ok: true, result: { snapshot: { panes: [{ pane_id: "w9:p1", agent_status: "working" }] } } };
      if (method === "agent.get") {
        if (trust.registerFailures > 0) { trust.registerFailures -= 1; return { ok: false, code: "not_found", message: "no agent" }; }
        return { ok: true, result: { agent: { agent_status: "working" } } };
      }
      if (method === "agent.wait") {
        return trust.waitOk ? { ok: true, result: { agent: { agent_status: trust.waitStatus } } } : { ok: false, code: "timeout", message: "still working" };
      }
      if (method === "pane.read") return { ok: true, result: { read: screen } };
      if (method === "pane.send_keys") return { ok: true, result: {} };
      return { ok: false, code: "invalid_request", message: method };
    }) as unknown as HerdDeps["herdr"],
    herdrRunnerFor: (socket: string | null) => {
      const allHerds = store.list();
      return async (args: string[]) => {
        herdrCalls.push(args);
        if (args[0] === "workspace" && args[1] === "list") {
          const workspaces = allHerds.map((h) => ({ workspace_id: h.id, label: h.workspace }));
          return { stdout: JSON.stringify({ result: { workspaces } }), exitCode: 0 };
        }
        return { stdout: "{}", exitCode: 0 };
      };
    },
    lifecycle: { connected: () => true, watch: () => {} },
    hidden: { socketPath: () => "/tmp/hidden.sock", ensure: async () => "/tmp/hidden.sock", up: async () => false, stop: async () => {} },
    jobsRoot: join(dir, "herds"),
    log,
    ...over,
  };
  const h = createHerdHandlers(deps);
  return { h, store, gateStore, gate, chatCalls, agentCalls, worktreeCalls, herdrCalls, socketCalls, order, screen, trust, dir };
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
    store.upsertJob({ herd, name: "job-a", worktree: "/w/job-a", handle: "job-a", status: "active", pane: "w9:p1" });
    gateStore.open({ subject: `herd:${herd}/job-a`, kind: "question", questions: [{ id: "q", label: "?", multi: false, options: ["a", "b"] }] });
    const res = await h["herd:resume"]({ herd, session: "sess-shep-2" });
    if (!res.ok) throw new Error(res.error);
    expect(store.get(herd)!.shepherdSession).toBe("sess-shep-2");
    expect(gateStore.subscriptions({ live: true, session: "sess-shep-2" })).toHaveLength(1);
    expect(res.data.gates).toHaveLength(1);
    expect(res.data.unread).toBe(3);
    expect(res.data.status.jobs[0]).toMatchObject({ name: "job-a", openGate: res.data.gates[0]!.id, paneStatus: "working" });
  });

  test("resume on an unknown herd fails", async () => {
    const { h } = harness();
    expect((await h["herd:resume"]({ herd: "nope", session: "s" })).ok).toBe(false);
  });

  test("resume signs the new session in under the stored handle's base and joins the room", async () => {
    const { h, store, chatCalls, herd, room } = await started();
    store.setShepherd(herd, { session: "sess-shep", handle: "shepherd-3" });
    chatCalls.length = 0;
    const res = await h["herd:resume"]({ herd, session: "sess-shep-2" });
    if (!res.ok) throw new Error(res.error);
    const identity = chatCalls.filter((c) => c.verb !== "rooms");
    expect(identity.map((c) => c.verb)).toEqual(["sign-in", "join"]);
    expect(identity[0]!.payload).toMatchObject({ sessionId: "sess-shep-2", baseHandle: "shepherd", noRoom: true });
    expect(identity[1]!.payload).toMatchObject({ room, handle: "shepherd" });
    expect(res.data.handle).toBe("shepherd");
    expect(store.get(herd)!.shepherdHandle).toBe("shepherd");
  });

  test("resume on a session that already holds a handle joins as that handle without signing in", async () => {
    const { h, store, chatCalls, herd, room } = await started({ presenceHandleForSession: (s) => (s === "sess-shep-2" ? "kai" : null) });
    chatCalls.length = 0;
    const res = await h["herd:resume"]({ herd, session: "sess-shep-2" });
    if (!res.ok) throw new Error(res.error);
    const identity = chatCalls.filter((c) => c.verb !== "rooms");
    expect(identity.map((c) => c.verb)).toEqual(["join"]);
    expect(identity[0]!.payload).toMatchObject({ room, handle: "kai" });
    expect(res.data.handle).toBe("kai");
    expect(store.get(herd)!.shepherdHandle).toBe("kai");
  });

  test("status reports lifecycleConnected, hiddenUp null for a visible herd, and the shepherd's subscription row", async () => {
    const { h, gateStore, herd } = await started();
    const res = await h["herd:status"]({ herd });
    if (!res.ok) throw new Error(res.error);
    expect(res.data).toMatchObject({ lifecycleConnected: true, hiddenUp: null, unread: 3 });
    const sub = gateStore.subscriptions({ live: true })[0]!;
    expect(res.data.subscription).toEqual({ id: sub.id, dead: false, lastDelivery: null });
  });

  // A malformed-but-ok session.snapshot reply (missing snapshot, or panes
  // not an array) must degrade to an empty pane map, never throw through
  // herd:status.
  test("status treats a malformed session.snapshot reply as no panes instead of throwing", async () => {
    const { h, store, herd } = await started({
      herdr: (async (method: string) => (method === "session.snapshot" ? { ok: true, result: {} } : { ok: false, code: "invalid_request", message: method })) as unknown as HerdDeps["herdr"],
    });
    store.upsertJob({ herd, name: "job-a", worktree: "/w", handle: "job-a", status: "active", pane: "w9:p1" });
    const res = await h["herd:status"]({ herd });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.jobs[0]).toMatchObject({ name: "job-a", paneStatus: null });
  });

  test("status reports a dead subscription rather than hiding it as missing", async () => {
    const { h, gateStore, herd } = await started();
    const sub = gateStore.subscriptions({ live: true })[0]!;
    gateStore.markSubscriptionDead(sub.id);
    const res = await h["herd:status"]({ herd });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.subscription).toMatchObject({ id: sub.id, dead: true });
  });

  test("status surfaces an answered gate whose nudge never landed", async () => {
    const { h, store, gateStore, herd } = await started();
    store.upsertJob({ herd, name: "job-a", worktree: "/w", handle: "job-a", status: "active", pane: "w9:p1" });
    const g = gateStore.open({ subject: `herd:${herd}/job-a`, kind: "question", questions: [{ id: "q", label: "?", multi: false, options: ["a"] }], nudge: { session: "sess-w1" } }).row.id;
    store.setJobStatus(herd, "job-a", "at-gate", { lastGate: g });
    gateStore.answer(g, { q: "a" }, "shepherd");
    gateStore.markDelivery(g, "dead-pane");
    const res = await h["herd:status"]({ herd });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.jobs[0]).toMatchObject({ openGate: null, lastGateStatus: "answered", lastGateDelivery: "dead-pane" });
  });

  test("close closes the pane on the herd's socket and marks the job closed", async () => {
    const { h, store, herd, herdrCalls } = await started();
    store.upsertJob({ herd, name: "job-a", worktree: "/w/job-a", handle: "job-a", status: "active", pane: "w9:p1" });
    const res = await h["herd:close"]({ herd, job: "job-a" });
    expect(res.ok).toBe(true);
    expect(herdrCalls).toContainEqual(["pane", "close", "w9:p1"]);
    expect(store.getJob(herd, "job-a")!.status).toBe("closed");
  });

  test("close marks the job closed even when the herdr runner throws", async () => {
    const { h, store, herd } = await started({ herdrRunnerFor: () => async () => { throw new Error("herdr not found"); } });
    store.upsertJob({ herd, name: "job-a", worktree: "/w/job-a", handle: "job-a", status: "active", pane: "w9:p1" });
    const res = await h["herd:close"]({ herd, job: "job-a" });
    expect(res.ok).toBe(true);
    expect(store.getJob(herd, "job-a")!.status).toBe("closed");
  });

  test("close on a job with no pane still marks it closed", async () => {
    const { h, store, herd, herdrCalls } = await started();
    store.upsertJob({ herd, name: "job-a", worktree: "/w/job-a", handle: "job-a", status: "crashed" });
    const res = await h["herd:close"]({ herd, job: "job-a" });
    expect(res.ok).toBe(true);
    expect(herdrCalls).toEqual([]);
    expect(store.getJob(herd, "job-a")!.status).toBe("closed");
  });
});

describe("herd:list", () => {
  test("lists active herds with their job counts; --all includes wrapped ones", async () => {
    const hx = harness();
    const a = await hx.h["herd:start"](START);
    const b = await hx.h["herd:start"]({ ...START, name: "other" });
    if (!a.ok || !b.ok) throw new Error("start failed");
    hx.store.upsertJob({ herd: a.data.herd, name: "job-a", worktree: "/w", handle: "job-a", status: "active" });
    hx.store.setHerdStatus(b.data.herd, "wrapped");
    const active = await hx.h["herd:list"]({});
    if (!active.ok) throw new Error(active.error);
    expect(active.data.herds.map((h) => h.id)).toEqual([a.data.herd]);
    expect(active.data.herds[0]).toMatchObject({ room: a.data.room, status: "active", jobs: 1 });
    const all = await hx.h["herd:list"]({ all: true });
    if (!all.ok) throw new Error(all.error);
    expect(all.data.herds.map((h) => h.id).sort()).toEqual([a.data.herd, b.data.herd].sort());
  });
});

describe("worker verbs", () => {
  const Q = [{ id: "q1", label: "Which?", multi: false, options: ["a", "b"] }];
  async function withJob() {
    const hx = harness();
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    hx.store.upsertJob({ herd: s.data.herd, name: "job-a", worktree: "/w/job-a", handle: "job-a", status: "active", pane: "w9:p1", agentSession: "sess-w1" });
    return { ...hx, herd: s.data.herd, room: s.data.room };
  }

  test("ask opens a question gate with subject, refs, nudge, meta; job goes at-gate", async () => {
    const { h, store, gateStore, herd } = await withJob();
    const res = await h["herd:ask"]({ herd, job: "job-a", session: "sess-w1", pane: "w9:p1", questions: Q, context: "why" });
    if (!res.ok) throw new Error(res.error);
    const g = gateStore.get(res.data.gate)!;
    expect(g).toMatchObject({ subject: `herd:${herd}/job-a`, kind: "question", agent: "job-a", pane: "w9:p1", nudge: { session: "sess-w1" }, meta: { herd, job: "job-a" }, context: "why" });
    expect(store.getJob(herd, "job-a")).toMatchObject({ status: "at-gate", lastGate: res.data.gate });
  });

  test("ask refuses an unknown job and invalid questions", async () => {
    const { h, herd } = await withJob();
    expect((await h["herd:ask"]({ herd, job: "nope", session: "s", questions: Q })).ok).toBe(false);
    expect((await h["herd:ask"]({ herd, job: "job-a", session: "s", questions: [] })).ok).toBe(false);
  });

  test("milestone posts quietly to the room then opens a milestone gate with the fixed options", async () => {
    const { h, store, gateStore, chatCalls, herd, room } = await withJob();
    const res = await h["herd:milestone"]({ herd, job: "job-a", session: "sess-w1", pane: "w9:p1", artifact: "/w/job-a/spec.md", summary: "spec ready" });
    if (!res.ok) throw new Error(res.error);
    const post = chatCalls.find((c) => c.verb === "post")!;
    expect(post.payload).toMatchObject({ room, handle: "job-a", quiet: true });
    expect(post.payload.body).toContain("/w/job-a/spec.md");
    const g = gateStore.get(res.data.gate)!;
    expect(g.kind).toBe("milestone");
    expect(g.questions).toEqual([{ id: "decision", label: "spec ready", multi: false, options: ["Approve", "Revise", "Spawn a reviewer"] }]);
    expect(g.meta).toMatchObject({ herd, job: "job-a", artifact: "/w/job-a/spec.md" });
    expect(store.getJob(herd, "job-a")!.status).toBe("at-milestone");
  });

  test("answer returns the recorded answer with notes, or null while open", async () => {
    const { h, gateStore, herd } = await withJob();
    const asked = await h["herd:ask"]({ herd, job: "job-a", session: "sess-w1", questions: Q });
    if (!asked.ok) throw new Error(asked.error);
    const open = await h["herd:answer"]({ gate: asked.data.gate });
    if (!open.ok) throw new Error(open.error);
    expect(open.data).toMatchObject({ status: "open", answer: null });
    gateStore.answer(asked.data.gate, { q1: { value: "b", note: "and also x" } } as never, "shepherd");
    const done = await h["herd:answer"]({ gate: asked.data.gate });
    if (!done.ok) throw new Error(done.error);
    expect(done.data.status).toBe("answered");
    expect(done.data.answer!.by).toBe("shepherd");
    expect((await h["herd:answer"]({ gate: "gt-nope" })).ok).toBe(false);
  });

  test("report posts to the room mentioning the shepherd and marks the job done", async () => {
    const { h, store, chatCalls, herd, room } = await withJob();
    const res = await h["herd:report"]({ herd, job: "job-a", body: "done: A1 A2" });
    if (!res.ok) throw new Error(res.error);
    const post = chatCalls.find((c) => c.verb === "post")!;
    expect(post.payload).toMatchObject({ room, handle: "job-a", body: "done: A1 A2", mentions: ["shepherd"] });
    expect(post.payload.quiet).toBeUndefined();
    expect(store.getJob(herd, "job-a")).toMatchObject({ status: "done", lastReport: res.data.message });
  });

  test("report on a disposable job closes its pane and marks it closed", async () => {
    const { h, store, herdrCalls, herd } = await withJob();
    store.upsertJob({ herd, name: "review-job-a", worktree: "/w/job-a", handle: "review-job-a", status: "active", pane: "w9:p7", disposable: true });
    const res = await h["herd:report"]({ herd, job: "review-job-a", body: "verdict: approve" });
    expect(res.ok).toBe(true);
    expect(herdrCalls).toContainEqual(["pane", "close", "w9:p7"]);
    expect(store.getJob(herd, "review-job-a")!.status).toBe("closed");
  });
});

describe("herd:spawn", () => {
  async function started() {
    const hx = harness();
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    return { ...hx, herd: s.data.herd, room: s.data.room };
  }

  test("provisions, starts the agent in the herd workspace with env and handle, signs the pane in, records the job", async () => {
    const { h, store, agentCalls, worktreeCalls, chatCalls, herd, room, dir } = await started();
    const res = await h["herd:spawn"]({ herd, job: "job-a", brief: "# job\ndo the thing", model: "opus", account: "2" });
    if (!res.ok) throw new Error(res.error);
    expect(worktreeCalls[0]).toMatchObject({ verb: "provision", p: { repoName: "gh:m4ttstack/rt", branch: "job-a", disposal: "job" } });
    expect(agentCalls[0]).toMatchObject({
      repo: "gh:m4ttstack/rt", cwd: "/w/job-a", surface: "herdr", model: "opus", account: "2",
      workspace: `herd: ${herd}`, tab: "job-a", label: "job-a", caller: `herd:${herd}`, handle: "job-a",
      env: { HERD_ID: herd, HERD_JOB: "job-a", HERD_ROOM: room },
    });
    expect(agentCalls[0].prompt).toContain("do the thing");
    expect(agentCalls[0].herdrSocket).toBeUndefined();
    const signIn = chatCalls.filter((c) => c.verb === "sign-in")[1]!;
    expect(signIn.payload).toMatchObject({ sessionId: "sess-w1", baseHandle: "job-a", pane: "w9:p1", noRoom: true });
    expect(chatCalls.filter((c) => c.verb === "join")[1]!.payload).toMatchObject({ room, handle: "job-a", pane: "w9:p1" });
    expect(store.getJob(herd, "job-a")).toMatchObject({ worktree: "/w/job-a", branch: "job-a", tree: "job-a", pane: "w9:p1", agentSession: "sess-w1", agentId: "ag-1", handle: "job-a", status: "spawning", disposable: false });
    expect(res.data).toMatchObject({ pane: "w9:p1", worktree: "/w/job-a", tree: "job-a", sessionId: "sess-w1" });
    expect(readFileSync(join(dir, "herds", herd, "job-a", "job.md"), "utf8")).toContain("do the thing");
  });

  test("--dir skips provisioning; a respawn closes the old pane first and reuses the stored job.md", async () => {
    const { h, store, agentCalls, worktreeCalls, herdrCalls, herd } = await started();
    const first = await h["herd:spawn"]({ herd, job: "job-a", brief: "the brief", dir: "/existing/tree" });
    if (!first.ok) throw new Error(first.error);
    expect(worktreeCalls).toEqual([]);
    expect(store.getJob(herd, "job-a")!.tree).toBeNull();
    expect(herdrCalls).toEqual([]);
    const again = await h["herd:spawn"]({ herd, job: "job-a", dir: "/existing/tree" });
    if (!again.ok) throw new Error(again.error);
    expect(herdrCalls).toContainEqual(["pane", "close", "w9:p1"]);
    expect(agentCalls[1].prompt).toContain("the brief");
    expect(agentCalls[1].cwd).toBe("/existing/tree");
  });

  test("--disposable is recorded on the job row", async () => {
    const { h, store, herd } = await started();
    const res = await h["herd:spawn"]({ herd, job: "review-job-a", brief: "review it", dir: "/w/job-a", disposable: true });
    expect(res.ok).toBe(true);
    expect(store.getJob(herd, "review-job-a")!.disposable).toBe(true);
  });

  test("a respawn without --disposable keeps the prior disposable flag", async () => {
    const { h, store, herd } = await started();
    expect((await h["herd:spawn"]({ herd, job: "review-job-a", brief: "review it", dir: "/w/job-a", disposable: true })).ok).toBe(true);
    expect((await h["herd:spawn"]({ herd, job: "review-job-a", dir: "/w/job-a" })).ok).toBe(true);
    expect(store.getJob(herd, "review-job-a")!.disposable).toBe(true);
  });

  test("the trust accept waits out herdr's registration lag, then accepts with enter", async () => {
    const { h, socketCalls, order, screen, trust, herd } = await started();
    screen.text = "Do you trust the files in this folder?\n1. Yes, proceed\n";
    trust.registerFailures = 2;
    // The shepherd's own sign-in is already in the log, so only the calls this
    // spawn adds can say anything about the worker's ordering.
    const mark = order.length;
    const res = await h["herd:spawn"]({ herd, job: "job-a", brief: "b", dir: "/t" });
    expect(res.ok).toBe(true);
    expect(socketCalls.filter((c) => c.method === "agent.get")).toHaveLength(3);
    expect(socketCalls.find((c) => c.method === "agent.wait")!.params).toMatchObject({ target: "w9:p1", until: ["idle", "blocked", "done"], timeout_ms: 15_000 });
    expect(socketCalls.find((c) => c.method === "pane.send_keys")!.params).toEqual({ pane_id: "w9:p1", keys: ["enter"] });
    // The worker must be reachable in chat whatever the trust wait costs.
    const spawned = order.slice(mark);
    const signedIn = spawned.indexOf("chat:sign-in");
    const firstGet = spawned.indexOf("herdr:agent.get");
    expect(signedIn).toBeGreaterThanOrEqual(0);
    expect(firstGet).toBeGreaterThanOrEqual(0);
    expect(signedIn).toBeLessThan(firstGet);
  });

  test("an idle agent whose brief merely says trust is sent nothing", async () => {
    const { h, socketCalls, screen, trust, herd } = await started();
    screen.text = "reading the brief: trust the fixture owner\n";
    trust.waitStatus = "idle";
    expect((await h["herd:spawn"]({ herd, job: "job-a", brief: "b", dir: "/t" })).ok).toBe(true);
    expect(socketCalls.some((c) => c.method === "pane.read")).toBe(false);
    expect(socketCalls.some((c) => c.method === "pane.send_keys")).toBe(false);
  });

  test("a pane still working when the trust budget expires is sent nothing", async () => {
    const { h, socketCalls, screen, trust, herd } = await started();
    screen.text = "Do you trust the files in this folder?";
    trust.waitOk = false;
    expect((await h["herd:spawn"]({ herd, job: "job-a", brief: "b", dir: "/t" })).ok).toBe(true);
    expect(socketCalls.some((c) => c.method === "pane.send_keys")).toBe(false);
  });

  test("an agent that never registers is given up on without a send", async () => {
    const hx = harness({ registerBudgetMs: 400 });
    hx.screen.text = "Do you trust the files in this folder?";
    hx.trust.registerFailures = Number.MAX_SAFE_INTEGER;
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    expect((await hx.h["herd:spawn"]({ herd: s.data.herd, job: "job-a", brief: "b", dir: "/t" })).ok).toBe(true);
    expect(hx.socketCalls.some((c) => c.method === "agent.wait")).toBe(false);
    expect(hx.socketCalls.some((c) => c.method === "pane.send_keys")).toBe(false);
  });

  test("a pane showing ordinary output is left alone", async () => {
    const { h, socketCalls, herd } = await started();
    const res = await h["herd:spawn"]({ herd, job: "job-a", brief: "b", dir: "/t" });
    expect(res.ok).toBe(true);
    expect(socketCalls.some((c) => c.method === "pane.read")).toBe(true);
    expect(socketCalls.some((c) => c.method === "pane.send_keys")).toBe(false);
  });

  test("a hidden herd runs the trust check on its own socket", async () => {
    const hx = harness();
    hx.screen.text = "Do you trust the files in this folder?";
    const s = await hx.h["herd:start"]({ ...START, hidden: true });
    if (!s.ok) throw new Error(s.error);
    expect((await hx.h["herd:spawn"]({ herd: s.data.herd, job: "job-a", brief: "b", dir: "/t" })).ok).toBe(true);
    expect(hx.socketCalls.find((c) => c.method === "pane.send_keys")!.sock).toBe("/tmp/hidden.sock");
  });

  test("a spawn still succeeds when the herdr socket throws on the trust check", async () => {
    const hx = harness({
      herdr: (async (method: string) => {
        if (method === "session.snapshot") return { ok: true, result: { snapshot: { panes: [] } } };
        throw new Error("socket gone");
      }) as unknown as HerdDeps["herdr"],
    });
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    const res = await hx.h["herd:spawn"]({ herd: s.data.herd, job: "job-a", brief: "b", dir: "/t" });
    expect(res.ok).toBe(true);
    expect(hx.store.getJob(s.data.herd, "job-a")!.pane).toBe("w9:p1");
  });

  test("a hidden herd passes its socket to agent:start", async () => {
    const hx = harness();
    const s = await hx.h["herd:start"]({ ...START, hidden: true });
    if (!s.ok) throw new Error(s.error);
    const res = await hx.h["herd:spawn"]({ herd: s.data.herd, job: "job-a", brief: "b", dir: "/t" });
    expect(res.ok).toBe(true);
    expect(hx.agentCalls[0].herdrSocket).toBe("/tmp/hidden.sock");
  });

  test("a sign-in that hands back a renamed handle is what the join, the row, and the response carry", async () => {
    const calls: Array<{ verb: string; payload: any }> = [];
    const chat = {
      "chat:sign-in": async (p: any) => { calls.push({ verb: "sign-in", payload: p }); return { ok: true as const, data: { handle: "job-a-2", baseHandle: p.baseHandle, sessionId: p.sessionId, room: null } }; },
      "chat:join": async (p: any) => { calls.push({ verb: "join", payload: p }); return { ok: true as const, data: { handle: p.handle, memberCount: 1, unread: 0 } }; },
    } as unknown as HerdDeps["chat"];
    const hx = harness({ chat, presenceHandleForSession: () => "shepherd" });
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    const res = await hx.h["herd:spawn"]({ herd: s.data.herd, job: "job-a", brief: "b", dir: "/t" });
    if (!res.ok) throw new Error(res.error);
    expect(calls.filter((c) => c.verb === "join")[1]!.payload).toMatchObject({ room: s.data.room, handle: "job-a-2" });
    expect(hx.store.getJob(s.data.herd, "job-a")).toMatchObject({ handle: "job-a-2", pane: "w9:p1", agentSession: "sess-w1", agentId: "ag-1" });
    expect(res.data.handle).toBe("job-a-2");
  });

  test("a respawn whose agent:start fails leaves no pane on the row, since the old one is already closed", async () => {
    let starts = 0;
    const agent = {
      "agent:start": async (p: any) => {
        starts += 1;
        if (starts > 1) return { ok: false as const, error: "boom" };
        return { ok: true as const, data: { id: "ag-1", sessionId: "sess-w1", paneId: "w9:p1", tabId: "w9:t1", workspaceId: "w9", repo: p.repo, cwd: p.cwd, surface: "herdr", provider: "claude" } };
      },
    } as unknown as HerdDeps["agent"];
    const hx = harness({ agent });
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    const first = await hx.h["herd:spawn"]({ herd: s.data.herd, job: "job-a", brief: "b", dir: "/t" });
    if (!first.ok) throw new Error(first.error);
    expect(hx.store.getJob(s.data.herd, "job-a")!.pane).toBe("w9:p1");
    expect((await hx.h["herd:spawn"]({ herd: s.data.herd, job: "job-a", dir: "/t" })).ok).toBe(false);
    expect(hx.herdrCalls).toContainEqual(["pane", "close", "w9:p1"]);
    expect(hx.store.getJob(s.data.herd, "job-a")).toMatchObject({ pane: null, agentSession: null, agentId: null, status: "spawning" });
  });

  test("refuses a bad job name, a new job with no brief, and an unknown herd", async () => {
    const { h, herd } = await started();
    expect((await h["herd:spawn"]({ herd, job: "Bad", brief: "b" })).ok).toBe(false);
    expect((await h["herd:spawn"]({ herd, job: "job-b" })).ok).toBe(false);
    expect((await h["herd:spawn"]({ herd: "nope", job: "job-a", brief: "b" })).ok).toBe(false);
  });
});

describe("herd:gates", () => {
  test("lists herd-prefixed gates plus run gates whose worktree matches a job", async () => {
    const hx = harness({ runWorktree: (id) => (id === "run-1" ? "/w/job-a" : id === "run-2" ? "/elsewhere" : null) });
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    const herd = s.data.herd;
    hx.store.upsertJob({ herd, name: "job-a", worktree: "/w/job-a", handle: "job-a", status: "active" });
    const Q = [{ id: "q", label: "?", multi: false, options: ["a"] }];
    const g1 = hx.gateStore.open({ subject: `herd:${herd}/job-a`, kind: "question", questions: Q }).row.id;
    const g2 = hx.gateStore.open({ subject: "run:run-1", kind: "clarify", questions: Q }).row.id;
    hx.gateStore.open({ subject: "run:run-2", kind: "clarify", questions: Q });
    hx.gateStore.open({ subject: "run:run-3", kind: "clarify", questions: Q });
    const res = await hx.h["herd:gates"]({ herd });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.gates.map((g) => g.id).sort()).toEqual([g1, g2].sort());
  });
});

describe("hidden verbs", () => {
  test("attend resolves the hidden pane's terminal and opens an attached tab in the caller's workspace", async () => {
    const hx = harness({
      herdrRunnerFor: (socket) => async (args) => {
        hx.herdrCalls.push([socket ?? "default", ...args]);
        if (args[0] === "pane" && args[1] === "get") return { stdout: JSON.stringify({ result: { pane: { terminal_id: "term-7" } } }), exitCode: 0 };
        if (args[0] === "tab" && args[1] === "create") return { stdout: JSON.stringify({ result: { root_pane: { pane_id: "wv:p9", tab_id: "wv:t9", workspace_id: "wv" } } }), exitCode: 0 };
        return { stdout: "{}", exitCode: 0 };
      },
    });
    const s = await hx.h["herd:start"]({ ...START, hidden: true });
    if (!s.ok) throw new Error(s.error);
    hx.store.upsertJob({ herd: s.data.herd, name: "job-a", worktree: "/w", handle: "job-a", status: "active", pane: "wh:p1" });
    const res = await hx.h["herd:attend"]({ herd: s.data.herd, job: "job-a", callerWorkspace: "wv" });
    if (!res.ok) throw new Error(res.error);
    expect(res.data).toEqual({ tab: "wv:t9", pane: "wh:p1" });
    expect(hx.herdrCalls).toContainEqual(["/tmp/hidden.sock", "pane", "get", "wh:p1"]);
    expect(hx.herdrCalls).toContainEqual(["default", "tab", "create", "--workspace", "wv", "--label", "attend: job-a", "--focus"]);
    const run = hx.herdrCalls.find((c) => c[1] === "pane" && c[2] === "run")!;
    expect(run[3]).toBe("wv:p9");
    expect(run[4]).toContain("terminal attach term-7 --takeover");
    expect(run[4]).toContain("HERDR_SESSION=herd");
  });

  test("attend on a visible herd is a no-op with a message", async () => {
    const hx = harness();
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    hx.store.upsertJob({ herd: s.data.herd, name: "job-a", worktree: "/w", handle: "job-a", status: "active", pane: "w9:p1" });
    const res = await hx.h["herd:attend"]({ herd: s.data.herd, job: "job-a", callerWorkspace: "wv" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/not hidden/);
  });

  // termId rides unquoted into the `terminal attach` shell line, so a
  // non-string (or shell-unsafe) terminal_id must fall through to the
  // existing "no terminal id" error rather than being trusted.
  test("attend rejects a non-string terminal_id", async () => {
    const hx = harness({
      herdrRunnerFor: (socket) => async (args) => {
        hx.herdrCalls.push([socket ?? "default", ...args]);
        if (args[0] === "pane" && args[1] === "get") return { stdout: JSON.stringify({ result: { pane: { terminal_id: 7 } } }), exitCode: 0 };
        return { stdout: "{}", exitCode: 0 };
      },
    });
    const s = await hx.h["herd:start"]({ ...START, hidden: true });
    if (!s.ok) throw new Error(s.error);
    hx.store.upsertJob({ herd: s.data.herd, name: "job-a", worktree: "/w", handle: "job-a", status: "active", pane: "wh:p1" });
    const res = await hx.h["herd:attend"]({ herd: s.data.herd, job: "job-a", callerWorkspace: "wv" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/no terminal id/);
    expect(hx.herdrCalls.some((c) => c[1] === "tab" && c[2] === "create")).toBe(false);
  });

  test("attend fails cleanly when tab create exits zero with output that is not JSON", async () => {
    const hx = harness({
      herdrRunnerFor: (socket) => async (args) => {
        hx.herdrCalls.push([socket ?? "default", ...args]);
        if (args[0] === "pane" && args[1] === "get") return { stdout: JSON.stringify({ result: { pane: { terminal_id: "term-7" } } }), exitCode: 0 };
        if (args[0] === "tab" && args[1] === "create") return { stdout: "nope", exitCode: 0 };
        return { stdout: "{}", exitCode: 0 };
      },
    });
    const s = await hx.h["herd:start"]({ ...START, hidden: true });
    if (!s.ok) throw new Error(s.error);
    hx.store.upsertJob({ herd: s.data.herd, name: "job-a", worktree: "/w", handle: "job-a", status: "active", pane: "wh:p1" });
    const res = await hx.h["herd:attend"]({ herd: s.data.herd, job: "job-a", callerWorkspace: "wv" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/invalid JSON/);
    expect(hx.herdrCalls.some((c) => c[1] === "pane" && c[2] === "run")).toBe(false);
  });

  test("stop-hidden returns the failure when the herdr stop fails", async () => {
    const hx = harness({ hidden: { socketPath: () => "/tmp/hidden.sock", ensure: async () => "/tmp/hidden.sock", up: async () => true, stop: async () => { throw new Error("herdr session stop failed: no such session"); } } });
    const res = await hx.h["herd:stop-hidden"]({});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/no such session/);
  });

  test("stop-hidden refuses while an active hidden herd exists, then stops", async () => {
    let stopped = 0;
    const hx = harness({ hidden: { socketPath: () => "/tmp/hidden.sock", ensure: async () => "/tmp/hidden.sock", up: async () => true, stop: async () => { stopped++; } } });
    const s = await hx.h["herd:start"]({ ...START, hidden: true });
    if (!s.ok) throw new Error(s.error);
    expect((await hx.h["herd:stop-hidden"]({})).ok).toBe(false);
    hx.store.setHerdStatus(s.data.herd, "wrapped");
    const res = await hx.h["herd:stop-hidden"]({});
    expect(res.ok).toBe(true);
    expect(stopped).toBe(1);
  });
});

describe("herd:wrap-up", () => {
  async function withTwoJobs() {
    const hx = harness();
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    const herd = s.data.herd;
    hx.store.upsertJob({ herd, name: "job-a", worktree: "/w/job-a", branch: "job-a", tree: "slot-a", handle: "job-a", status: "done", pane: "w9:p1" });
    hx.store.upsertJob({ herd, name: "job-b", worktree: "/w/job-b", branch: "job-b", tree: "slot-b", handle: "job-b", status: "done", pane: "w9:p2" });
    mkdirSync(join(hx.dir, "herds", herd, "job-a"), { recursive: true });
    return { ...hx, herd, room: s.data.room };
  }

  test("runs exactly the flagged actions: panes, workspace, dispose by registry tree name, job dirs, archive", async () => {
    const { h, store, herdrCalls, worktreeCalls, chatCalls, herd, room, dir } = await withTwoJobs();
    const res = await h["herd:wrap-up"]({ herd, closePanes: true, dispose: ["job-a"], deleteJobDirs: true, archiveRoom: true });
    if (!res.ok) throw new Error(res.error);
    expect(res.data).toEqual({ closed: ["job-a", "job-b"], workspaceClosed: true, disposed: ["slot-a"], refused: [], deletedJobDirs: true, archived: true });
    expect(herdrCalls).toContainEqual(["pane", "close", "w9:p1"]);
    expect(herdrCalls).toContainEqual(["pane", "close", "w9:p2"]);
    expect(herdrCalls.some((c) => c[0] === "workspace" && c[1] === "close")).toBe(true);
    expect(worktreeCalls).toContainEqual({ verb: "dispose", p: { repoName: "gh:m4ttstack/rt", tree: "slot-a" } });
    expect(existsSync(join(dir, "herds", herd))).toBe(false);
    expect(chatCalls.at(-1)).toMatchObject({ verb: "archive", payload: { room, handle: "shepherd", archived: true } });
    expect(store.get(herd)!.status).toBe("wrapped");
    expect(store.jobs(herd).every((j) => j.status === "closed")).toBe(true);
  });

  test("with no flags it only marks the herd wrapped and reports a dispose refusal verbatim", async () => {
    const hx = await withTwoJobs();
    hx.worktreeCalls.length = 0;
    const refusing = harness({
      worktree: {
        "worktree:provision": async () => ({ ok: true, data: {} }),
        "worktree:dispose": async (p: any) => ({ ok: true, data: { disposed: [], refused: [{ tree: p.tree, reason: "unmerged work" }], recoverable: [] } }),
      },
    });
    const s = await refusing.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    refusing.store.upsertJob({ herd: s.data.herd, name: "job-a", worktree: "/w/job-a", branch: "job-a", tree: "slot-a", handle: "job-a", status: "done" });
    const res = await refusing.h["herd:wrap-up"]({ herd: s.data.herd, dispose: ["job-a"] });
    if (!res.ok) throw new Error(res.error);
    expect(res.data).toMatchObject({ closed: [], workspaceClosed: false, disposed: [], refused: [{ tree: "slot-a", reason: "unmerged work" }], deletedJobDirs: false, archived: false });
    expect(refusing.herdrCalls).toEqual([]);
  });

  test("a --dir job has no registry tree and is refused with a reason, not disposed", async () => {
    const { h, store, worktreeCalls, herd } = await withTwoJobs();
    store.upsertJob({ herd, name: "job-c", worktree: "/elsewhere", handle: "job-c", status: "done" });
    const res = await h["herd:wrap-up"]({ herd, dispose: ["job-c"] });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.refused).toEqual([{ tree: "job-c", reason: "no rt-provisioned tree for this job" }]);
    expect(worktreeCalls.filter((c) => c.verb === "dispose")).toEqual([]);
  });

  // Two crashed, pane-less jobs: closePane never runs for either, so the CLI's
  // pane count must read zero, not two, even though both rows still flip to
  // "closed".
  test("pane-less jobs are marked closed but never counted as closed panes", async () => {
    const hx = harness();
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    const herd = s.data.herd;
    hx.store.upsertJob({ herd, name: "job-a", worktree: "/w/job-a", handle: "job-a", status: "done", pane: null });
    hx.store.upsertJob({ herd, name: "job-b", worktree: "/w/job-b", handle: "job-b", status: "done", pane: null });
    const res = await hx.h["herd:wrap-up"]({ herd, closePanes: true });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.closed).toEqual([]);
    expect(hx.store.jobs(herd).every((j) => j.status === "closed")).toBe(true);
    expect(hx.herdrCalls.some((c) => c[0] === "pane" && c[1] === "close")).toBe(false);
  });

  // A pane close that fails (closePane returns false) must not be counted
  // either: `closed` names only panes that actually closed.
  test("a job whose pane close fails is marked closed but not counted", async () => {
    const hx = harness({ herdrRunnerFor: () => async (args) => (args[0] === "pane" && args[1] === "close" ? { stdout: "", exitCode: 1 } : { stdout: "{}", exitCode: 0 }) });
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    const herd = s.data.herd;
    hx.store.upsertJob({ herd, name: "job-a", worktree: "/w/job-a", handle: "job-a", status: "done", pane: "w9:p1" });
    const res = await hx.h["herd:wrap-up"]({ herd, closePanes: true });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.closed).toEqual([]);
    expect(hx.store.getJob(herd, "job-a")!.status).toBe("closed");
  });
});
