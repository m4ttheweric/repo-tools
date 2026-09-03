# Gate Facility W1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the rt daemon's gate facility (registry, CAS answer, wait/list/park/close, subscriptions, socket push) so human decisions blocking agent runs can be answered from any surface, first answer wins.

**Architecture:** A persisted SQLite gates store beside the events journal, thin typed daemon handlers mirroring the events bus pattern, gate lifecycle events on the existing bus (dual journal + broadcast path), and a push module that delivers into sessions over the per-session inbox socket. Wave 1 of the three-wave gate-facility spec; a delivery spike runs first and can revise the spec's Delivery section before anything else builds.

**Tech Stack:** Bun + TypeScript, bun:sqlite (WAL), the rt daemon's command-router/handlers seam, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-03-gate-facility-design.md` (this repo, same branch). The plan argues from the spec; executors read both.

## Global Constraints

- Branch: `gate-facility` (worktree merry-feather), based on rt main. All W1 work lands here.
- **NO rt-client npm publish from this branch or from main.** The settings registry keys shipped in rt-client 0.14.0 exist only on the held `gate-events-rt` branch; a publish from anywhere else regresses npm. The gate wrappers added here ride unpublished until W2 merges the branches. (Spec: Coordination notes.)
- Topics: `gate/opened/<id>` and `gate/answered/<id>`. Subscription patterns MUST be spelled `gate/**` (Bun.Glob `*` does not cross `/`).
- Gate events MUST take the dual journal + broadcast path (mirror `events:emit` in `lib/daemon/handlers/events.ts:46-53`), never bare `bus.emitEvent` (it deliberately does not fan out).
- `subject` is an opaque `<prefix>:<id>` string: non-empty, contains a `:`, daemon-uninterpreted beyond prefix filtering.
- CAS everywhere: answer only from `open`/`parked`; park only from `open`; close is terminal and idempotent-rejecting (closing an `answered` gate is a no-op rejection).
- `--by` is informational, not authenticated (spec: Trust boundary). No new auth in W1; all surfaces are local.
- Comments follow clean-code rules: constraints and invariants only, no narration, no review artifacts.
- Full suite + typecheck green before every commit: `bun run test` (which runs `bun test lib commands packages scripts`) and `bunx tsc --noEmit` from the repo root (the exact CI commands).

## File Structure

- `lib/daemon/gates-store.ts` — NEW. The persisted registry: schema, CAS transitions, supersede, waiters. Mirrors `events-bus.ts`'s shape (create fn, interface, `__db` test accessor).
- `lib/daemon/gate-push.ts` — NEW. Delivery: pane push on answered, subscription fan-out on opened/answered, outcome recording, dead-subscription pruning. Consumes `inbox.ts` + `claude-registry.ts`.
- `lib/daemon/handlers/gate.ts` — NEW. Thin typed handlers `gate:*`, mirroring `handlers/events.ts`.
- `lib/daemon/command-router.ts` — MODIFY. Wire `createGateHandlers` (pattern: `command-router.ts:114`).
- `lib/daemon.ts` — MODIFY. Construct the store beside the events bus (`daemon.ts:534-541` idiom, `join(RT_DIR, "gates.db")`).
- `packages/rt-client/src/commands.ts` — MODIFY. `gate:*` rows in the Commands map (pattern: `commands.ts:421-424`) + whitelist entries (`commands.ts:569-572`).
- `packages/rt-client/src/client.ts` — MODIFY. `gateOpen/gateAnswer/gateWait/gateList/gatePark/gateClose/gateSubscribe/gateUnsubscribe` wrappers (pattern: `eventsHead`, `client.ts:324`).
- `commands/gate.ts` — NEW. The `rt gate <verb>` CLI, mirroring `commands/events.ts`.
- Tests in `lib/daemon/__tests__/gates-store.test.ts`, `gates-handlers.test.ts`, `gate-push.test.ts` (harness conventions from `events-bus.test.ts` / `events-handlers.test.ts` / `inbox.test.ts`).

---

### Task 1: The delivery spike — COMPLETE (2026-09-03)

Run live with the operator; findings committed at
`docs/superpowers/spikes/2026-09-03-gate-delivery-spike.md` and the spec's
Delivery section revised on them. What every later task inherits:

- Form dismissal DISPROVEN (three frame variants): attended pushes QUEUE
  and reconcile at the human's next touch. No dismissal logic anywhere.
