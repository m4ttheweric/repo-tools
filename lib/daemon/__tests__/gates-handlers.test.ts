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

  test("rejects duplicate question ids (F10): an opener typo must not mint an unanswerable gate", async () => {
    const { handlers } = harness();
    const dup = [
      { id: "q", label: "Pick", multi: false, options: ["a", "b"] },
      { id: "q", label: "Pick again", multi: false, options: ["c", "d"] },
    ];
    const r = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: dup });
    expect(r.ok).toBe(false);
  });

  test("rejects a meta that isn't a plain object (F10)", async () => {
    const { handlers } = harness();
    const arr = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), meta: ["not", "an", "object"] as any });
    expect(arr.ok).toBe(false);
    const str = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), meta: "nope" as any });
    expect(str.ok).toBe(false);
    const ok = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), meta: { label: "fine" } });
    expect(ok.ok).toBe(true);
  });

  test("rejects a malformed nudge; accepts string pane/agent, rejects non-string ones (CodeRabbit)", async () => {
    const { handlers } = harness();
    const badNudgeNotObject = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), nudge: "sess-1" as any });
    expect(badNudgeNotObject.ok).toBe(false);
    const badNudgeNoSession = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), nudge: {} as any });
    expect(badNudgeNoSession.ok).toBe(false);
    const badNudgeNumericSession = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), nudge: { session: 7 } as any });
    expect(badNudgeNumericSession.ok).toBe(false);
    const goodNudge = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), nudge: { session: "sess-1" } });
    expect(goodNudge.ok).toBe(true);

    const badPane = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), pane: 7 as any });
    expect(badPane.ok).toBe(false);
    const goodPane = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), pane: "!7" });
    expect(goodPane.ok).toBe(true);

    const badAgent = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), agent: 7 as any });
    expect(badAgent.ok).toBe(false);
    const goodAgent = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), agent: "ag-1" });
    expect(goodAgent.ok).toBe(true);
  });

  test("the opened payload's pane field is named paneId (F5)", async () => {
    const { handlers, emitted } = harness();
    await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs(), pane: "pane-9" });
    expect((emitted[0]!.payload as any).paneId).toBe("pane-9");
    expect((emitted[0]!.payload as any).pane).toBeUndefined();
  });

  test("supersede emits gate/closed on the OLD gate, both paths, with supersededBy (F4)", async () => {
    const { handlers, emitted, broadcasts } = harness();
    const first = await open(handlers, {});
    const second = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs() });
    if (!second.ok) throw new Error("open failed");
    const closedEvent = emitted.find((e) => e.topic === `gate/closed/${first.id}`)!;
    expect((closedEvent.payload as any).reason).toBe("superseded");
    expect((closedEvent.payload as any).supersededBy).toBe(second.data.id);
    expect(broadcasts.some((b) => (b.data as any)?.topic === `gate/closed/${first.id}`)).toBe(true);
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

  test("validates question ids; a single-select non-member value is rejected (SKILLS-58)", async () => {
    const { handlers } = harness();
    const id = (await open(handlers)).id;
    const bad = await handlers["gate:answer"]({ id, answers: { nope: "a" }, by: "pane" });
    expect(bad.ok).toBe(false); // unknown question id
    const nonMember = await handlers["gate:answer"]({ id, answers: { q: "freetext-not-an-option" }, by: "pane" });
    expect(nonMember.ok).toBe(false); // option membership is strict once a question declares options
  });

  test("accepts a single-select value that IS a member of its options", async () => {
    const { handlers } = harness();
    const id = (await open(handlers)).id;
    const r = await handlers["gate:answer"]({ id, answers: { q: "a" }, by: "pane" });
    expect(r.ok).toBe(true);
  });

  test("rejects a multi answer where one element is not a member of its options", async () => {
    const { handlers } = harness();
    const id = (await openTwoQuestions(handlers)).id;
    const r = await handlers["gate:answer"]({ id, answers: { m: ["a", "not-an-option"] }, by: "pane" });
    expect(r.ok).toBe(false);
  });

  test("accepts a multi answer where every element is a member of its options", async () => {
    const { handlers, store } = harness();
    const id = (await openTwoQuestions(handlers)).id;
    const r = await handlers["gate:answer"]({ id, answers: { q: "a", m: ["a", "b"] }, by: "pane" });
    expect(r.ok).toBe(true);
    expect(store.get(id)!.answer!.answers.m).toEqual(["a", "b"]);
  });

  test("accepts a wrapped {value, note} answer when the unwrapped value is a member", async () => {
    const { handlers } = harness();
    const id = (await open(handlers)).id;
    const r = await handlers["gate:answer"]({ id, answers: { q: { value: "a", note: "context" } }, by: "pane" });
    expect(r.ok).toBe(true);
  });

  test("an option-less question still accepts free text", async () => {
    const { handlers } = harness();
    const r0 = await handlers["gate:open"]({
      subject: "run:r1", kind: "clarify",
      questions: [{ id: "q", label: "Anything", multi: false, options: [] }],
    });
    if (!r0.ok) throw new Error("open failed");
    const r = await handlers["gate:answer"]({ id: r0.data.id, answers: { q: "anything goes" }, by: "pane" });
    expect(r.ok).toBe(true);
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

  test("release-on-loss emits gate/released through BOTH paths (F4)", async () => {
    const { handlers, emitted, broadcasts } = harness();
    const id = (await open(handlers, { pane: "pane-7" })).id;
    await handlers["gate:answer"]({ id, answers: { q: "a" }, by: "console" }); // winner
    const loser = await handlers["gate:answer"]({ id, answers: { q: "b" }, by: "pane" }); // loses, but reconciles
    expect(loser.ok).toBe(true);
    const released = emitted.find((e) => e.topic === `gate/released/${id}`)!;
    expect(released).toBeDefined();
    expect((released.payload as any).paneId).toBe("pane-7");
    expect(broadcasts.some((b) => (b.data as any)?.topic === `gate/released/${id}`)).toBe(true);
  });

  test("release-on-win emits gate/released too, and a redundant later pane answer does NOT re-emit", async () => {
    const { handlers, emitted } = harness();
    const id = (await open(handlers, { pane: "pane-7" })).id;
    await handlers["gate:answer"]({ id, answers: { q: "a" }, by: "pane" }); // wins AND releases
    expect(emitted.filter((e) => e.topic === `gate/released/${id}`).length).toBe(1);
    await handlers["gate:answer"]({ id, answers: { q: "b" }, by: "pane" }); // already released
    expect(emitted.filter((e) => e.topic === `gate/released/${id}`).length).toBe(1); // no re-fire
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

  test("an empty answers object is rejected — {} must never terminally win a gate (F2)", async () => {
    const { handlers, store } = harness();
    const id = (await open(handlers)).id;
    const r = await handlers["gate:answer"]({ id, answers: {}, by: "pane" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("q");
    expect(store.get(id)!.status).toBe("open"); // never recorded
  });

  test("a partial answer on a two-question gate is rejected, naming the missing id", async () => {
    const { handlers, store } = harness();
    const id = (await openTwoQuestions(handlers)).id;
    const r = await handlers["gate:answer"]({ id, answers: { q: "a" }, by: "pane" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("m");
    expect(store.get(id)!.status).toBe("open");
  });

  test("an intentional empty multi-select still passes once every question id is present", async () => {
    const { handlers } = harness();
    const r0 = await handlers["gate:open"]({
      subject: "run:r1", kind: "clarify",
      questions: [{ id: "tiers", label: "Pick tiers", multi: true, options: ["a", "b"] }],
    });
    if (!r0.ok) throw new Error("open failed");
    const r = await handlers["gate:answer"]({ id: r0.data.id, answers: { tiers: [] }, by: "pane" });
    expect(r.ok).toBe(true);
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
    if (r.ok && r.data.status !== "timeout") { expect(r.data.status).toBe("answered"); expect(r.data.row.id).toBe(id); }
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

  test("park emits gate/parked through BOTH paths (F4)", async () => {
    const { handlers, emitted, broadcasts } = harness();
    const id = (await open(handlers)).id;
    await handlers["gate:park"]({ id });
    const parked = emitted.find((e) => e.topic === `gate/parked/${id}`)!;
    expect(parked).toBeDefined();
    expect((parked.payload as any).id).toBe(id);
    expect(broadcasts.some((b) => (b.data as any)?.topic === `gate/parked/${id}`)).toBe(true);
  });

  test("close emits gate/closed through BOTH paths, carrying the reason (F4)", async () => {
    const { handlers, emitted, broadcasts } = harness();
    const id = (await open(handlers)).id;
    await handlers["gate:close"]({ id, reason: "pruned" });
    const closed = emitted.find((e) => e.topic === `gate/closed/${id}`)!;
    expect((closed.payload as any).reason).toBe("pruned");
    expect(broadcasts.some((b) => (b.data as any)?.topic === `gate/closed/${id}`)).toBe(true);
  });

  test("list clamps an omitted limit and pages via cursor (F7)", async () => {
    const { handlers } = harness();
    for (let i = 0; i < 3; i++) await open(handlers);
    const full = await handlers["gate:list"]({});
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.data.gates).toHaveLength(3);
    const page1 = await handlers["gate:list"]({ limit: 2 });
    if (!page1.ok) throw new Error("list failed");
    expect(page1.data.gates).toHaveLength(2);
    const page2 = await handlers["gate:list"]({ limit: 2, cursor: page1.data.cursor });
    if (!page2.ok) throw new Error("list failed");
    expect(page2.data.gates).toHaveLength(1);
  });

  test("clamps a client-supplied limit above the 1000 ceiling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-gates-handlers-"));
    dirs.push(dir);
    const realStore: GatesStore = createGatesStore({ dbPath: join(dir, "gates.db"), log });
    let seenLimit: number | undefined;
    const store: GatesStore = {
      ...realStore,
      list: (filter) => { seenLimit = filter.limit; return realStore.list(filter); },
    };
    const bus = { emitAt: () => 1 } as unknown as EventsBus;
    const handlers = createGateHandlers(store, bus, () => {});
    const r = await handlers["gate:list"]({ limit: 5000 });
    expect(r.ok).toBe(true);
    expect(seenLimit).toBe(1000); // a gate row carries full questions+answers JSON, so a client can't force an oversized read
  });
});

describe("gate:subscribe / gate:unsubscribe / gate:subscriptions", () => {
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

  test("subscribe is idempotent: re-subscribing the same (prefix, session) returns the same id (F3)", async () => {
    const { handlers } = harness();
    const first = await handlers["gate:subscribe"]({ subjectPrefix: "run:", session: "s1" });
    const second = await handlers["gate:subscribe"]({ subjectPrefix: "run:", session: "s1" });
    if (!first.ok || !second.ok) throw new Error("subscribe failed");
    expect(second.data.id).toBe(first.data.id);
  });

  test("subscriptions reads filter by session/live and include dead rows unfiltered (F3)", async () => {
    const { handlers, store } = harness();
    const a = await handlers["gate:subscribe"]({ subjectPrefix: "run:", session: "s1" });
    await handlers["gate:subscribe"]({ subjectPrefix: "mr:", session: "s2" });
    if (!a.ok) throw new Error("subscribe failed");
    store.markSubscriptionDead(a.data.id);

    const liveOnly = await handlers["gate:subscriptions"]({ live: true });
    if (!liveOnly.ok) throw new Error("subscriptions failed");
    expect(liveOnly.data.subscriptions).toHaveLength(1);

    const all = await handlers["gate:subscriptions"]({});
    if (!all.ok) throw new Error("subscriptions failed");
    expect(all.data.subscriptions).toHaveLength(2); // dead row still readable unfiltered

    const bySession = await handlers["gate:subscriptions"]({ session: "s2" });
    if (!bySession.ok) throw new Error("subscriptions failed");
    expect(bySession.data.subscriptions).toHaveLength(1);
    expect(bySession.data.subscriptions[0]!.session).toBe("s2");
  });
});
