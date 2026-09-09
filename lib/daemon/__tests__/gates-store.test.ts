import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createGatesStore, GATE_BY_PANE, type GateQuestion, type GatesStore } from "../gates-store.ts";

const log = pino({ level: "silent" });

let dirs: string[] = [];

/** A fresh tmp dir per call, joined with `name`; every dir is swept in afterEach. */
function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-gates-"));
  dirs.push(dir);
  return join(dir, name);
}

function qs(): GateQuestion[] {
  return [{ id: "q", label: "Pick", multi: false, options: ["a", "b"] }];
}

/** Fresh store backed by its own tmp db file, swept in afterEach via tmp(). */
function store(): GatesStore {
  return createGatesStore({ dbPath: tmp("gates.db"), log });
}

/** Opens a gate on `subject` with the standard question set, returns its id. */
function openGate(s: GatesStore, subject: string): string {
  return s.open({ subject, kind: "clarify", questions: qs() }).row.id;
}

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("gates store", () => {
  test("open mints an id and persists the row", () => {
    const s = createGatesStore({ dbPath: tmp("gates.db"), log });
    const { row, supersededId } = s.open({ subject: "run:abc", kind: "clarify", questions: [{ id: "q", label: "Pick", multi: false, options: ["a", "b"] }] });
    expect(row.status).toBe("open");
    expect(supersededId).toBeNull();
    expect(s.get(row.id)?.subject).toBe("run:abc");
    s.close_();
  });

  test("open on a subject with an open gate of the SAME kind supersedes it in one transaction", () => {
    const s = createGatesStore({ dbPath: tmp("gates.db"), log });
    const first = s.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs() }).row;
    const { row: second, supersededId } = s.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs() });
    expect(supersededId).toBe(first.id);
    expect(s.get(first.id)?.status).toBe("closed");
    expect(s.get(first.id)?.closedReason).toBe("superseded");
    expect(s.get(second.id)?.status).toBe("open");
    s.close_();
  });

  test("open does NOT supersede a different kind on the same subject", () => {
    const s = createGatesStore({ dbPath: tmp("gates.db"), log });
    const a = s.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs() }).row;
    const { supersededId } = s.open({ subject: "mr:https://x/1", kind: "doctor-escalation", questions: qs() });
    expect(supersededId).toBeNull();
    expect(s.get(a.id)?.status).toBe("open");
    s.close_();
  });

  test("rows survive close and reopen of the store (persistence)", () => {
    const p = tmp("gates.db");
    const s1 = createGatesStore({ dbPath: p, log });
    const id = s1.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row.id;
    s1.close_();
    const s2 = createGatesStore({ dbPath: p, log });
    expect(s2.get(id)?.status).toBe("open");
    s2.close_();
  });

  test("subject validation: rejects empty and colon-less subjects", () => {
    const s = createGatesStore({ dbPath: tmp("gates.db"), log });
    expect(() => s.open({ subject: "", kind: "k", questions: qs() })).toThrow();
    expect(() => s.open({ subject: "nocolon", kind: "k", questions: qs() })).toThrow();
    s.close_();
  });

  test("subject validation: rejects an empty remainder after the colon", () => {
    const s = createGatesStore({ dbPath: tmp("gates.db"), log });
    expect(() => s.open({ subject: "run:", kind: "k", questions: qs() })).toThrow();
    s.close_();
  });

  test("subject validation: keeps every currently-valid subject shape working", () => {
    const s = createGatesStore({ dbPath: tmp("gates.db"), log });
    expect(() => s.open({ subject: "mr:https://gitlab.example.com/x/1", kind: "k1", questions: qs() })).not.toThrow();
    expect(() => s.open({ subject: "run:r1", kind: "k2", questions: qs() })).not.toThrow();
    expect(() => s.open({ subject: "spike:word", kind: "k3", questions: qs() })).not.toThrow();
    s.close_();
  });
});

