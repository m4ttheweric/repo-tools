import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createGatesStore, type GateQuestion, type GatesStore } from "../gates-store.ts";

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
});

describe("gates store — transitions", () => {
  test("answer wins once; the second answer is rejected WITH the winning answer", () => {
    const s = store(); const id = openGate(s, "run:r1");
    const w = s.answer(id, { q: "a" }, "console");
    expect(w.ok).toBe(true);
    const l = s.answer(id, { q: "b" }, "pane");
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
    s.answer(a, { q: "x" }, "pane");
    expect(s.close(a, "pruned").ok).toBe(false);
    const b = openGate(s, "run:r2");
    expect(s.close(b, "abandoned").ok).toBe(true);
    const r = s.answer(b, { q: "x" }, "pane");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("closed");
  });

  test("ANY answer attempt from the gate's own pane marks it released: the CAS loser...", () => {
    const s = store();
    const { row } = s.open({ subject: "run:r1", kind: "clarify", questions: qs(), pane: "pane-7" });
    s.answer(row.id, { q: "a" }, "console");
    s.answer(row.id, { q: "b" }, "pane"); // loses, but proves the pane reconciled
    expect(s.get(row.id)?.released).toBe(true);
  });

  test("...and the winner too (a pane that decides has obviously reconciled)", () => {
    const s = store();
    const { row } = s.open({ subject: "run:r1", kind: "clarify", questions: qs(), pane: "pane-7" });
    s.answer(row.id, { q: "a" }, "pane"); // wins
    expect(s.get(row.id)?.released).toBe(true);
  });

  test("list filters by open, subjectPrefix, kind", () => {
    const s = store();
    openGate(s, "run:r1"); openGate(s, "mr:https://x/1");
    const runs = s.list({ open: true, subjectPrefix: "run:" });
    expect(runs.length).toBe(1);
    expect(runs[0]!.subject).toBe("run:r1");
  });
});