- Pushes wrap in the `<cross-session-message>` envelope; the body is the
  fixed doorbell phrase only; answers NEVER travel in messages.
- Push outcomes are `delivered` (inbox accepted the frame) and `dead-pane`
  (connect failure). There is no "refused" state on the inbox path.
- Session addressing is by session id via `lib/claude-registry.ts`; the
  opener records its own session in `nudge: { session }` at `gate open`.
- Both full flows proven live: attended (form + external answer + doorbell
  + CAS-loss reconciliation) and unattended (publish + block + external
  answer + proceed, no message at all).
- The emit-before-wait miss in the stub is standing evidence for
  registry-status-first `gate wait`.
- An unprimed session correctly refuses the doorbell as injection; the
  protocol part carries the priming.

---

### Task 2: gates-store — schema and open with supersede

**Files:**
- Create: `lib/daemon/gates-store.ts`
- Test: `lib/daemon/__tests__/gates-store.test.ts`

**Interfaces:**
- Consumes: `bun:sqlite`, `Logger` (pino), `isCorruptionError` from `../state/db.ts` (same guard `events-bus.ts` uses).
- Produces (Tasks 3-9 rely on these exact names):

```ts
export type GateStatus = "open" | "answered" | "parked" | "closed";
export interface GateQuestion { id: string; label: string; multi: boolean; options: string[] }
export interface GateAnswer { answers: Record<string, string | string[] | { value: string | string[]; note?: string }>; by: string; answeredAt: number }
export interface GateRow {
  id: string; subject: string; kind: string;
  questions: GateQuestion[]; meta: Record<string, unknown> | null;
  status: GateStatus; answer: GateAnswer | null;
  openedAt: number; parkedAt: number | null; closedAt: number | null;
  closedReason: "abandoned" | "superseded" | "pruned" | null;
  agent: string | null; pane: string | null;
  nudge: { session: string } | null;
  delivery: { outcome: "delivered" | "dead-pane"; at: number } | null;
  released: boolean;
}
```

