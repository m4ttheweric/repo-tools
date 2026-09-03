import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createGatesStore, type GatesStore, type GateQuestion } from "../gates-store.ts";
import { createGateHandlers } from "../handlers/gate.ts";
import type { EventsBus } from "../events-bus.ts";

const log = pino({ level: "silent" });

let dirs: string[] = [];
beforeEach(() => { dirs = []; });
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function qs(): GateQuestion[] {
  return [{ id: "q", label: "Pick", multi: false, options: ["a", "b"] }];
}

function twoQuestions(): GateQuestion[] {
  return [
    { id: "q", label: "Pick", multi: false, options: ["a", "b"] },
    { id: "m", label: "Pick many", multi: true, options: ["a", "b"] },
  ];
}

/** Real store on a fresh tmp db, a fake bus capturing every emitAt call, and
    a fake broadcast capturing every frame -- mirrors events-handlers.test.ts. */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "rt-gates-handlers-"));
  dirs.push(dir);
  const store: GatesStore = createGatesStore({ dbPath: join(dir, "gates.db"), log });
  const emitted: Array<{ topic: string; payload: unknown; at: number }> = [];
  let nextId = 1;
  const bus = {
    emitAt: (topic: string, payload: unknown, at: number) => {
      emitted.push({ topic, payload, at });
      return nextId++;
    },
  } as unknown as EventsBus;
  const broadcasts: Array<{ type: string; data: any }> = [];
  const handlers = createGateHandlers(store, bus, (type, data) => broadcasts.push({ type, data }));
  return { handlers, store, emitted, broadcasts };
}

async function open(handlers: ReturnType<typeof createGateHandlers>, opts: { pane?: string } = {}) {
  const r = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), ...opts });
  if (!r.ok) throw new Error("open failed");
  return r.data;
}

async function openTwoQuestions(handlers: ReturnType<typeof createGateHandlers>) {
  const r = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: twoQuestions() });
  if (!r.ok) throw new Error("open failed");
  return r.data;
}

describe("gate:open", () => {
  test("emits gate/opened/<id> through the DUAL path (journal emitAt + broadcast)", async () => {
    const { handlers, emitted, broadcasts } = harness();
    const r = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs() });
    expect(r.ok).toBe(true);
    const id = (r as any).data.id;
    expect(emitted[0]!.topic).toBe(`gate/opened/${id}`);
    expect(broadcasts[0]!.type).toBe("event");
    expect((broadcasts[0]!.data as any).payload.subject).toBe("run:r1");
    expect((broadcasts[0]!.data as any).payload.meta).toBeDefined();
  });

  test("label falls back to kind when meta.label is absent", async () => {
    const { handlers, emitted } = harness();
    await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs() });
    expect((emitted[0]!.payload as any).label).toBe("clarify");
  });

  test("label comes from meta.label when present", async () => {
    const { handlers, emitted } = harness();
    await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), meta: { label: "Pick a lane" } });
    expect((emitted[0]!.payload as any).label).toBe("Pick a lane");
  });

  test("rejects an invalid subject, missing kind, and malformed questions", async () => {
    const { handlers } = harness();
    expect((await handlers["gate:open"]({ subject: "nocolon", kind: "k", questions: qs() })).ok).toBe(false);
    expect((await handlers["gate:open"]({ subject: "run:r1", kind: "", questions: qs() })).ok).toBe(false);
    expect((await handlers["gate:open"]({ subject: "run:r1", kind: "k", questions: [] })).ok).toBe(false);
    expect((await handlers["gate:open"]({ subject: "run:r1", kind: "k", questions: [{ id: "q" }] as any })).ok).toBe(false);
  });
});

