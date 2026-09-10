import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createHerdStore } from "../herd-store.ts";
import { createGatesStore } from "../gates-store.ts";
import { createEventsBus } from "../events-bus.ts";
import { createGateHandlers } from "../handlers/gate.ts";
import { createHerdLifecycle } from "../herd-lifecycle.ts";

const log = pino({ level: "silent" });
let dirs: string[] = [];
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fx(over: {
  postThrows?: boolean;
  bgSocket?: string;
  /** Seeds sweepClaims' backing rows; releaseByPane/release still mutate this list for real, so sweep tests can assert against `bgClaims.list()` afterward. */
  claims?: Array<{ owner: string; pane: string | null }>;
  /** herd-lifecycle's `herdr` dep (session.snapshot for the sweep); default answers an empty bg snapshot. */
  herdr?: (method: string, params: unknown, opts2?: { sockPath?: string }) => Promise<any>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rt-herd-lc-"));
  dirs.push(dir);
  const store = createHerdStore({ dbPath: join(dir, "herds.db"), log });
  const gateStore = createGatesStore({ dbPath: join(dir, "gates.db"), log });
  const bus = createEventsBus({ dbPath: join(dir, "events.db"), log });
  const gate = createGateHandlers(gateStore, bus, (type, data) => bus.fanOut(type, data), { log });
  const warns: string[] = [];
  const lcLog = pino({ level: "warn" }, { write: (line: string) => { warns.push(line); } });
  const posts: any[] = [];
  const chat = { "chat:post": async (p: any) => {
    if (over.postThrows) throw new Error("chat is down");
    posts.push(p);
    return { ok: true, data: { id: posts.length, recipients: [], others: 0 } };
  } };
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const setTimer = (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return { clear() { t.cleared = true; } }; };
  const subs: Array<{ sockPath: string; subscriptions: Array<Record<string, unknown>>; onState?: (c: boolean) => void; stopped: boolean }> = [];
  const subscribe = ((o: any) => { const s = { sockPath: o.sockPath, subscriptions: o.subscriptions, onState: o.onState, stopped: false }; subs.push(s); o.onState?.(true); return { stop() { s.stopped = true; }, connected: () => !s.stopped }; }) as any;
  const bgReleases: string[] = [];
  const claimRows: Array<{ owner: string; pane: string | null; createdAt: number }> = (over.claims ?? []).map((c, i) => ({ owner: c.owner, pane: c.pane, createdAt: i }));
  const bgClaims = {
    // releaseByPane keeps recording its raw argument into bgReleases (the pre-existing
    // event-path tests assert on that, unconditionally of whether a claim row exists);
    // it also removes any real seeded rows so sweep tests can read `list()` afterward.
    releaseByPane: (pane: string) => {
      const owners = claimRows.filter((c) => c.pane === pane).map((c) => c.owner);
      for (const o of owners) { const idx = claimRows.findIndex((c) => c.owner === o); if (idx >= 0) claimRows.splice(idx, 1); }
      bgReleases.push(pane);
      return owners;
    },
    release: (owner: string) => {
      const idx = claimRows.findIndex((c) => c.owner === owner);
      if (idx < 0) return false;
      claimRows.splice(idx, 1);
      return true;
    },
    list: () => claimRows.map((c) => ({ ...c })),
    // Real BgClaimsStore.claim, for tests that register a claim mid-sweep
    // (the TOCTOU regression test): idempotent upsert by owner.
    claim: (owner: string, pane?: string) => {
      const idx = claimRows.findIndex((c) => c.owner === owner);
      const row = { owner, pane: pane ?? null, createdAt: claimRows.length };
      if (idx >= 0) claimRows[idx] = row; else claimRows.push(row);
    },
  };
  const herdrCalls: Array<{ method: string; sockPath?: string }> = [];
  const herdr = (async (method: string, params: unknown, opts2?: { sockPath?: string }) => {
    herdrCalls.push({ method, sockPath: opts2?.sockPath });
    if (over.herdr) return over.herdr(method, params, opts2);
    return { ok: true, result: { snapshot: { panes: [] } } };
  }) as any;
  const lc = createHerdLifecycle({
    store, gate, chat, bus, gateStore, defaultSocket: "/default.sock",
    ...(over.bgSocket !== undefined && { bgSocket: over.bgSocket, bgClaims }),
    subscribe, herdr, setTimer, log: lcLog,
  });
  const herd = store.create({ id: "demo-1", repo: "r", room: "herd-demo-1", workspace: "herd: demo-1", shepherdSession: "s", shepherdHandle: "shepherd", herdrSocket: null, hidden: false });
  const wildcard = () => subs.filter((s) => !s.subscriptions.some((e) => "pane_id" in e));
  const paneSubs = () => subs.filter((s) => !s.stopped && s.subscriptions.some((e) => "pane_id" in e));
  return { store, gateStore, gate, bus, posts, warns, timers, subs, lc, herd, wildcard, paneSubs, bgReleases, bgClaims, herdrCalls };
}

describe("herd-lifecycle", () => {
  test("start opens one wildcard stream per socket (default plus every active hidden herd), watch adds one, stop stops all", () => {
    const { store, lc, subs, wildcard } = fx();
    store.create({ id: "hid-1", repo: "r", room: "herd-hid-1", workspace: "w", shepherdSession: "s", shepherdHandle: "shepherd", herdrSocket: "/hidden.sock", hidden: true });
    lc.start();
    expect(wildcard().map((s) => s.sockPath).sort()).toEqual(["/default.sock", "/hidden.sock"]);
    expect(wildcard()[0]!.subscriptions).toEqual([{ type: "pane.agent_detected" }, { type: "pane.closed" }, { type: "pane.exited" }]);
    expect(lc.connected(null)).toBe(true);
    expect(lc.connected("/hidden.sock")).toBe(true);
    lc.watch("/hidden.sock");
    expect(wildcard()).toHaveLength(2);
    lc.watch("/other.sock");
    expect(wildcard()).toHaveLength(3);
    lc.stop();
    expect(subs.every((s) => s.stopped)).toBe(true);
    expect(lc.connected(null)).toBe(false);
  });

  test("start opens a status stream per live job pane; agent_detected opens one; exit closes it; the 30s timer reconciles", async () => {
    const { store, lc, herd, paneSubs, timers } = fx();
    store.upsertJob({ herd: herd.id, name: "job-a", worktree: "/w", handle: "job-a", status: "active", pane: "w1:p1" });
    store.upsertJob({ herd: herd.id, name: "job-b", worktree: "/w2", handle: "job-b", status: "done", pane: "w1:p2" });
    lc.start();
    expect(paneSubs().map((s) => s.subscriptions)).toEqual([[{ type: "pane.agent_status_changed", pane_id: "w1:p1" }]]);
    store.upsertJob({ herd: herd.id, name: "job-c", worktree: "/w3", handle: "job-c", status: "spawning", pane: "w1:p3" });
    await lc.handleEvent(null, { type: "pane.agent_detected", pane_id: "w1:p3" });
    expect(paneSubs().map((s) => s.subscriptions[0]!.pane_id).sort()).toEqual(["w1:p1", "w1:p3"]);
    await lc.handleEvent(null, { type: "pane.exited", pane_id: "w1:p3" });
    expect(paneSubs().map((s) => s.subscriptions[0]!.pane_id)).toEqual(["w1:p1"]);
    store.setJobStatus(herd.id, "job-a", "closed");
    const reconcileTimer = timers.find((t) => t.ms === 30_000 && !t.cleared)!;
    reconcileTimer.fn();
    expect(paneSubs()).toEqual([]);
  });

  test("agent_detected flips spawning to active", async () => {
    const { store, lc, herd } = fx();
    store.upsertJob({ herd: herd.id, name: "job-a", worktree: "/w", handle: "job-a", status: "spawning", pane: "w1:p1" });
    await lc.handleEvent(null, { type: "pane.agent_detected", pane_id: "w1:p1" });
    expect(store.getJob(herd.id, "job-a")!.status).toBe("active");
  });

  test("blocked posts only after the debounce, mentioning the shepherd; a clear before it cancels", async () => {
    const { store, lc, herd, posts, timers } = fx();
    store.upsertJob({ herd: herd.id, name: "job-a", worktree: "/w", handle: "job-a", status: "active", pane: "w1:p1" });
    await lc.handleEvent(null, { type: "pane.agent_status_changed", pane_id: "w1:p1", agent_status: "blocked" });
    expect(posts).toHaveLength(0);
    const debounce = () => timers.filter((t) => t.ms === 30_000);
    expect(debounce()).toHaveLength(1);
    await lc.handleEvent(null, { type: "pane.agent_status_changed", pane_id: "w1:p1", agent_status: "working" });
    expect(debounce()[0]!.cleared).toBe(true);
    await lc.handleEvent(null, { type: "pane.agent_status_changed", pane_id: "w1:p1", agent_status: "blocked" });
    debounce()[1]!.fn();
    await Bun.sleep(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ room: "herd-demo-1", handle: "herdr", mentions: ["shepherd"] });
    expect(posts[0].body).toContain("job-a blocked");
  });

  test("working and idle flips post nothing", async () => {
    const { store, lc, herd, posts } = fx();
    store.upsertJob({ herd: herd.id, name: "job-a", worktree: "/w", handle: "job-a", status: "active", pane: "w1:p1" });
    await lc.handleEvent(null, { type: "pane.agent_status_changed", pane_id: "w1:p1", agent_status: "working" });
    await lc.handleEvent(null, { type: "pane.agent_status_changed", pane_id: "w1:p1", agent_status: "idle" });
    expect(posts).toEqual([]);
  });

  test("exited on an active job posts, marks crashed, and closes its open gate as abandoned", async () => {
    const { store, gateStore, lc, herd, posts } = fx();
    store.upsertJob({ herd: herd.id, name: "job-a", worktree: "/w", handle: "job-a", status: "at-gate", pane: "w1:p1" });
    const g = gateStore.open({ subject: "herd:demo-1/job-a", kind: "question", questions: [{ id: "q", label: "?", multi: false, options: ["a"] }] }).row.id;
    await lc.handleEvent(null, { type: "pane.exited", pane_id: "w1:p1" });
    expect(store.getJob(herd.id, "job-a")!.status).toBe("crashed");
    expect(posts[0].body).toContain("job-a exited");
    expect(gateStore.get(g)).toMatchObject({ status: "closed", closedReason: "abandoned" });
  });

  test("exited then closed for one teardown posts once and keeps the crashed marker", async () => {
    const { store, lc, herd, posts } = fx();
    store.upsertJob({ herd: herd.id, name: "job-a", worktree: "/w", handle: "job-a", status: "active", pane: "w1:p1" });
    await lc.handleEvent(null, { type: "pane.exited", pane_id: "w1:p1" });
    await lc.handleEvent(null, { type: "pane.closed", pane_id: "w1:p1" });
    expect(posts).toHaveLength(1);
    expect(store.getJob(herd.id, "job-a")!.status).toBe("crashed");
  });

  test("a stale job row sharing the pane never shadows the live one", async () => {
    const { store, lc, herd } = fx();
    store.upsertJob({ herd: herd.id, name: "job-old", worktree: "/w", handle: "job-old", status: "closed", pane: "w1:p9" });
    store.upsertJob({ herd: herd.id, name: "job-new", worktree: "/w2", handle: "job-new", status: "spawning", pane: "w1:p9" });
    await lc.handleEvent(null, { type: "pane.agent_detected", pane_id: "w1:p9" });
    expect(store.getJob(herd.id, "job-new")!.status).toBe("active");
    expect(store.getJob(herd.id, "job-old")!.status).toBe("closed");
  });

  test("a throwing chat:post is warned, not fatal, and the lifecycle keeps handling events", async () => {
    const { store, lc, herd, warns, timers } = fx({ postThrows: true });
    store.upsertJob({ herd: herd.id, name: "job-a", worktree: "/w", handle: "job-a", status: "active", pane: "w1:p1" });
    await lc.handleEvent(null, { type: "pane.agent_status_changed", pane_id: "w1:p1", agent_status: "blocked" });
    timers.find((t) => t.ms === 30_000)!.fn();
    await Bun.sleep(0);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("herd lifecycle: event handling failed");
    store.upsertJob({ herd: herd.id, name: "job-b", worktree: "/w2", handle: "job-b", status: "spawning", pane: "w1:p2" });
    await lc.handleEvent(null, { type: "pane.agent_detected", pane_id: "w1:p2" });
    expect(store.getJob(herd.id, "job-b")!.status).toBe("active");
  });

  test("closed on a done or closed job is silent and marks closed", async () => {
    const { store, lc, herd, posts } = fx();
    store.upsertJob({ herd: herd.id, name: "job-a", worktree: "/w", handle: "job-a", status: "done", pane: "w1:p1" });
    await lc.handleEvent(null, { type: "pane.closed", pane_id: "w1:p1" });
    expect(posts).toEqual([]);
    expect(store.getJob(herd.id, "job-a")!.status).toBe("closed");
  });

  test("an event for a pane on a different socket than the job's herd is ignored", async () => {
    const { store, lc, herd, posts } = fx();
    store.upsertJob({ herd: herd.id, name: "job-a", worktree: "/w", handle: "job-a", status: "active", pane: "w1:p1" });
    await lc.handleEvent("/hidden.sock", { type: "pane.exited", pane_id: "w1:p1" });
    expect(store.getJob(herd.id, "job-a")!.status).toBe("active");
    expect(posts).toEqual([]);
  });

  test("a gate answered on a herd subject returns the job to active; on a crashed job it stays crashed", async () => {
    const { store, gateStore, gate, lc, herd } = fx();
    lc.start();
    store.upsertJob({ herd: herd.id, name: "job-a", worktree: "/w", handle: "job-a", status: "at-gate", pane: "w1:p1" });
    const opened = await gate["gate:open"]({ subject: "herd:demo-1/job-a", kind: "question", questions: [{ id: "q", label: "?", multi: false, options: ["a"] }] });
    if (!opened.ok) throw new Error(opened.error);
    await gate["gate:answer"]({ id: opened.data.id, answers: { q: "a" }, by: "shepherd" });
    expect(store.getJob(herd.id, "job-a")!.status).toBe("active");
    store.setJobStatus(herd.id, "job-a", "crashed");
    const again = await gate["gate:open"]({ subject: "herd:demo-1/job-a", kind: "question", questions: [{ id: "q", label: "?", multi: false, options: ["a"] }] });
    if (!again.ok) throw new Error(again.error);
    await gate["gate:close"]({ id: again.data.id, reason: "abandoned" });
    expect(store.getJob(herd.id, "job-a")!.status).toBe("crashed");
    void gateStore;
  });

  // --bg (T8): an agent pane on the bg socket is never a herd job, so jobFor
  // always misses it -- the release must fire before that early return, not
  // after it.
  test("a bg-socket pane.closed releases the claim by its bg: ref even though jobFor never matches it (no herd job on that pane)", async () => {
    const { lc, bgReleases } = fx({ bgSocket: "/bg.sock" });
    await lc.handleEvent("/bg.sock", { type: "pane.closed", pane_id: "w1:p9" });
    expect(bgReleases).toEqual(["bg:w1:p9"]);
  });

  test("a bg-socket pane.exited also releases the claim", async () => {
    const { lc, bgReleases } = fx({ bgSocket: "/bg.sock" });
    await lc.handleEvent("/bg.sock", { type: "pane.exited", pane_id: "w1:p9" });
    expect(bgReleases).toEqual(["bg:w1:p9"]);
  });

  test("a bg-socket event that is not close/exit never releases", async () => {
    const { lc, bgReleases } = fx({ bgSocket: "/bg.sock" });
    await lc.handleEvent("/bg.sock", { type: "pane.agent_detected", pane_id: "w1:p9" });
    expect(bgReleases).toEqual([]);
  });

  test("a pane.closed on a socket that is not the bg socket never releases a claim", async () => {
    const { lc, bgReleases } = fx({ bgSocket: "/bg.sock" });
    await lc.handleEvent("/default.sock", { type: "pane.closed", pane_id: "w1:p9" });
    await lc.handleEvent(null, { type: "pane.closed", pane_id: "w1:p9" });
    expect(bgReleases).toEqual([]);
  });

  test("with no bgSocket configured, a bg-shaped pane.closed is inert (no throw, no release)", async () => {
    const { lc, bgReleases } = fx();
    await lc.handleEvent("/bg.sock", { type: "pane.closed", pane_id: "w1:p9" });
    expect(bgReleases).toEqual([]);
  });

  test("a bg-socket pane.closed for a pane that IS also a live herd job still runs both: release, then the herd-job handling", async () => {
    const { store, lc, posts, bgReleases } = fx({ bgSocket: "/bg.sock" });
    store.create({ id: "hid-1", repo: "r", room: "herd-hid-1", workspace: "w", shepherdSession: "s", shepherdHandle: "shepherd", herdrSocket: "/bg.sock", hidden: true });
    store.upsertJob({ herd: "hid-1", name: "job-a", worktree: "/w", handle: "job-a", status: "active", pane: "w1:p1" });
    await lc.handleEvent("/bg.sock", { type: "pane.exited", pane_id: "w1:p1" });
    expect(bgReleases).toEqual(["bg:w1:p1"]);
    expect(store.getJob("hid-1", "job-a")!.status).toBe("crashed");
    expect(posts[0].body).toContain("job-a exited");
  });

  test("start also watches the configured bg socket, not just default and herd rows", () => {
    const { lc, wildcard } = fx({ bgSocket: "/bg.sock" });
    lc.start();
    expect(wildcard().map((s) => s.sockPath).sort()).toEqual(["/bg.sock", "/default.sock"]);
  });

  test("sweepClaims releases a bg claim whose pane is missing from the snapshot and keeps one whose pane is present", async () => {
    const { lc, bgClaims, herdrCalls } = fx({
      bgSocket: "/bg.sock",
      claims: [
        { owner: "agent:gone", pane: "bg:w1:pGone" },
        { owner: "agent:here", pane: "bg:w1:pHere" },
      ],
      herdr: async () => ({ ok: true, result: { snapshot: { panes: [{ pane_id: "w1:pHere" }] } } }),
    });
    await lc.sweepClaims();
    expect(bgClaims.list().map((c) => c.owner)).toEqual(["agent:here"]);
    expect(herdrCalls).toEqual([{ method: "session.snapshot", sockPath: "/bg.sock" }]);
  });

  test("sweepClaims releases a runner claim whose pid is dead and keeps one whose pid is alive", async () => {
    const { lc, bgClaims } = fx({
      bgSocket: "/bg.sock",
      claims: [
        { owner: "runner:999999", pane: null },
        { owner: `runner:${process.pid}`, pane: null },
      ],
    });
    await lc.sweepClaims();
    expect(bgClaims.list().map((c) => c.owner)).toEqual([`runner:${process.pid}`]);
  });

  test("sweepClaims skips the pane sweep (but still checks runner pids) when the snapshot call fails", async () => {
    const { lc, bgClaims, warns } = fx({
      bgSocket: "/bg.sock",
      claims: [
        { owner: "agent:unknown", pane: "bg:w1:pUnknown" },
        { owner: "runner:999999", pane: null },
      ],
      herdr: async () => ({ ok: false, code: "unreachable", message: "herdr unavailable" }),
    });
    await lc.sweepClaims();
    expect(bgClaims.list().map((c) => c.owner)).toEqual(["agent:unknown"]);
    expect(warns.some((w) => w.includes("could not snapshot"))).toBe(true);
  });

  test("sweepClaims skips the pane sweep (but still checks runner pids) when the snapshot body is malformed (ok but no panes array)", async () => {
    const { lc, bgClaims, warns } = fx({
      bgSocket: "/bg.sock",
      claims: [
        { owner: "agent:unknown", pane: "bg:w1:pUnknown" },
        { owner: "runner:999999", pane: null },
      ],
      herdr: async () => ({ ok: true, result: {} }),
    });
    await lc.sweepClaims();
    expect(bgClaims.list().map((c) => c.owner)).toEqual(["agent:unknown"]);
    expect(warns.some((w) => w.includes("could not snapshot"))).toBe(true);
  });

  test("sweepClaims is inert without a configured bg socket", async () => {
    const { lc, herdrCalls } = fx();
    await lc.sweepClaims();
    expect(herdrCalls).toEqual([]);
  });

  // TOCTOU: a claim registered while session.snapshot is still in flight (a
  // concurrent agent:start --bg, or a peer's own ensure/reconnect sweep) is
  // invisible to that snapshot's view of live panes. Candidates must be
  // captured before the RPC, not re-listed after it resolves -- the latter
  // would read "not in this snapshot" as "gone" and release a claim on a
  // pane that is still being spawned.
  test("sweepClaims captures pane-claim candidates before the snapshot RPC: a claim registered mid-flight survives this round", async () => {
    let resolveSnapshot: () => void = () => {};
    const gate = new Promise<void>((resolve) => { resolveSnapshot = resolve; });
    const { lc, bgClaims } = fx({
      bgSocket: "/bg.sock",
      herdr: async () => {
        // Registered DURING the round trip, before the snapshot resolves --
        // the same instant a real concurrent bg.ensure()/agent:start would.
        bgClaims.claim("agent:midflight", "bg:w1:pMidflight");
        await gate;
        return { ok: true, result: { snapshot: { panes: [] } } };
      },
    });
    const sweepPromise = lc.sweepClaims();
    resolveSnapshot();
    await sweepPromise;
    expect(bgClaims.list().map((c) => c.owner)).toEqual(["agent:midflight"]);
  });

  // ─── herd pass (RT-118 item 5 review, critical fix) ────────────────────────
  // A pane-less `herd:<id>` claim (registered by herd:start, never carries a
  // pane) has no other release path once wrap-up leaves it (item 5's
  // ruling): the event path only ever fires on a pane close, and the runner
  // and pane passes above both skip it (no pid to check, no pane to look
  // up). This third pass is that claim's actual backstop.

  test("sweepClaims releases a pane-less herd claim once its herd row is gone", async () => {
    const { lc, bgClaims } = fx({
      bgSocket: "/bg.sock",
      claims: [{ owner: "herd:ghost", pane: null }],
      herdr: async () => ({ ok: true, result: { snapshot: { panes: [] } } }),
    });
    await lc.sweepClaims();
    expect(bgClaims.list().map((c) => c.owner)).toEqual([]);
  });

  test("sweepClaims releases a wrapped herd's claim once none of its jobs has a live pane in the bg snapshot", async () => {
    const { lc, store, bgClaims } = fx({
      bgSocket: "/bg.sock",
      claims: [{ owner: "herd:hd-1", pane: null }],
      herdr: async () => ({ ok: true, result: { snapshot: { panes: [] } } }),
    });
    store.create({ id: "hd-1", repo: "r", room: "herd-hd-1", workspace: "herd: hd-1", shepherdSession: "s", shepherdHandle: "shepherd", herdrSocket: "/bg.sock", hidden: true });
    store.upsertJob({ herd: "hd-1", name: "job-a", worktree: "/w/job-a", handle: "job-a", status: "done", pane: "w9:p1" });
    store.setHerdStatus("hd-1", "wrapped");
    await lc.sweepClaims();
    expect(bgClaims.list().map((c) => c.owner)).toEqual([]);
  });

  test("sweepClaims keeps a wrapped herd's claim while one of its jobs still has a live pane in the snapshot", async () => {
    const { lc, store, bgClaims } = fx({
      bgSocket: "/bg.sock",
      claims: [{ owner: "herd:hd-1", pane: null }],
      herdr: async () => ({ ok: true, result: { snapshot: { panes: [{ pane_id: "w9:p1" }] } } }),
    });
    store.create({ id: "hd-1", repo: "r", room: "herd-hd-1", workspace: "herd: hd-1", shepherdSession: "s", shepherdHandle: "shepherd", herdrSocket: "/bg.sock", hidden: true });
    store.upsertJob({ herd: "hd-1", name: "job-a", worktree: "/w/job-a", handle: "job-a", status: "active", pane: "w9:p1" });
    store.setHerdStatus("hd-1", "wrapped");
    await lc.sweepClaims();
    expect(bgClaims.list().map((c) => c.owner)).toEqual(["herd:hd-1"]);
  });

  test("sweepClaims keeps an active (not yet wrapped) herd's claim regardless of live panes", async () => {
    const { lc, store, bgClaims } = fx({
      bgSocket: "/bg.sock",
      claims: [{ owner: "herd:demo-1", pane: null }],
      herdr: async () => ({ ok: true, result: { snapshot: { panes: [] } } }),
    });
    expect(store.get("demo-1")!.status).toBe("active");
    await lc.sweepClaims();
    expect(bgClaims.list().map((c) => c.owner)).toEqual(["herd:demo-1"]);
  });

  test("sweepClaims skips the herd pass (but still checks the pane and runner passes) when the snapshot call fails", async () => {
    const { lc, store, bgClaims } = fx({
      bgSocket: "/bg.sock",
      claims: [{ owner: "herd:hd-1", pane: null }],
      herdr: async () => ({ ok: false, code: "unreachable", message: "herdr unavailable" }),
    });
    store.create({ id: "hd-1", repo: "r", room: "herd-hd-1", workspace: "herd: hd-1", shepherdSession: "s", shepherdHandle: "shepherd", herdrSocket: "/bg.sock", hidden: true });
    store.setHerdStatus("hd-1", "wrapped");
    await lc.sweepClaims();
    expect(bgClaims.list().map((c) => c.owner)).toEqual(["herd:hd-1"]);
  });
});