Wire types (`GateRow`, `GateStatus`, `GateQuestion`, `GateAnswer`, and Task
4's `GateSubscription`) are DECLARED in `packages/rt-client/src/commands.ts`
and imported by `gates-store.ts` FROM the package: the dependency already
points that way (`handlers/events.ts` imports `Commands` from the package),
and rt-client cannot import from `lib/daemon`. The store file re-exports
them for daemon-side convenience.

```ts
export interface OpenResult { row: GateRow; supersededId: string | null }
export interface GatesStore {
  open(input: { subject: string; kind: string; questions: GateQuestion[]; meta?: Record<string, unknown>; agent?: string; pane?: string; nudge?: { session: string } }): OpenResult;
  get(id: string): GateRow | null;
  list(filter: { open?: boolean; subjectPrefix?: string; kind?: string }): GateRow[];
  answer(id: string, answers: GateAnswer["answers"], by: string): { ok: true; row: GateRow } | { ok: false; reason: "not-found" | "closed" | "already-answered"; row: GateRow | null };
  park(id: string): { ok: true } | { ok: false; reason: "not-found" | "not-open"; row: GateRow | null };
  close(id: string, reason: "abandoned" | "superseded" | "pruned"): { ok: true } | { ok: false; reason: "not-found" | "already-answered" };
  markDelivery(id: string, outcome: "delivered" | "dead-pane"): void;
  markReleased(id: string): void;
  close_(): void; // db close; name avoids the lifecycle verb
  __db?: import("bun:sqlite").Database;
}
export function createGatesStore(opts: { dbPath: string; log: Logger }): GatesStore;
```

- [ ] **Step 1: Write the failing tests** in `lib/daemon/__tests__/gates-store.test.ts` (tmp-dir db per test, the `events-bus.test.ts` harness idiom):

```ts
test("open mints an id and persists the row", () => {
  const s = createGatesStore({ dbPath: tmp("gates.db"), log });
  const { row, supersededId } = s.open({ subject: "run:abc", kind: "clarify", questions: [{ id: "q", label: "Pick", multi: false, options: ["a", "b"] }] });
  expect(row.status).toBe("open");
  expect(supersededId).toBeNull();
  expect(s.get(row.id)?.subject).toBe("run:abc");
});

test("open on a subject with an open gate of the SAME kind supersedes it in one transaction", () => {
  const s = createGatesStore({ dbPath: tmp("gates.db"), log });
  const first = s.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs() }).row;
  const { row: second, supersededId } = s.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs() });
  expect(supersededId).toBe(first.id);
  expect(s.get(first.id)?.status).toBe("closed");
  expect(s.get(first.id)?.closedReason).toBe("superseded");
  expect(s.get(second.id)?.status).toBe("open");
});

test("open does NOT supersede a different kind on the same subject", () => {
  const s = createGatesStore({ dbPath: tmp("gates.db"), log });
  const a = s.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs() }).row;
  const { supersededId } = s.open({ subject: "mr:https://x/1", kind: "doctor-escalation", questions: qs() });
  expect(supersededId).toBeNull();
  expect(s.get(a.id)?.status).toBe("open");
});

test("rows survive close and reopen of the store (persistence)", () => {
  const p = tmp("gates.db");
  const s1 = createGatesStore({ dbPath: p, log });
  const id = s1.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row.id;
  s1.close_();
  const s2 = createGatesStore({ dbPath: p, log });
  expect(s2.get(id)?.status).toBe("open");
});

test("subject validation: rejects empty and colon-less subjects", () => {
  const s = createGatesStore({ dbPath: tmp("gates.db"), log });
  expect(() => s.open({ subject: "", kind: "k", questions: qs() })).toThrow();
  expect(() => s.open({ subject: "nocolon", kind: "k", questions: qs() })).toThrow();
});
```

- [ ] **Step 2: Run to verify failure.** `bun test lib/daemon/__tests__/gates-store.test.ts` — expected: FAIL (module not found).
- [ ] **Step 3: Implement** `createGatesStore`: WAL pragma + `mkdirSync(dirname(dbPath), {recursive:true})` (the `events-bus.ts` open idiom, including the corruption quarantine guard); one `gates` table (columns per `GateRow`, JSON columns as TEXT, `id` TEXT PRIMARY KEY from `crypto.randomUUID()`); `open` wraps supersede + insert in one transaction (`db.transaction`): `UPDATE gates SET status='closed', closed_reason='superseded', closed_at=? WHERE subject=? AND kind=? AND status='open'` capturing the superseded id first, then INSERT.
- [ ] **Step 4: Run to verify pass.** Same command — expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add lib/daemon/gates-store.ts lib/daemon/__tests__/gates-store.test.ts
git commit -m "gates-store: schema, open with same-kind supersede, persistence"
```

---

### Task 3: gates-store — CAS transitions (answer, park, close) and list

**Files:**
- Modify: `lib/daemon/gates-store.ts`
- Test: `lib/daemon/__tests__/gates-store.test.ts` (extend)

**Interfaces:** as declared in Task 2 (answer/park/close/list/markDelivery/markReleased).

- [ ] **Step 1: Write the failing tests**

```ts
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

test("a losing answer FROM THE GATE'S OWN PANE marks it released", () => {
  const s = store();
  const { row } = s.open({ subject: "run:r1", kind: "clarify", questions: qs(), pane: "pane-7" });
  s.answer(row.id, { q: "a" }, "console");
  s.answer(row.id, { q: "b" }, "pane"); // loses, but proves the pane reconciled
  expect(s.get(row.id)?.released).toBe(true);
});

test("list filters by open, subjectPrefix, kind", () => {
  const s = store();
  openGate(s, "run:r1"); openGate(s, "mr:https://x/1");
  const runs = s.list({ open: true, subjectPrefix: "run:" });
  expect(runs.length).toBe(1);
  expect(runs[0]!.subject).toBe("run:r1");
});
```

- [ ] **Step 2: Run to verify failure.** `bun test lib/daemon/__tests__/gates-store.test.ts`
- [ ] **Step 3: Implement.** Each transition is a guarded single UPDATE (`... WHERE id=? AND status IN (...)`) checking `changes`; on zero changes re-read the row to classify the rejection. `answer` accepts from `open` and `parked`; sets `answer` JSON, `status='answered'`. The released-on-losing-pane-answer rule lives inside `answer`'s rejection path: when the losing `by` is `"pane"` and the row has a `pane` ref, `markReleased`. `list` builds WHERE from the filter (`subject LIKE prefix || '%'`).
- [ ] **Step 4: Run to verify pass.** Same command.
- [ ] **Step 5: Run the full suite + typecheck; commit.**

```bash
bun run test && bunx tsc --noEmit
git add lib/daemon/gates-store.ts lib/daemon/__tests__/gates-store.test.ts
git commit -m "gates-store: CAS answer/park/close, release-on-pane-loss, list filters"
```

---

### Task 4: gates-store — waiters (registry-status-first wait) and subscriptions table

**Files:**
- Modify: `lib/daemon/gates-store.ts`
- Test: `lib/daemon/__tests__/gates-store.test.ts` (extend)

**Interfaces (add to `GatesStore`):**

```ts
export interface GateSubscription { id: string; subjectPrefix: string; session: string; createdAt: number; lastDelivery: { outcome: "delivered" | "failed"; at: number } | null; dead: boolean }
// on GatesStore:
wait(id: string, opts: { waitMs?: number; signal?: AbortSignal }): Promise<{ status: "answered" | "closed"; row: GateRow } | { status: "timeout" } | { status: "not-found" }>;
subscribe(input: { subjectPrefix: string; session: string }): GateSubscription;
unsubscribe(id: string): boolean;
subscriptions(filter?: { live?: boolean }): GateSubscription[];
markSubscriptionDelivery(id: string, outcome: "delivered" | "failed"): void;
markSubscriptionDead(id: string): void;
```

- [ ] **Step 1: Write the failing tests**

```ts
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
  s.answer(id, { q: "a" }, "pane");
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
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Waiters: in-memory `Map<gateId, Set<resolver>>` (the `events-bus.ts` waiter idiom, including AbortSignal + timer cleanup); `answer`/`close` wake waiters for that id after the transaction commits, AND `open` wakes the superseded gate's waiters after its transaction commits (return the superseded id from the transaction, then notify) — the supersede path must not bypass the only wake-up code. `wait` reads the row FIRST: missing row resolves `not-found` without registering; answered/closed resolve immediately; only open/parked registers a waiter. Subscriptions: second table in the same db.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit.**

```bash
git add lib/daemon/gates-store.ts lib/daemon/__tests__/gates-store.test.ts
git commit -m "gates-store: registry-status-first waiters, persisted subscriptions"
```

---

### Task 5: gate handlers + Commands typing + daemon wiring

**Files:**
- Create: `lib/daemon/handlers/gate.ts`
- Modify: `packages/rt-client/src/commands.ts` (rows beside `commands.ts:421-424`; whitelist beside `commands.ts:569-572`)
- Modify: `lib/daemon/command-router.ts` (import + opts field `gatesStore` + spread, the `:114` idiom)
- Modify: `lib/daemon.ts` (construct beside the events bus, `daemon.ts:534-541` idiom: `createGatesStore({ dbPath: join(RT_DIR, "gates.db"), log })`)
- Test: `lib/daemon/__tests__/gates-handlers.test.ts`

**Interfaces:**
- Consumes: `GatesStore` (Tasks 2-4), `EventsBus`, `broadcast` (the `createEventsHandlers` signature shape).
- Produces — Commands map rows (Tasks 6-8 and every W2 consumer rely on these exact shapes):

```ts
"gate:open": { payload: { subject: string; kind: string; questions: GateQuestion[]; meta?: Record<string, unknown>; agent?: string; pane?: string; nudge?: { session: string } }; data: { id: string; supersededId: string | null } };
"gate:answer": { payload: { id: string; answers: GateAnswer["answers"]; by: string }; data: { row: GateRow; conflict?: true } };
// CAS loss is a DEFINED OUTCOME, not an error: ok:true with conflict:true and
// the WINNING row, so every consumer gets the winner typed, no envelope hacks.
// ok:false is reserved for not-found/closed/validation failures.
"gate:wait": { payload: { id: string; waitMs?: number }; data: { status: "answered" | "closed" | "timeout"; row?: GateRow } };
// gate:wait on an unknown id returns ok:false "not-found" (terminal; the CLI
// loop must not re-enter on it).
"gate:list": { payload: { open?: boolean; subjectPrefix?: string; kind?: string }; data: { gates: GateRow[] } };
"gate:park": { payload: { id: string }; data: { ok: true } };
"gate:close": { payload: { id: string; reason: "abandoned" | "superseded" | "pruned" }; data: { ok: true } };
"gate:subscribe": { payload: { subjectPrefix: string; session: string }; data: { id: string } };
"gate:unsubscribe": { payload: { id: string }; data: { removed: boolean } };
```

- [ ] **Step 1: Write the failing tests** in `gates-handlers.test.ts` (the `events-handlers.test.ts` harness: real store on a tmp db, fake bus capturing `emitAt`, fake `broadcast` capturing frames):

```ts
test("gate:open emits gate/opened/<id> through the DUAL path (journal emitAt + broadcast)", async () => {
  const { handlers, emitted, broadcasts } = harness();
  const r = await handlers["gate:open"]({ subject: "run:r1", kind: "clarify", questions: qs() });
  expect(r.ok).toBe(true);
  const id = (r as any).data.id;
  expect(emitted[0]!.topic).toBe(`gate/opened/${id}`);
  expect(broadcasts[0]!.type).toBe("event");
  expect((broadcasts[0]!.data as any).payload.subject).toBe("run:r1");
  expect((broadcasts[0]!.data as any).payload.meta).toBeDefined();
});

test("a CAS loss returns ok:true with conflict:true and the WINNING row", async () => {
  const { handlers } = harness();
  const id = (await open(handlers)).id;
  await handlers["gate:answer"]({ id, answers: { q: "a" }, by: "console" });
  const l = await handlers["gate:answer"]({ id, answers: { q: "b" }, by: "pane" });
  expect(l.ok).toBe(true);
  if (l.ok) { expect(l.data.conflict).toBe(true); expect(l.data.row.answer?.by).toBe("console"); }
});

test("note-carrying answer values round-trip (the spec's one free-text channel)", async () => {
  const { handlers, store } = harness(); // question q single-select; question m multi-select
  const id = (await openTwoQuestions(handlers)).id;
  const r = await handlers["gate:answer"]({ id, answers: { q: { value: "a", note: "context" }, m: { value: ["a"], note: "x" } }, by: "pane" });
  expect(r.ok).toBe(true);
  const row = store.get(id)!;
  expect((row.answer!.answers.q as any).note).toBe("context");
});

test("gate:answer validates question ids and multi-shape only; values are opaque", async () => {
  const { handlers } = harness(); // question q is single-select with options ["a","b"]
  const id = (await open(handlers)).id;
  const bad = await handlers["gate:answer"]({ id, answers: { nope: "a" }, by: "pane" });
  expect(bad.ok).toBe(false); // unknown question id
  const free = await handlers["gate:answer"]({ id, answers: { q: "freetext-not-an-option" }, by: "pane" });
  expect(free.ok).toBe(true); // option membership is advisory
});

test("gate:answer emits gate/answered/<id> through BOTH paths with by and paneId", async () => {
  const { handlers, emitted, broadcasts } = harness();
  const id = (await open(handlers, { pane: "pane-7" })).id;
  await handlers["gate:answer"]({ id, answers: { q: "a" }, by: "board" });
  const answered = emitted.find((e) => e.topic === `gate/answered/${id}`)!;
  expect((answered.payload as any).by).toBe("board");
  expect((answered.payload as any).paneId).toBe("pane-7");
  expect(broadcasts.some((b) => (b.data as any)?.topic === `gate/answered/${id}`)).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure.** `bun test lib/daemon/__tests__/gates-handlers.test.ts`
- [ ] **Step 3: Implement** `createGateHandlers(store, bus, broadcast)`: each handler validates minimally (trim strings, subject contains `:`), delegates to the store, and for open/answer emits with ONE timestamp through both `bus.emitAt(topic, payload, t)` and `broadcast("event", frame)` exactly as `events:emit` does. Answer validation accepts BOTH value shapes per question: a bare `string`/`string[]` or `{ value, note? }` (unwrap before the multi-shape check, so notes never fail validation). `gate:wait` threads the request `AbortSignal` into `store.wait` (the widened handler shape `events:wait` uses) and clamps `waitMs` to 240s, under the 255s socket idle timeout, exactly as the events bus clamps, so a large client wait dies as a clean timeout the CLI loop can re-enter, never a socket error. Payloads per spec Events section: opened `{id, subject, kind, questions, meta, agent, pane, label}` (label from `meta.label`, else `kind`), answered `{id, subject, kind, answers, by, paneId}`. Add the Commands rows (which is also where the wire types are DECLARED, per Task 2) + whitelist entries; wire command-router and daemon.ts.
- [ ] **Step 4: Run to verify pass; run the FULL suite** (`bun test`) — the wiring touches daemon assembly, so the whole daemon suite must stay green.
- [ ] **Step 5: Commit.**

```bash
git add lib/daemon/handlers/gate.ts lib/daemon/command-router.ts lib/daemon.ts packages/rt-client/src/commands.ts lib/daemon/__tests__/gates-handlers.test.ts
git commit -m "gate handlers: typed gate:* verbs, dual-path events, daemon wiring"
```

---

### Task 6: gate-push — pane push on answered, subscription fan-out, outcomes

**Files:**
- Create: `lib/daemon/gate-push.ts`
- Modify: `lib/daemon/handlers/gate.ts` (call push after answer/open)
- Test: `lib/daemon/__tests__/gate-push.test.ts`

**Interfaces:**
- Consumes: `deliverToInbox` (`lib/daemon/inbox.ts:7`), `wrapCrossSession` (`lib/daemon/inbox.ts:94`), `resolveInbox`/`resolveAllInboxes` from `lib/claude-registry.ts` (session id to `{socketPath}`), `GatesStore` (markDelivery/markReleased/subscriptions/markSubscriptionDelivery/markSubscriptionDead).
- Produces:

```ts
export const GATE_ANSWERED_PHRASE = (id: string) => `[gate] ${id} answered elsewhere; re-read the registry and proceed on the recorded answer.`;
export interface GatePush {
  onAnswered(row: GateRow): Promise<void>;   // pane push (attended panes with a nudge) + subscription fan-out
  onOpened(row: GateRow): Promise<void>;     // subscription fan-out only
}
export function createGatePush(opts: { store: GatesStore; deliver: typeof deliverToInbox; resolveSession: (sessionId: string) => { socketPath: string } | null; log: Logger; deadAfterFailures?: number }): GatePush;
```

The pane push targets `row.nudge.session` ONLY (spike ruling: the opener
records its own session id at `gate open`; the `pane` ref is for focus and
resume, never delivery; no nudge means no pane push — the unattended case).
`resolveSession` is session-id-to-socket via the claude registry; injected
with `deliver` so tests use fakes and the daemon wires the real ones. The
push body is `wrapCrossSession("gate-facility", GATE_ANSWERED_PHRASE(id))`
— envelope-wrapped fixed phrase, nothing else (spike ruling; answers never
travel in messages). Outcome mapping is pinned by the spike: `deliver`
returning `ok:true` records `delivered` (the inbox accepted the frame);
`ok:false` (connect failure or timeout) and a session id the registry
cannot resolve record `dead-pane`. A successful push does NOT mark
released — only pane-origin reconciliation does (Task 3's rule).

- [ ] **Step 1: Write the failing tests**

```ts
test("onAnswered pushes the ENVELOPE-WRAPPED fixed phrase to nudge.session; records delivered, NOT released", async () => {
  const { push, store, delivered } = harness();
  const row = store.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs(), nudge: { session: "sess-1" } }).row;
  store.answer(row.id, { q: "a" }, "console");
  await push.onAnswered(store.get(row.id)!);
  expect(delivered[0]!.body).toBe(wrapCrossSession("gate-facility", GATE_ANSWERED_PHRASE(row.id)));
  expect(delivered[0]!.sessionId).toBe("sess-1");
  expect(store.get(row.id)!.delivery!.outcome).toBe("delivered");
  expect(store.get(row.id)!.released).toBe(false); // only pane reconciliation releases
});