describe("gate:answer", () => {
  test("a CAS loss returns ok:true with conflict:true and the WINNING row", async () => {
    const { handlers } = harness();
    const id = (await open(handlers)).id;
    await handlers["gate:answer"]({ id, answers: { q: "a" }, by: "console" });
    const l = await handlers["gate:answer"]({ id, answers: { q: "b" }, by: "pane" });
    expect(l.ok).toBe(true);
    if (l.ok) { expect(l.data.conflict).toBe(true); expect(l.data.row.answer?.by).toBe("console"); }
  });

  test("note-carrying answer values round-trip (the spec's one free-text channel)", async () => {
    const { handlers, store } = harness();
    const id = (await openTwoQuestions(handlers)).id;
    const r = await handlers["gate:answer"]({
      id,
      answers: { q: { value: "a", note: "context" }, m: { value: ["a"], note: "x" } },
      by: "pane",
    });
    expect(r.ok).toBe(true);
    const row = store.get(id)!;
    expect((row.answer!.answers.q as any).note).toBe("context");
  });

  test("validates question ids and multi-shape only; values are opaque", async () => {
    const { handlers } = harness();
    const id = (await open(handlers)).id;
    const bad = await handlers["gate:answer"]({ id, answers: { nope: "a" }, by: "pane" });
    expect(bad.ok).toBe(false); // unknown question id
    const free = await handlers["gate:answer"]({ id, answers: { q: "freetext-not-an-option" }, by: "pane" });
    expect(free.ok).toBe(true); // option membership is advisory
  });

  test("rejects a multi-shape mismatch even when the value is wrapped with a note", async () => {
    const { handlers } = harness();
    const id = (await openTwoQuestions(handlers)).id;
    const wrongShape = await handlers["gate:answer"]({ id, answers: { m: { value: "a", note: "should be an array" } }, by: "pane" });
    expect(wrongShape.ok).toBe(false);
  });

  test("emits gate/answered/<id> through BOTH paths with by and paneId", async () => {
    const { handlers, emitted, broadcasts } = harness();
    const id = (await open(handlers, { pane: "pane-7" })).id;
    await handlers["gate:answer"]({ id, answers: { q: "a" }, by: "board" });
    const answered = emitted.find((e) => e.topic === `gate/answered/${id}`)!;
    expect((answered.payload as any).by).toBe("board");
    expect((answered.payload as any).paneId).toBe("pane-7");
    expect(broadcasts.some((b) => (b.data as any)?.topic === `gate/answered/${id}`)).toBe(true);
  });

  test("not-found and closed answers are ok:false errors, not conflicts", async () => {
    const { handlers } = harness();
    const missing = await handlers["gate:answer"]({ id: "nope", answers: { q: "a" }, by: "pane" });
    expect(missing.ok).toBe(false);
    const id = (await open(handlers)).id;
    await handlers["gate:close"]({ id, reason: "abandoned" });
    const onClosed = await handlers["gate:answer"]({ id, answers: { q: "a" }, by: "pane" });
    expect(onClosed.ok).toBe(false);
  });
});

describe("gate:wait", () => {
  test("an unknown id returns ok:false not-found", async () => {
    const { handlers } = harness();
    const r = await handlers["gate:wait"]({ id: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("not-found");
  });

  test("threads the request AbortSignal through to the store", async () => {
    const { handlers } = harness();
    const id = (await open(handlers)).id;
    const ac = new AbortController();
    const p = handlers["gate:wait"]({ id, waitMs: 60_000 }, ac.signal);
    ac.abort();
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.status).toBe("timeout");
  });

  test("resolves immediately when the gate is already answered", async () => {
    const { handlers } = harness();
    const id = (await open(handlers)).id;
    await handlers["gate:answer"]({ id, answers: { q: "a" }, by: "pane" });
    const r = await handlers["gate:wait"]({ id });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.data.status).toBe("answered"); expect(r.data.row!.id).toBe(id); }
  });
});

describe("gate:list / gate:park / gate:close", () => {
  test("list filters by open/subjectPrefix/kind", async () => {
    const { handlers } = harness();
    await open(handlers);
    const r = await handlers["gate:list"]({ open: true, subjectPrefix: "run:", kind: "clarify" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.gates).toHaveLength(1);
  });

  test("park succeeds on an open gate, fails with a reason otherwise", async () => {
    const { handlers } = harness();
    const id = (await open(handlers)).id;
    const ok = await handlers["gate:park"]({ id });
    expect(ok.ok).toBe(true);
    const missing = await handlers["gate:park"]({ id: "nope" });
    expect(missing.ok).toBe(false);
  });

  test("close rejects an invalid reason and reports not-found", async () => {
    const { handlers } = harness();
    const id = (await open(handlers)).id;
    const badReason = await handlers["gate:close"]({ id, reason: "nonsense" as any });
    expect(badReason.ok).toBe(false);
    const missing = await handlers["gate:close"]({ id: "nope", reason: "pruned" });
    expect(missing.ok).toBe(false);
    const ok = await handlers["gate:close"]({ id, reason: "abandoned" });
    expect(ok.ok).toBe(true);
  });
});

describe("gate:subscribe / gate:unsubscribe", () => {
  test("subscribe mints an id; unsubscribe reports whether it removed a row", async () => {
    const { handlers } = harness();
    const sub = await handlers["gate:subscribe"]({ subjectPrefix: "run:", session: "s1" });
    expect(sub.ok).toBe(true);
    const subId = (sub as any).data.id;
    const removed = await handlers["gate:unsubscribe"]({ id: subId });
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.data.removed).toBe(true);
    const removedAgain = await handlers["gate:unsubscribe"]({ id: subId });
    if (removedAgain.ok) expect(removedAgain.data.removed).toBe(false);
  });
});