describe("gates store — transitions", () => {
  test("answer wins once; the second answer is rejected WITH the winning answer", () => {
    const s = store(); const id = openGate(s, "run:r1");
    const w = s.answer(id, { q: "a" }, "console");
    expect(w.ok).toBe(true);
    const l = s.answer(id, { q: "b" }, GATE_BY_PANE);
    expect(l.ok).toBe(false);
    if (!l.ok) { expect(l.reason).toBe("already-answered"); expect(l.row?.answer?.by).toBe("console"); }
  });

  test("answering a parked gate unparks and answers", () => {
    const s = store(); const id = openGate(s, "mr:https://x/1");
    expect(s.park(id).ok).toBe(true);
    const r = s.answer(id, { q: "a" }, "board");
    expect(r.ok).toBe(true);
    expect(s.get(id)?.status).toBe("answered");
  });

  test("park on an answered gate rejects cleanly with the row", () => {
    const s = store(); const id = openGate(s, "mr:https://x/1");
    s.answer(id, { q: "a" }, "board");
    const r = s.park(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-open");
  });

  test("close is terminal; closing an answered gate is a no-op rejection; answer after close rejects", () => {
    const s = store();
    const a = openGate(s, "run:r1");
    s.answer(a, { q: "x" }, GATE_BY_PANE);
    expect(s.close(a, "pruned").ok).toBe(false);
    const b = openGate(s, "run:r2");
    expect(s.close(b, "abandoned").ok).toBe(true);
    const r = s.answer(b, { q: "x" }, GATE_BY_PANE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("closed");
  });

  test("closing an already-closed gate rejects distinctly, closedReason unchanged", () => {
    const s = store();
    const id = openGate(s, "run:r1");
    expect(s.close(id, "abandoned").ok).toBe(true);
    const r = s.close(id, "pruned");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("already-closed");
    expect(s.get(id)?.closedReason).toBe("abandoned");
  });

  test("ANY answer attempt from the gate's own pane marks it released: the CAS loser...", () => {
    const s = store();
    const { row } = s.open({ subject: "run:r1", kind: "clarify", questions: qs(), pane: "pane-7" });
    s.answer(row.id, { q: "a" }, "console");
    s.answer(row.id, { q: "b" }, GATE_BY_PANE); // loses, but proves the pane reconciled
    expect(s.get(row.id)?.released).toBe(true);
  });

  test("...and the winner too (a pane that decides has obviously reconciled)", () => {
    const s = store();
    const { row } = s.open({ subject: "run:r1", kind: "clarify", questions: qs(), pane: "pane-7" });
    s.answer(row.id, { q: "a" }, GATE_BY_PANE); // wins
    expect(s.get(row.id)?.released).toBe(true);
  });

  test("list filters by open, subjectPrefix, kind", () => {
    const s = store();
    openGate(s, "run:r1"); openGate(s, "mr:https://x/1");
    const { gates } = s.list({ open: true, subjectPrefix: "run:" });
    expect(gates.length).toBe(1);
    expect(gates[0]!.subject).toBe("run:r1");
  });
});

describe("gates store — wait", () => {
  test("wait on an already-answered gate returns immediately (registry-status-first)", async () => {
    const s = store(); const id = openGate(s, "run:r1");
    s.answer(id, { q: "a" }, "console");
    const r = await s.wait(id, { waitMs: 10 });
    expect(r.status).toBe("answered");
  });

  test("wait blocks until answer arrives, then resolves with the row", async () => {
    const s = store(); const id = openGate(s, "run:r1");
    const p = s.wait(id, { waitMs: 5000 });
    s.answer(id, { q: "a" }, "board");
    const r = await p;
    expect(r.status).toBe("answered");
    if (r.status === "answered") expect(r.row.answer?.by).toBe("board");
  });

  test("wait resolves on close with status closed", async () => {
    const s = store(); const id = openGate(s, "run:r1");
    const p = s.wait(id, { waitMs: 5000 });
    s.close(id, "abandoned");
    expect((await p).status).toBe("closed");
  });

  test("wait times out cleanly and is re-entrant", async () => {
    const s = store(); const id = openGate(s, "run:r1");
    expect((await s.wait(id, { waitMs: 20 })).status).toBe("timeout");
    const p = s.wait(id, { waitMs: 5000 });
    s.answer(id, { q: "a" }, GATE_BY_PANE);
    expect((await p).status).toBe("answered");
  });

  test("wait on an unknown id resolves not-found immediately, never registering a waiter", async () => {
    const s = store();
    const r = await s.wait("no-such-gate", { waitMs: 5000 });
    expect(r.status).toBe("not-found");
  });

  test("supersede-on-open releases the superseded gate's waiters with closed", async () => {
    const s = store();
    const first = s.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs() }).row;
    const w = s.wait(first.id, { waitMs: 5000 });
    s.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs() });
    expect((await w).status).toBe("closed");
  });
});

