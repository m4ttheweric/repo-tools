# rt chat — web viewer (plan 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser view of the chat rooms — live transcript, who is actually listening, and a composer so Matt can answer his agents from a phone.

**Architecture:** A Bun + Hono server that reaches the rt daemon through `@mattstack/rt-client` over the unix socket, plus a Vite/React client. One `subscribe()` per process is filtered server-side to chat frames and republished onto a Bun pub/sub topic, so tab count never multiplies daemon load. Registered with deck for HTTPS, supervision, and public access control.

**Tech Stack:** Bun, Hono, Vite, React, Mantine (via `create-mantine-kit`), `@mattstack/rt-client`, TanStack Query, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-rt-chat-design.md` — read the **Web viewer** and **Notifications** sections before Task 1. On any conflict, the spec wins.

**Depends on:** plan 1 (`docs/superpowers/plans/2026-08-23-rt-chat-core.md`) **Task 6 only** — the exported rt-client wrappers and types. Nothing here needs plan 1's CLI, skill, or hook, and **no `/api/chat/*` REST routes exist on the daemon**; this server is the only chat HTTP surface that will ever exist.

**Reference implementation:** `~/Documents/GitHub/console` is the precedent for every structural decision below. Read `src/server/{app,index,ws,runs}.ts` before Task 2.

**Repo:** a new sibling checkout at `~/Documents/GitHub/chat`, beside `repo-tools`. That siblinghood is load-bearing — see Global Constraints.

## Global Constraints

- **`@mattstack/rt-client` NEVER throws.** `rtCommand` wraps its whole fetch in try/catch and returns `{ ok: false, error: "rt daemon unreachable at <sock>: ..." }` for connection-refused exactly as for a refusal. **Console's `runs.ts` and `runs.test.ts` both state the opposite** — that a throw means unreachable and falls through to `app.onError` as a 500. That is wrong; the test passes only because it mocks a rejection the real client cannot produce. **Do not copy that comment or that test.** Daemon-down and daemon-refused are indistinguishable by shape, which is why Task 4 exists.
- **The dependency is a relative file path to a sibling checkout:** `"@mattstack/rt-client": "file:../repo-tools/packages/rt-client"`. The viewer does not build if cloned without repo-tools beside it. Say so in its README.
- **`hono/bun` reads the `Bun` global at module load.** Any module that must stay importable under vitest's Node runtime cannot import it. The `/ws` route registers in `index.ts` only — never in `app.ts`, never in `ws.ts`.
- **Routes are chained and handlers inline.** A handler lifted into a named function loses path-param typing, and an unchained `app.get(...)` never reaches `typeof routes`. This is Hono RPC inference, not style.
- **Never render an agent status while the daemon is unreachable.** Statuses are only meaningful when the daemon answers; see Task 4.
- **The page must not scroll horizontally at 375px.** The composer is the reason this app is published; a desktop layout that technically reflows is a failure.
- **Clean-code comments only.** A comment states a constraint the code cannot show. No narration, no ticket numbers, no decision history in source.
- **Commits:** prefix `chat-viewer:`, trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Test gate:** `bun test` (or `vitest run`) and `tsc -b` pass before every commit.

---

## File structure (what exists after this plan)

```
package.json                   NEW: file: dep on ../repo-tools/packages/rt-client
src/server/index.ts            NEW: entry — Bun.serve, /ws route, relay start
src/server/app.ts              NEW: Hono app, chained routes, import-safe under vitest
src/server/chat.ts             NEW: /api/chat/* routes over rt-client wrappers
src/server/health.ts           NEW: the daemon probe route
src/server/ws.ts               NEW: startRelay — one subscribe(), chat-filtered, fanned out
src/server/*.test.ts           NEW: one beside each server module
src/ui/RoomRail.tsx            NEW
src/ui/Transcript.tsx          NEW
src/ui/MemberList.tsx          NEW
src/ui/Composer.tsx            NEW
src/ui/DaemonBanner.tsx        NEW
src/app/App.tsx                NEW: layout + the banner-supersedes-status rule
src/main.tsx                   NEW: Vite entry
```

Server modules split by responsibility, not layer: `chat.ts` owns every route that reads or writes chat, `health.ts` owns the probe, `ws.ts` owns the relay. `ws.ts` stays free of `hono/bun` so it is unit-testable.

---

### Task 1: Scaffold, health route, and deck registration

A walking skeleton: a real page on a real https name before any chat feature exists.

**Files:**
- Create: the `create-mantine-kit` scaffold at `~/Documents/GitHub/chat`
- Create: `src/server/index.ts`, `src/server/app.ts`, `src/server/health.ts`
- Test: `src/server/health.test.ts`

**Interfaces:**
- Produces: `export const health: Hono` mounting `GET /api/health`; `export const app: Hono`.

- [ ] **Step 1: Scaffold**

```bash
cd ~/Documents/GitHub
bun create mantine-kit chat
cd chat
```

Then add the rt-client dependency by hand — it is a local path, not a registry package:

```json
"@mattstack/rt-client": "file:../repo-tools/packages/rt-client"
```

Take from console: Vite, React, Mantine, Hono, TanStack Query, zod, vitest. **Do not** take Storybook, CodeMirror, `@mantine/spotlight`, `@tanstack/react-virtual`, or the `build:binary` / `generate:embedded` path — all overkill here, and the binary path buys nothing when deck supervises the process.

- [ ] **Step 2: Write the failing test**

```ts
// src/server/health.test.ts
import { expect, test } from "vitest";
import { app } from "./app";

test("GET /api/health reports ok with a version", async () => {
  const res = await app.request("/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
});

test("app.ts is importable without the Bun global", async () => {
  // Guards the hono/bun constraint: this suite runs on vitest's Node
  // runtime, so a stray `hono/bun` import here fails at module load.
  await expect(import("./app")).resolves.toBeDefined();
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bunx vitest run src/server/health.test.ts`
Expected: FAIL — no module `./app`.

- [ ] **Step 4: Implement**

`app.ts` holds a chained `new Hono().get('/api/health', ...).route('/', health)` and exports it. `index.ts` calls `Bun.serve` and is the **only** file importing `hono/bun`.

- [ ] **Step 5: Register with deck**

```bash
deck add chat --cmd "bun src/server/index.ts" --dir ~/Documents/GitHub/chat
```

Confirm `https://chat.localhost/api/health` answers. Paste the response into your report.

- [ ] **Step 6: Commit**

```bash
git init && git add -A
git commit -m "chat-viewer: scaffold, health route, deck registration

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Chat read routes over rt-client

**Files:**
- Create: `src/server/chat.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/chat.test.ts`

**Interfaces:**
- Consumes, from plan 1 Task 6: `chatRooms`, `chatWho`, `chatMessages`, and the types `ChatMember`, `ChatMessage`, `RoomSummary`, `WakeMode`.
- Produces: `export const chat: Hono` mounting `GET /api/chat/rooms`, `/api/chat/who/:room`, `/api/chat/messages/:room`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/chat.test.ts
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("@mattstack/rt-client", () => ({
  chatRooms: vi.fn(),
  chatWho: vi.fn(),
  chatMessages: vi.fn(),
}));
const rt = await import("@mattstack/rt-client");
const { app } = await import("./app");

beforeEach(() => vi.resetAllMocks());

test("rooms returns the daemon's payload", async () => {
  vi.mocked(rt.chatRooms).mockResolvedValueOnce({ ok: true, data: { rooms: [] } });
  const res = await app.request("/api/chat/rooms?handle=matt");
  expect(res.status).toBe(200);
});

test("an ok:false from the daemon becomes a 502, not a crash", async () => {
  vi.mocked(rt.chatRooms).mockResolvedValueOnce({ ok: false, error: "nope" });
  expect((await app.request("/api/chat/rooms?handle=matt")).status).toBe(502);
});

test("daemon-unreachable ALSO arrives as ok:false, never a throw", async () => {
  // rt-client cannot throw: rtCommand catches everything and returns
  // ok:false with an "rt daemon unreachable at <sock>" prefix. Console's
  // runs.ts comment and runs.test.ts both claim otherwise and are wrong --
  // that test passes only by mocking a rejection the real client cannot
  // produce. Never write a mockRejectedValue against rt-client here.
  vi.mocked(rt.chatRooms).mockResolvedValueOnce({
    ok: false,
    error: "rt daemon unreachable at /x/rt.sock: ECONNREFUSED",
  });
  expect((await app.request("/api/chat/rooms?handle=matt")).status).toBe(502);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/server/chat.test.ts`
Expected: FAIL — route not found (404, not 200/502).

- [ ] **Step 3: Implement**

Follow console's `runs.ts` shape — chained routes, inline handlers, `if (!res.ok) return c.json({ error: res.error }, 502)` — but **not** its comment about throws. The handle comes from the query string, defaulting to the `chat.humanHandle` setting.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/chat.ts src/server/chat.test.ts src/server/app.ts
git commit -m "chat-viewer: chat read routes over rt-client

rt-client never throws; daemon-down and daemon-refused are both ok:false
and both map to 502. Console's runs.ts says otherwise and is wrong.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The relay — one subscription, fanned out

**Files:**
- Create: `src/server/ws.ts`
- Modify: `src/server/index.ts`
- Test: `src/server/ws.test.ts`

**Interfaces:**
- Consumes: `subscribe` from `@mattstack/rt-client`.
- Produces: `export function startRelay(publish: (topic: string, data: string) => void): () => void`

- [ ] **Step 1: Write the failing test**

```ts
// src/server/ws.test.ts
import { expect, test, vi } from "vitest";

const handlers: Array<(type: string, data: unknown) => void> = [];
vi.mock("@mattstack/rt-client", () => ({
  subscribe: (cb: (type: string, data: unknown) => void) => { handlers.push(cb); return () => {}; },
}));
const { startRelay } = await import("./ws");

test("republishes chat frames and drops everything else", () => {
  const published: string[] = [];
  startRelay((topic) => published.push(topic));
  const emit = handlers[0]!;
  emit("event", { topic: "chat/build/msg", payload: { id: 1 } });
  emit("event", { topic: "chat/wake/agent-a", payload: { id: 1 } });
  emit("event", { topic: "run-updated", payload: {} });
  emit("ports", {});
  expect(published).toEqual(["chat"]);
});

test("matches chat topics by prefix, not equality", () => {
  // Console filters `frame.topic !== 'run-updated'` -- one fixed topic. Chat
  // topics carry the room, so equality would drop every real message.
  const published: string[] = [];
  startRelay((topic) => published.push(topic));
  handlers.at(-1)!("event", { topic: "chat/some-other-room/msg", payload: { id: 2 } });
  expect(published).toEqual(["chat"]);
});

test("ws.ts does not import hono/bun", async () => {
  const src = await import("fs").then(fs => fs.readFileSync("src/server/ws.ts", "utf8"));
  expect(src).not.toContain("hono/bun");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/server/ws.test.ts`
Expected: FAIL — no module `./ws`.

- [ ] **Step 3: Implement**

Copy console's `startRelay` shape: one `subscribe()` for the whole process, return the unsubscribe, and filter **server-side** — drop anything where `type !== "event"`, then keep only topics beginning `chat/`. Server-side filtering is what stops an unrelated daemon tick from making every open tab refetch.

`chat/wake/<handle>` frames are republished too: the viewer uses them to flip a member to *live* without waiting for the next poll.

- [ ] **Step 4: Register `/ws` in `index.ts`**

In `index.ts` only — `app.ts` and `ws.ts` must stay importable under vitest's Node runtime. Subscribe each socket to the `chat` topic in `onOpen`, via `socket.raw`. No middleware may touch this route: header-modifying middleware plus the websocket helper throws on immutable headers.

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/ws.ts src/server/ws.test.ts src/server/index.ts
git commit -m "chat-viewer: one daemon subscription, chat-filtered, fanned out

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The daemon probe and banner

**This task exists because of a specific failure mode, and an implementer who does not understand it will build the wrong thing.** `subscribe()` reconnects silently forever, so a stopped daemon does not error — the live pane simply goes quiet. Without a probe, "the daemon is dead" and "every agent is idle" render identically, which defeats the one thing this viewer earns its keep on: telling you which agent stopped listening.

**Files:**
- Modify: `src/server/health.ts`
- Create: `src/ui/DaemonBanner.tsx`
- Modify: `src/app/App.tsx`
- Test: `src/server/health.test.ts`, `src/ui/DaemonBanner.test.tsx`

**Interfaces:**
- Produces: `GET /api/daemon` → `{ reachable: boolean; error?: string }`; `<DaemonBanner reachable={boolean} />`

- [ ] **Step 1: Write the failing tests**

```ts
test("GET /api/daemon reports unreachable rather than 500ing", async () => {
  vi.mocked(rt.chatRooms).mockResolvedValueOnce({
    ok: false, error: "rt daemon unreachable at /x/rt.sock: ECONNREFUSED",
  });
  const res = await app.request("/api/daemon");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ reachable: false });
});
```

```tsx
test("the banner supersedes agent statuses", () => {
  render(<App initialState={{ daemonReachable: false, members: [{ handle: "a", status: "live" }] }} />);
  expect(screen.getByRole("status")).toHaveTextContent(/daemon/i);
  expect(screen.queryByText(/will hear you/i)).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run`
Expected: FAIL — `/api/daemon` 404s.

- [ ] **Step 3: Implement**

The probe is a cheap daemon command whose `ok` is the answer; `reachable` is `res.ok`. It returns **200 with `reachable: false`** rather than an error status — the probe succeeded in learning the daemon is down, which is not itself a server failure.

The client polls it on an interval. When unreachable: render a distinct banner, **grey the member list, and report nobody as idle or deaf.** Agent status is only meaningful while the daemon is reachable — a member list rendered from stale data during an outage is exactly the lie this task exists to prevent.

- [ ] **Step 4: Integration test — a stopped daemon renders as a stopped daemon**

This is spec integration test 5. Stop the daemon, load the page, assert the banner appears and no member renders as live. It is the test that would have caught the original defect.

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/health.ts src/ui/DaemonBanner.tsx src/app/App.tsx src/server/health.test.ts src/ui/DaemonBanner.test.tsx
git commit -m "chat-viewer: daemon probe and banner

subscribe() reconnects silently, so a dead daemon looks identical to an
idle fleet without an explicit probe.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Rooms rail and live transcript

**Files:**
- Create: `src/ui/RoomRail.tsx`, `src/ui/Transcript.tsx`
- Modify: `src/app/App.tsx`
- Test: `src/ui/RoomRail.test.tsx`, `src/ui/Transcript.test.tsx`

**Interfaces:**
- Consumes: `RoomSummary`, `ChatMessage`; `GET /api/chat/rooms`, `/api/chat/messages/:room`; the `chat` WS topic.

- [ ] **Step 1: Write the failing tests**

```tsx
test("mention badges are visually distinct from plain unread", () => {
  render(<RoomRail rooms={[{ room: "build", memberCount: 3, unread: 4, mentions: 1 }]} />);
  expect(screen.getByLabelText("1 mention")).toBeInTheDocument();
  expect(screen.getByLabelText("4 unread")).toBeInTheDocument();
});

test("a chat frame appends to the transcript without a refetch", async () => {
  const { pushFrame } = renderTranscriptWithFakeSocket({ room: "build", messages: [] });
  pushFrame({ topic: "chat/build/msg", payload: { id: 7 } });
  expect(await screen.findByTestId("message-7")).toBeInTheDocument();
});

test("a frame for another room does not append here", async () => {
  const { pushFrame } = renderTranscriptWithFakeSocket({ room: "build", messages: [] });
  pushFrame({ topic: "chat/other/msg", payload: { id: 8 } });
  expect(screen.queryByTestId("message-8")).toBeNull();
});

test("wide content scrolls inside its own container, not the page", () => {
  render(<Transcript room="build" messages={[longCodeBlockMessage]} />);
  expect(getComputedStyle(screen.getByTestId("transcript")).overflowX).toBe("auto");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run src/ui/`
Expected: FAIL — no `RoomRail` module.

- [ ] **Step 3: Implement**

The transcript appends from WS frames and scroll-backs through `GET /api/chat/messages/:room` with `before`. **A frame carries only `{ id }` — a pointer, not prose** (chat owns the message store; the journal is the doorbell), so the client fetches the message body on arrival or refetches the tail.

Mention badges must be distinguishable without color alone.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/RoomRail.tsx src/ui/Transcript.tsx src/app/App.tsx src/ui/*.test.tsx
git commit -m "chat-viewer: rooms rail and live transcript

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Member list — live, idle, deaf

**Files:**
- Create: `src/ui/MemberList.tsx`
- Test: `src/ui/MemberList.test.tsx`

**Interfaces:**
- Consumes: `ChatMember` (`armedAt`, `lastSeenAt`, `cwd`, `pane`).

- [ ] **Step 1: Write the failing test**

```tsx
const now = 1_700_000_000_000;

test("live requires BOTH an armed waiter and a fresh heartbeat", () => {
  render(<MemberList now={now} members={[
    { handle: "a", armedAt: now - 1000, lastSeenAt: now - 60_000 },
    { handle: "b", armedAt: now - 1000, lastSeenAt: now - 20 * 60_000 },
    { handle: "c", armedAt: undefined, lastSeenAt: now - 60_000 },
    { handle: "d", armedAt: undefined, lastSeenAt: now - 5 * 60 * 60_000 },
  ]} />);
  expect(screen.getByTestId("status-a")).toHaveTextContent("live");
  expect(screen.getByTestId("status-b")).toHaveTextContent("deaf");
  expect(screen.getByTestId("status-c")).toHaveTextContent("idle");
  expect(screen.getByTestId("status-d")).toHaveTextContent("deaf");
});

test("a member is identified by what it is, not just its handle", () => {
  render(<MemberList now={now} members={[
    { handle: "acme-dev-42", cwd: "~/GitHub/acme", pane: "4", armedAt: now, lastSeenAt: now },
  ]} />);
  expect(screen.getByText(/~\/GitHub\/acme/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/ui/MemberList.test.tsx`
Expected: FAIL — no module.

- [ ] **Step 3: Implement**

| status | condition |
|---|---|
| live | `armedAt` set **and** `lastSeenAt` within **10 minutes** |
| idle | no `armedAt`, `lastSeenAt` within **1 hour** |
| **deaf** | anything else |

The 10-minute threshold absorbs two missed long-poll cycles (~4 min each) before a working agent is misreported as deaf — do not tighten it without changing that reasoning.

`deaf` is the status that earns this view its keep: it surfaces the one failure the CLI cannot prevent, so you can see which agent stopped listening before wasting a message on it.

Show each member's `cwd`, branch, and pane. Handles are derived and terse, so identifying *which* agent is speaking matters more here than in human chat. Clicking a member focuses its herdr pane; this degrades to nothing when viewed remotely, so it must not be the only way to read the row.

`now` is a prop so the thresholds are testable without faking timers.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/MemberList.tsx src/ui/MemberList.test.tsx
git commit -m "chat-viewer: member list with live/idle/deaf

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Composer, mobile, and publishing

**Files:**
- Create: `src/ui/Composer.tsx`
- Modify: `src/server/chat.ts` (the post route), `src/app/App.tsx`
- Test: `src/ui/Composer.test.tsx`, `src/server/chat.test.ts`

**Interfaces:**
- Consumes: `chatPost`, `chatJoin` from plan 1 Task 6.
- Produces: `POST /api/chat/post`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a dropped write surfaces as an error, never a silent success", async () => {
  // plan 1 maps an exhausted retry budget to ok:false precisely so this
  // path cannot look like the normal silent success of a post.
  vi.mocked(rt.chatPost).mockResolvedValueOnce({ ok: false, error: "write dropped" });
  expect((await app.request("/api/chat/post", { method: "POST", body: JSON.stringify({ room: "r", body: "x" }) })).status).toBe(502);
});
```

```tsx
test("posting into a room you have not joined auto-joins first", async () => {
  vi.mocked(rt.chatPost).mockResolvedValueOnce({ ok: true, data: { id: 1, recipients: [] } });
  render(<Composer room="build" />);
  await userEvent.type(screen.getByRole("textbox"), "hello{enter}");
  expect(rt.chatJoin).toHaveBeenCalled();
});

test("@ autocompletes from room members", async () => {
  render(<Composer room="build" members={[{ handle: "acme-dev-42" }]} />);
  await userEvent.type(screen.getByRole("textbox"), "@ass");
  expect(await screen.findByText("acme-dev-42")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run`
Expected: FAIL — no `Composer` module, `/api/chat/post` 404s.

- [ ] **Step 3: Implement**

Posts as the `chat.humanHandle` setting (default `matt`). Posting into a room not yet joined auto-joins, consistent with plan 1's join-creates.

- [ ] **Step 4: Verify on a phone-sized viewport**

Load the page at **375px** wide and confirm: no horizontal page scroll, the composer is usable, and wide content scrolls inside its own container. **Screenshot it and put the screenshot in your report** — this is the reason the app is published, and "it reflows" is not the same as "it is usable."

- [ ] **Step 5: Publish**

```bash
deck domain m4tthew.dev     # if not already configured
# then set a gate on the chat app: a password, a Google sign-in list, or both
```

Deck's per-app gates are the whole auth story — no auth code is written for this feature. Confirm the gate actually challenges from a logged-out browser before reporting done; **an unauthenticated page that can post into rooms is a page that can steer Matt's agents.**

- [ ] **Step 6: Run everything**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/Composer.tsx src/server/chat.ts src/app/App.tsx src/ui/Composer.test.tsx src/server/chat.test.ts
git commit -m "chat-viewer: composer, mobile layout, deck gates

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## What this plan does not build

The `@matt` notifier producer and the optional ntfy/Pushover push provider. Both are rt-side work (spec, **Notifications**), and neither is needed for the viewer to be useful — a mention already reaches Matt's desk through the tray once that producer exists.
