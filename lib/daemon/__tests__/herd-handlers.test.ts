import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
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

  test("close marks the job closed even when the herdr runner throws", async () => {
    const { h, store, herd } = await started({ herdrRunnerFor: () => async () => { throw new Error("herdr not found"); } });
    store.upsertJob({ herd, name: "cv-1", worktree: "/w/cv-1", handle: "cv-1", status: "active", pane: "w9:p1" });
    const res = await h["herd:close"]({ herd, job: "cv-1" });
    expect(res.ok).toBe(true);
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

describe("worker verbs", () => {
  const Q = [{ id: "q1", label: "Which?", multi: false, options: ["a", "b"] }];
  async function withJob() {
    const hx = harness();
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    hx.store.upsertJob({ herd: s.data.herd, name: "cv-1", worktree: "/w/cv-1", handle: "cv-1", status: "active", pane: "w9:p1", agentSession: "sess-w1" });
    return { ...hx, herd: s.data.herd, room: s.data.room };
  }

  test("ask opens a question gate with subject, refs, nudge, meta; job goes at-gate", async () => {
    const { h, store, gateStore, herd } = await withJob();
    const res = await h["herd:ask"]({ herd, job: "cv-1", session: "sess-w1", pane: "w9:p1", questions: Q, context: "why" });
    if (!res.ok) throw new Error(res.error);
    const g = gateStore.get(res.data.gate)!;
    expect(g).toMatchObject({ subject: `herd:${herd}/cv-1`, kind: "question", agent: "cv-1", pane: "w9:p1", nudge: { session: "sess-w1" }, meta: { herd, job: "cv-1" }, context: "why" });
    expect(store.getJob(herd, "cv-1")).toMatchObject({ status: "at-gate", lastGate: res.data.gate });
  });

  test("ask refuses an unknown job and invalid questions", async () => {
    const { h, herd } = await withJob();
    expect((await h["herd:ask"]({ herd, job: "nope", session: "s", questions: Q })).ok).toBe(false);
    expect((await h["herd:ask"]({ herd, job: "cv-1", session: "s", questions: [] })).ok).toBe(false);
  });

  test("milestone posts quietly to the room then opens a milestone gate with the fixed options", async () => {
    const { h, store, gateStore, chatCalls, herd, room } = await withJob();
    const res = await h["herd:milestone"]({ herd, job: "cv-1", session: "sess-w1", pane: "w9:p1", artifact: "/w/cv-1/spec.md", summary: "spec ready" });
    if (!res.ok) throw new Error(res.error);
    const post = chatCalls.find((c) => c.verb === "post")!;
    expect(post.payload).toMatchObject({ room, handle: "cv-1", quiet: true });
    expect(post.payload.body).toContain("/w/cv-1/spec.md");
    const g = gateStore.get(res.data.gate)!;
    expect(g.kind).toBe("milestone");
    expect(g.questions).toEqual([{ id: "decision", label: "spec ready", multi: false, options: ["Approve", "Revise", "Spawn a reviewer"] }]);
    expect(g.meta).toMatchObject({ herd, job: "cv-1", artifact: "/w/cv-1/spec.md" });
    expect(store.getJob(herd, "cv-1")!.status).toBe("at-milestone");
  });

  test("answer returns the recorded answer with notes, or null while open", async () => {
    const { h, gateStore, herd } = await withJob();
    const asked = await h["herd:ask"]({ herd, job: "cv-1", session: "sess-w1", questions: Q });
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
    const res = await h["herd:report"]({ herd, job: "cv-1", body: "done: A1 A2" });
    if (!res.ok) throw new Error(res.error);
    const post = chatCalls.find((c) => c.verb === "post")!;
    expect(post.payload).toMatchObject({ room, handle: "cv-1", body: "done: A1 A2", mentions: ["shepherd"] });
    expect(post.payload.quiet).toBeUndefined();
    expect(store.getJob(herd, "cv-1")).toMatchObject({ status: "done", lastReport: res.data.message });
  });

  test("report on a disposable job closes its pane and marks it closed", async () => {
    const { h, store, herdrCalls, herd } = await withJob();
    store.upsertJob({ herd, name: "review-cv-1", worktree: "/w/cv-1", handle: "review-cv-1", status: "active", pane: "w9:p7", disposable: true });
    const res = await h["herd:report"]({ herd, job: "review-cv-1", body: "verdict: approve" });
    expect(res.ok).toBe(true);
    expect(herdrCalls).toContainEqual(["pane", "close", "w9:p7"]);
    expect(store.getJob(herd, "review-cv-1")!.status).toBe("closed");
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
    const res = await h["herd:spawn"]({ herd, job: "cv-1", brief: "# job\ndo the thing", model: "opus", account: "2" });
    if (!res.ok) throw new Error(res.error);
    expect(worktreeCalls[0]).toMatchObject({ verb: "provision", p: { repoName: "gh:m4ttstack/rt", branch: "cv-1", disposal: "job" } });
    expect(agentCalls[0]).toMatchObject({
      repo: "gh:m4ttstack/rt", cwd: "/w/cv-1", surface: "herdr", model: "opus", account: "2",
      workspace: `herd: ${herd}`, tab: "cv-1", label: "cv-1", caller: `herd:${herd}`, handle: "cv-1",
      env: { HERD_ID: herd, HERD_JOB: "cv-1", HERD_ROOM: room },
    });
    expect(agentCalls[0].prompt).toContain("do the thing");
    expect(agentCalls[0].herdrSocket).toBeUndefined();
    const signIn = chatCalls.filter((c) => c.verb === "sign-in")[1]!;
    expect(signIn.payload).toMatchObject({ sessionId: "sess-w1", baseHandle: "cv-1", pane: "w9:p1", noRoom: true });
    expect(chatCalls.filter((c) => c.verb === "join")[1]!.payload).toMatchObject({ room, handle: "cv-1", pane: "w9:p1" });
    expect(store.getJob(herd, "cv-1")).toMatchObject({ worktree: "/w/cv-1", branch: "cv-1", tree: "cv-1", pane: "w9:p1", agentSession: "sess-w1", agentId: "ag-1", handle: "cv-1", status: "spawning", disposable: false });
    expect(res.data).toMatchObject({ pane: "w9:p1", worktree: "/w/cv-1", tree: "cv-1", sessionId: "sess-w1" });
    expect(readFileSync(join(dir, "herds", herd, "cv-1", "job.md"), "utf8")).toContain("do the thing");
  });

  test("--dir skips provisioning; a respawn closes the old pane first and reuses the stored job.md", async () => {
    const { h, store, agentCalls, worktreeCalls, herdrCalls, herd } = await started();
    const first = await h["herd:spawn"]({ herd, job: "cv-1", brief: "the brief", dir: "/existing/tree" });
    if (!first.ok) throw new Error(first.error);
    expect(worktreeCalls).toEqual([]);
    expect(store.getJob(herd, "cv-1")!.tree).toBeNull();
    expect(herdrCalls).toEqual([]);
    const again = await h["herd:spawn"]({ herd, job: "cv-1", dir: "/existing/tree" });
    if (!again.ok) throw new Error(again.error);
    expect(herdrCalls).toContainEqual(["pane", "close", "w9:p1"]);
    expect(agentCalls[1].prompt).toContain("the brief");
    expect(agentCalls[1].cwd).toBe("/existing/tree");
  });

  test("--disposable is recorded on the job row", async () => {
    const { h, store, herd } = await started();
    const res = await h["herd:spawn"]({ herd, job: "review-cv-1", brief: "review it", dir: "/w/cv-1", disposable: true });
    expect(res.ok).toBe(true);
    expect(store.getJob(herd, "review-cv-1")!.disposable).toBe(true);
  });

  test("a hidden herd passes its socket to agent:start", async () => {
    const hx = harness();
    const s = await hx.h["herd:start"]({ ...START, hidden: true });
    if (!s.ok) throw new Error(s.error);
    const res = await hx.h["herd:spawn"]({ herd: s.data.herd, job: "cv-1", brief: "b", dir: "/t" });
    expect(res.ok).toBe(true);
    expect(hx.agentCalls[0].herdrSocket).toBe("/tmp/hidden.sock");
  });

  test("a sign-in that hands back a renamed handle is what the join, the row, and the response carry", async () => {
    const calls: Array<{ verb: string; payload: any }> = [];
    const chat = {
      "chat:sign-in": async (p: any) => { calls.push({ verb: "sign-in", payload: p }); return { ok: true as const, data: { handle: "cv-1-2", baseHandle: p.baseHandle, sessionId: p.sessionId, room: null } }; },
      "chat:join": async (p: any) => { calls.push({ verb: "join", payload: p }); return { ok: true as const, data: { handle: p.handle, memberCount: 1, unread: 0 } }; },
    } as unknown as HerdDeps["chat"];
    const hx = harness({ chat, presenceHandleForSession: () => "shepherd" });
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    const res = await hx.h["herd:spawn"]({ herd: s.data.herd, job: "cv-1", brief: "b", dir: "/t" });
    if (!res.ok) throw new Error(res.error);
    expect(calls.filter((c) => c.verb === "join")[1]!.payload).toMatchObject({ room: s.data.room, handle: "cv-1-2" });
    expect(hx.store.getJob(s.data.herd, "cv-1")).toMatchObject({ handle: "cv-1-2", pane: "w9:p1", agentSession: "sess-w1", agentId: "ag-1" });
    expect(res.data.handle).toBe("cv-1-2");
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
    const first = await hx.h["herd:spawn"]({ herd: s.data.herd, job: "cv-1", brief: "b", dir: "/t" });
    if (!first.ok) throw new Error(first.error);
    expect(hx.store.getJob(s.data.herd, "cv-1")!.pane).toBe("w9:p1");
    expect((await hx.h["herd:spawn"]({ herd: s.data.herd, job: "cv-1", dir: "/t" })).ok).toBe(false);
    expect(hx.herdrCalls).toContainEqual(["pane", "close", "w9:p1"]);
    expect(hx.store.getJob(s.data.herd, "cv-1")).toMatchObject({ pane: null, agentSession: null, agentId: null, status: "spawning" });
  });

  test("refuses a bad job name, a new job with no brief, and an unknown herd", async () => {
    const { h, herd } = await started();
    expect((await h["herd:spawn"]({ herd, job: "Bad", brief: "b" })).ok).toBe(false);
    expect((await h["herd:spawn"]({ herd, job: "cv-2" })).ok).toBe(false);
    expect((await h["herd:spawn"]({ herd: "nope", job: "cv-1", brief: "b" })).ok).toBe(false);
  });
});

describe("herd:gates", () => {
  test("lists herd-prefixed gates plus run gates whose worktree matches a job", async () => {
    const hx = harness({ runWorktree: (id) => (id === "run-1" ? "/w/cv-1" : id === "run-2" ? "/elsewhere" : null) });
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    const herd = s.data.herd;
    hx.store.upsertJob({ herd, name: "cv-1", worktree: "/w/cv-1", handle: "cv-1", status: "active" });
    const Q = [{ id: "q", label: "?", multi: false, options: ["a"] }];
    const g1 = hx.gateStore.open({ subject: `herd:${herd}/cv-1`, kind: "question", questions: Q }).row.id;
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
    hx.store.upsertJob({ herd: s.data.herd, name: "cv-1", worktree: "/w", handle: "cv-1", status: "active", pane: "wh:p1" });
    const res = await hx.h["herd:attend"]({ herd: s.data.herd, job: "cv-1", callerWorkspace: "wv" });
    if (!res.ok) throw new Error(res.error);
    expect(res.data).toEqual({ tab: "wv:t9", pane: "wh:p1" });
    expect(hx.herdrCalls).toContainEqual(["/tmp/hidden.sock", "pane", "get", "wh:p1"]);
    expect(hx.herdrCalls).toContainEqual(["default", "tab", "create", "--workspace", "wv", "--label", "attend: cv-1", "--focus"]);
    const run = hx.herdrCalls.find((c) => c[1] === "pane" && c[2] === "run")!;
    expect(run[3]).toBe("wv:p9");
    expect(run[4]).toContain("terminal attach term-7 --takeover");
    expect(run[4]).toContain("HERDR_SESSION=herd");
  });

  test("attend on a visible herd is a no-op with a message", async () => {
    const hx = harness();
    const s = await hx.h["herd:start"](START);
    if (!s.ok) throw new Error(s.error);
    hx.store.upsertJob({ herd: s.data.herd, name: "cv-1", worktree: "/w", handle: "cv-1", status: "active", pane: "w9:p1" });
    const res = await hx.h["herd:attend"]({ herd: s.data.herd, job: "cv-1", callerWorkspace: "wv" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/not hidden/);
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