test("a failed or unresolvable delivery records dead-pane and does NOT mark released", async () => {
  const { push, store } = harness({ deliverOk: false });
  const row = store.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs(), nudge: { session: "sess-gone" } }).row;
  store.answer(row.id, { q: "a" }, "console");
  await push.onAnswered(store.get(row.id)!);
  expect(store.get(row.id)!.delivery!.outcome).toBe("dead-pane");
  expect(store.get(row.id)!.released).toBe(false);
});

test("no nudge means no pane push (unattended gates block in wait; there is nothing to wake)", async () => {
  const { push, store, delivered } = harness();
  const row = store.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row;
  store.answer(row.id, { q: "a" }, "board");
  await push.onAnswered(store.get(row.id)!);
  expect(delivered.length).toBe(0);
});

test("subscription fan-out fires on opened AND answered, matched by subject prefix", async () => {
  const { push, store, delivered } = harness();
  store.subscribe({ subjectPrefix: "run:", session: "shep-1" });
  const row = store.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row;
  await push.onOpened(row);
  store.answer(row.id, { q: "a" }, "console");
  await push.onAnswered(store.get(row.id)!);
  expect(delivered.filter((d) => d.sessionId === "shep-1").length).toBe(2);
});

test("repeated failures mark a subscription dead OBSERVABLY: pruned from live, readable unfiltered with its outcome", async () => {
  const { push, store } = harness({ deliverOk: false, deadAfterFailures: 2 });
  const sub = store.subscribe({ subjectPrefix: "run:", session: "shep-1" });
  const row = store.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row;
  await push.onOpened(row); await push.onOpened(row);
  expect(store.subscriptions({ live: true }).length).toBe(0);
  const dead = store.subscriptions().find((x) => x.id === sub.id)!;
  expect(dead.dead).toBe(true);
  expect(dead.lastDelivery!.outcome).toBe("failed");
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**; then in `handlers/gate.ts` call `push.onAnswered`/`push.onOpened` after the store transition + event emission (fire-and-forget with logged errors — a push failure must never fail the verb). Wire `createGatePush` in `daemon.ts` with the real `deliverToInbox` and claude-registry resolution.
- [ ] **Step 4: Run to verify pass; full suite.**
- [ ] **Step 5: Commit.**

```bash
git add lib/daemon/gate-push.ts lib/daemon/handlers/gate.ts lib/daemon.ts lib/daemon/__tests__/gate-push.test.ts
git commit -m "gate-push: fixed-phrase pane push, subscription fan-out, observable outcomes"
```

---

### Task 7: rt-client wrappers

**Files:**
- Modify: `packages/rt-client/src/client.ts`
- Test: Create `packages/rt-client/src/__tests__/gate-wrappers.test.ts`. There is NO existing daemon-seam harness in the package (its only test is placement logic), so this task builds a minimal one: a throwaway `Bun.listen({ unix })` server that accepts one JSON command frame per connection and responds with a canned `{ ok: true, data }`, speaking the framing `packages/rt-client/src/transport.ts` implements (read that file first; mirror its newline/JSON discipline exactly). Each wrapper test asserts the command name and payload passed through verbatim and the canned data came back typed.

**Interfaces:**
- Produces (W2's board rework consumes these):

```ts
export function gateOpen(p: Commands["gate:open"]["payload"], o?: RtClientOptions): Promise<RtResponse<Commands["gate:open"]["data"]>>;
export function gateAnswer(p: Commands["gate:answer"]["payload"], o?: RtClientOptions): Promise<RtResponse<Commands["gate:answer"]["data"]>>;
export function gateWait(p: Commands["gate:wait"]["payload"], o?: RtClientOptions): Promise<RtResponse<Commands["gate:wait"]["data"]>>;
export function gateList(p: Commands["gate:list"]["payload"], o?: RtClientOptions): Promise<RtResponse<Commands["gate:list"]["data"]>>;
export function gatePark(p: Commands["gate:park"]["payload"], o?: RtClientOptions): Promise<RtResponse<Commands["gate:park"]["data"]>>;
export function gateClose(p: Commands["gate:close"]["payload"], o?: RtClientOptions): Promise<RtResponse<Commands["gate:close"]["data"]>>;
export function gateSubscribe(p: Commands["gate:subscribe"]["payload"], o?: RtClientOptions): Promise<RtResponse<Commands["gate:subscribe"]["data"]>>;
export function gateUnsubscribe(p: Commands["gate:unsubscribe"]["payload"], o?: RtClientOptions): Promise<RtResponse<Commands["gate:unsubscribe"]["data"]>>;
```

- [ ] **Step 1: Write failing tests** against the fake daemon (one round-trip per wrapper asserting command name + payload passthrough, the `eventsHead` test idiom).
- [ ] **Step 2: Verify failure.** - [ ] **Step 3: Implement** (each is the 3-line `eventsHead` shape at `client.ts:324`, exported from the package index like the events wrappers). - [ ] **Step 4: Verify pass + full suite + typecheck.** - [ ] **Step 5: Commit.**

```bash
git add packages/rt-client/src/client.ts packages/rt-client/src/__tests__
git commit -m "rt-client: gate verb wrappers (unpublished until W2)"
```

---

### Task 8: the `rt gate` CLI

**Files:**
- Create: `commands/gate.ts` (mirror `commands/events.ts`: arg parsing, `--json` payloads, exit codes)
- Modify: `lib/command-tree-def.ts` (the CLI command table; the events entry at :10-34 is the registration idiom to mirror)
- Test: `commands/__tests__/gate.test.ts` (the repo's CLI tests live in `commands/__tests__/`): arg->payload mapping for `open`, `answer`, `wait`, `list` (build the payload object and compare, no daemon needed), plus the wait-loop terminal cases (not-found and closed stop the loop; timeout re-enters until the budget is spent)

Verbs and flags (the pane protocol and W2 wrappers consume these exact spellings):

```
rt gate open --subject <s> --kind <k> --questions <json> [--meta <json>] [--agent <id>] [--pane <id>] [--nudge <json>]
rt gate answer <id> --answers <json> --by <surface>
rt gate wait <id> [--timeout <duration>]  # DEFAULT: wait forever (loop until answered/closed; the unattended pane protocol depends on this); --timeout is an opt-in bound taking durations (30s, 5m); not-found is terminal, never re-entered
rt gate list [--open] [--subject-prefix <p>] [--kind <k>]
rt gate park <id>
rt gate close <id> --reason <abandoned|superseded|pruned>
rt gate subscribe --subject-prefix <p> --session <addr>
rt gate unsubscribe <id>
```

- [ ] **Step 1: Write the failing arg-mapping tests.** - [ ] **Step 2: Verify failure.** - [ ] **Step 3: Implement**, including the wait loop: call `gateWait` with `waitMs` capped below the daemon request cap, re-enter on `timeout` until the caller's `--timeout` budget is spent (registry-status-first makes re-entry safe; a daemon restart mid-wait is one more loop iteration). - [ ] **Step 4: Verify pass + full suite.** - [ ] **Step 5: Commit.**

```bash
git add commands/gate.ts commands/__tests__/gate.test.ts lib/command-tree-def.ts
git commit -m "rt gate CLI: open/answer/wait/list/park/close/subscribe/unsubscribe"
```

---

### Task 9: W1 verification pass

**Files:**
- Test: `lib/daemon/__tests__/gates-e2e.test.ts` (in-process: real store + handlers + fake push)
- Create: `docs/superpowers/plans/2026-09-03-gate-facility-w1-verification.md` (the manual checklist run WITH Matt)

- [ ] **Step 1: Write the automated race/lifecycle e2e tests:**

```ts
test("CAS race: two concurrent answers, exactly one wins, loser gets the winner", async () => {
  const { handlers } = harness(); const id = (await open(handlers)).id;
  const [a, b] = await Promise.all([
    handlers["gate:answer"]({ id, answers: { q: "a" }, by: "console" }),
    handlers["gate:answer"]({ id, answers: { q: "b" }, by: "board" }),
  ]);
  expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
});

test("close releases waiters with status closed", async () => {
  const { handlers, store } = harness(); const id = (await open(handlers)).id;
  const w = store.wait(id, { waitMs: 5000 });
  await handlers["gate:close"]({ id, reason: "abandoned" });
  expect((await w).status).toBe("closed");
});

test("wait re-entry across a store close/reopen (daemon restart) resumes correctly", async () => {
  const p = tmp("gates.db");
  const s1 = createGatesStore({ dbPath: p, log });
  const id = s1.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row.id;
  s1.close_();                                     // "restart"
  const s2 = createGatesStore({ dbPath: p, log });
  const w = s2.wait(id, { waitMs: 5000 });         // re-entry: registry-status-first
  s2.answer(id, { q: "a" }, "pane");
  expect((await w).status).toBe("answered");
});
```

- [ ] **Step 2: Verify failure, implement any gaps they expose, verify pass, full suite + typecheck.**
- [ ] **Step 3: Write the manual checklist doc** (each item one line, run live with Matt): two-terminal CAS race via `rt gate answer` x2; `rt gate wait` in one pane answered from another; a real `gate subscribe` push received by a second session; daemon restart mid-wait.
- [ ] **Step 4: Commit.**

```bash
git add lib/daemon/__tests__/gates-e2e.test.ts docs/superpowers/plans/2026-09-03-gate-facility-w1-verification.md
git commit -m "gates: e2e race/lifecycle tests + manual W1 verification checklist"
```

---

## After W1

W2 (board rework + review skills layer + held-family merge) and W3 (pipeline part, console, respond, doctor, shepherdr) get their own plans, written against W1's real shapes and the spike's recorded findings — the spec's waves section is their scope contract. The W1 merge to rt main is a stop-gate for Matt, as is every push.