describe("gates store — subscriptions", () => {
  test("subscriptions persist, filter live, and record delivery outcomes", () => {
    const p = tmp("gates.db");
    const s1 = createGatesStore({ dbPath: p, log });
    const sub = s1.subscribe({ subjectPrefix: "run:", session: "sess-1" });
    s1.markSubscriptionDelivery(sub.id, "failed");
    s1.close_();
    const s2 = createGatesStore({ dbPath: p, log });
    expect(s2.subscriptions({ live: true }).length).toBe(1);
    s2.markSubscriptionDead(sub.id);
    expect(s2.subscriptions({ live: true }).length).toBe(0);
  });

  test("subscribe is idempotent on (subjectPrefix, session): a live re-subscribe returns the SAME row", () => {
    const s = store();
    const first = s.subscribe({ subjectPrefix: "run:", session: "sess-1" });
    const second = s.subscribe({ subjectPrefix: "run:", session: "sess-1" });
    expect(second.id).toBe(first.id);
    expect(s.subscriptions().length).toBe(1);
  });

  test("a DEAD row does not block a fresh subscribe: a new live row is minted", () => {
    const s = store();
    const first = s.subscribe({ subjectPrefix: "run:", session: "sess-1" });
    s.markSubscriptionDead(first.id);
    const second = s.subscribe({ subjectPrefix: "run:", session: "sess-1" });
    expect(second.id).not.toBe(first.id);
    expect(s.subscriptions({ live: true }).length).toBe(1);
  });

  test("subscriptions filters by session, and unfiltered reads include dead rows", () => {
    const s = store();
    const a = s.subscribe({ subjectPrefix: "run:", session: "sess-1" });
    s.subscribe({ subjectPrefix: "mr:", session: "sess-2" });
    s.markSubscriptionDead(a.id);
    expect(s.subscriptions({ session: "sess-1" }).length).toBe(1);
    expect(s.subscriptions().length).toBe(2); // dead row still readable unfiltered
    expect(s.subscriptions({ live: true }).length).toBe(1);
  });
});

describe("gates store — sweep", () => {
  test("sweeps an old closed row, never touches an open row, and respects the floor", () => {
    const s: GatesStore = createGatesStore({ dbPath: tmp("gates.db"), log, retentionMs: 1000, retentionFloor: 0 });
    const oldId = openGate(s, "run:old");
    s.close(oldId, "abandoned");
    // Backdate closedAt past the retention window directly on the handle,
    // same trick events-bus.ts's own sweep test uses (no real sleep).
    s.__db!.run("UPDATE gates SET closedAt = ? WHERE id = ?", [Date.now() - 10_000, oldId]);
    const openId = openGate(s, "run:keep-open");
    const removed = s.sweep();
    expect(removed).toBe(1);
    expect(s.get(oldId)).toBeNull();
    expect(s.get(openId)).not.toBeNull();
  });

  test("a row floor keeps the most recent terminal rows even past the retention window", () => {
    const s: GatesStore = createGatesStore({ dbPath: tmp("gates.db"), log, retentionMs: 1000, retentionFloor: 1 });
    const id = openGate(s, "run:old");
    s.close(id, "abandoned");
    s.__db!.run("UPDATE gates SET closedAt = ? WHERE id = ?", [Date.now() - 10_000, id]);
    const removed = s.sweep();
    expect(removed).toBe(0); // the floor (1) covers this single terminal row
    expect(s.get(id)).not.toBeNull();
  });
});

test("an existing gates.db without the W4 columns gains them on open (ALTER migration)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-gates-migrate-"));
  dirs.push(dir);
  const path = join(dir, "gates.db");
  const raw = new Database(path, { create: true });
  raw.exec(`
    CREATE TABLE gates (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, kind TEXT NOT NULL,
      questions TEXT NOT NULL, meta TEXT, status TEXT NOT NULL, answer TEXT,
      openedAt INTEGER NOT NULL, parkedAt INTEGER, closedAt INTEGER,
      closedReason TEXT, agent TEXT, pane TEXT, nudge TEXT, delivery TEXT,
      released INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE gate_subscriptions (
      id TEXT PRIMARY KEY, subjectPrefix TEXT NOT NULL, session TEXT NOT NULL,
      createdAt INTEGER NOT NULL, lastDelivery TEXT, dead INTEGER NOT NULL DEFAULT 0
    );
  `);
  raw.close();
  const store = createGatesStore({ dbPath: path, log });
  const row = store.open({
    subject: "run:r1", kind: "k", questions: qs(),
    context: "why", origin: { presentation: "form", paneId: "p1" },
  }).row;
  expect(row.context).toBe("why");
  expect(row.origin).toEqual({ presentation: "form", paneId: "p1" });
  store.close_();
});

test("deadPanePushes lists answered nudged rows whose last push was dead-pane and are unreleased; never closed ones", () => {
  const s = store();
  const a = s.open({ subject: "herd:h/j1", kind: "question", questions: qs(), nudge: { session: "w1" } }).row.id;
  const b = s.open({ subject: "herd:h/j2", kind: "question", questions: qs(), nudge: { session: "w2" } }).row.id;
  const c = s.open({ subject: "herd:h/j3", kind: "question", questions: qs() }).row.id;
  s.answer(a, { q: "a" }, "shepherd"); s.markDelivery(a, "dead-pane");
  s.answer(b, { q: "a" }, "shepherd"); s.markDelivery(b, "delivered");
  s.answer(c, { q: "a" }, "shepherd"); s.markDelivery(c, "dead-pane");
  const d = s.open({ subject: "herd:h/j4", kind: "question", questions: qs(), nudge: { session: "w4" } }).row.id;
  s.close(d, "abandoned"); s.markDelivery(d, "dead-pane");
  expect(s.deadPanePushes().map((r) => r.id)).toEqual([a]);
});
