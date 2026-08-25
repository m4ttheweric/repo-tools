# rt chat — web viewer (plan 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser view of the chat rooms — live transcript, who is actually listening, and a composer so Matt can answer his agents from a phone.

**Architecture:** A Bun + Hono server that reaches the rt daemon through `@mattstack/rt-client` over the unix socket, plus a Vite/React client. One `subscribe()` per process is filtered server-side to chat frames and republished onto a Bun pub/sub topic, so tab count never multiplies daemon load. Registered with deck for HTTPS, supervision, and public access control.

**Tech Stack:** Bun, Hono, Vite, React, Mantine via `create-mantine-kit` (the app owns its kit copy), `@mattstack/mantine-tokyo` (the Tokyo tokens, extracted from console in Task 0), `@mattstack/rt-client` from npm (relay + probe added in Task 0), TanStack Query, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-rt-chat-design.md` — read the **Web viewer** and **Notifications** sections before Task 1. On any conflict, the spec wins.

**Depends on:** plan 1 (`docs/superpowers/plans/2026-08-23-rt-chat-core.md`) **Tasks 6 and 7** — Task 6 for the exported rt-client wrappers and types, and Task 7 for the `chat.humanHandle` settings def, which Tasks 2 and 7 here both read. Starting after Task 6 alone would hit an unregistered settings key. The reader is `getSetting`, already exported from `packages/rt-client/src/index.ts`. Nothing here needs plan 1's CLI, skill, or hook, and **no `/api/chat/*` REST routes exist on the daemon**; this server is the only chat HTTP surface that will ever exist.

**Reference implementation:** `~/Documents/GitHub/console` is the precedent for every structural decision below. Read `src/server/{app,index,ws,runs}.ts` before Task 2 — to understand the shape. What is genuinely shared (the Tokyo tokens, the relay, the probe) arrives as packages in Task 0; the UI kit is scaffolded from the template and is this app's own to edit.

**Design reference:** the approved mockups — https://claude.ai/code/artifact/933b24c5-9edd-4c70-9930-f5afbf14c9a9 — land in this repo as `design/` in Task 1 (console's `design/wiring` pattern: artboards, `canvas.json`, README naming what each value was lifted from). Implementation is checked against them, not against memory of them.

**Repo:** a new checkout at `~/Documents/GitHub/chat`. It depends on nothing by sibling path: `@mattstack/rt-client` and `@mattstack/mantine-tokyo` come from npm.

## Global Constraints

- **`@mattstack/rt-client` NEVER throws.** `rtCommand` wraps its whole fetch in try/catch and returns `{ ok: false, error: "rt daemon unreachable at <sock>: ..." }` for connection-refused exactly as for a refusal. **Console's `runs.ts` and `runs.test.ts` both state the opposite** — that a throw means unreachable and falls through to `app.onError` as a 500. That is wrong; the test passes only because it mocks a rejection the real client cannot produce. **Do not copy that comment or that test.** Daemon-down and daemon-refused are indistinguishable by shape, which is why Task 4 exists.
- **Packages come from npm, never a sibling `file:` path.** `@mattstack/rt-client` (`^0.5` — Task 0a's release; `0.4` is the RT-62 line and has no relay or probe) and `@mattstack/mantine-tokyo`. A `file:../` dependency is a build that only works on one machine; deck's own move to npm is the precedent.
- **Shared tokens, owned components.** `src/ui/*` is scaffolded from the `create-mantine-kit` template and is **this app's own**: edit `RailShell`, `PageShell`, wrap a Mantine component and expose the wrapper through the wall — that is what the kit is for, and divergence from console's copy is accepted as the price of ownership. What the two apps *share* is the suite's identity, as versioned packages: the Tokyo tokens via `@mattstack/mantine-tokyo` (consumed through the kit's brand slots), and the relay + daemon probe via `rt-client`. Chat never reaches into console's tree; a console component worth having here is ported deliberately, not synced.
- **`hono/bun` reads the `Bun` global at module load.** Any module that must stay importable under vitest's Node runtime cannot import it. The `/ws` route registers in `index.ts` only — never in `app.ts`, never in `ws.ts`.
- **Routes are chained and handlers inline.** A handler lifted into a named function loses path-param typing, and an unchained `app.get(...)` never reaches `typeof routes`. This is Hono RPC inference, not style.
- **Never render an agent status while the daemon is unreachable.** Statuses are only meaningful when the daemon answers; see Task 4. The banner also disables the composer (every post goes over `rt.sock`) and marks counts as last known.
- **Viewing never mutates.** Opening a room does not advance the read cursor; *mark read* is an explicit control (Task 5). Status lives on the member row, never beside a message.
- **The page must not scroll horizontally at 375px.** The composer is the reason this app is published; a desktop layout that technically reflows is a failure.
- **Clean-code comments only.** A comment states a constraint the code cannot show. No narration, no ticket numbers, no decision history in source.
- **Commits:** prefix `chat-viewer:`, trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Test gate:** in the chat repo `bunx vitest run && bunx tsc -b` (a vitest repo: `bun test` would run the same files under bun's runner and choke on `vi.mock`); in repo-tools `bun run test && bunx tsc --noEmit`; in console `bun run lint && bunx vitest run && bunx tsc -b`. Before every commit.

---

## File structure (what exists after this plan)

```
# repo-tools (Task 0a)
packages/rt-client/src/relay.ts          MODIFY: + createRelay — one subscribe(), predicate-filtered, fanned out
packages/rt-client/src/health.ts         NEW: daemonHealth() — the probe every rt app needs

# console (Task 0b)
packages/mantine-tokyo/                  NEW: @mattstack/mantine-tokyo — the Tokyo tokens: theme values, ramps, colour names, tokyo-theme.css + font
src/ui/design-system/app-{theme,colors}.ts  MODIFY: console's brand slots re-export from the package (its kit copy is otherwise untouched)

# chat (Tasks 1-7)
package.json                   NEW: rt-client ^0.5 and mantine-tokyo from npm
src/ui/**                      NEW: the create-mantine-kit template copy — this app's own kit, edited freely
src/ui/design-system/app-{theme,colors}.ts  MODIFY: brand slots re-export from @mattstack/mantine-tokyo
design/                        NEW: the approved artboards, canvas.json, README (console's design/ pattern)
src/server/index.ts            NEW: entry — Bun.serve, /ws route, relay start
src/server/app.ts              NEW: Hono app, chained routes, import-safe under vitest
src/server/chat.ts             NEW: /api/chat/* routes over rt-client wrappers (+ branch per member, + mark)
src/server/health.ts           NEW (Task 4): GET /api/daemon over rt-client's daemonHealth()
src/server/static-disk.ts      NEW: serves dist/ — mounted from index.ts (hono/bun)
src/server/ws.ts               NEW: startRelay — createRelay with the chat/ predicate
src/server/*.test.ts           NEW: one beside each server module
src/ui/PageBar.tsx             NEW: room title + status chips (names handles when ≤2) + mark read
src/ui/RoomRail.tsx            NEW
src/ui/Transcript.tsx          NEW
src/ui/MemberList.tsx          NEW
src/ui/Composer.tsx            NEW
src/ui/DaemonBanner.tsx        NEW
src/app/App.tsx                NEW: layout in the kit's own RailShell + the banner-supersedes-status rule
src/main.tsx                   NEW: Vite entry — the kit's theme (whose brand slots carry the Tokyo tokens)
```

Server modules split by responsibility, not layer: `chat.ts` owns every route that reads or writes chat, `health.ts` owns the daemon probe, `ws.ts` owns the relay. `ws.ts` stays free of `hono/bun` so it is unit-testable.

---

### Task 0: Shared packages — tokens and daemon plumbing

Two PRs in two repos, both before Task 1. They carry the only two things console and the viewer genuinely share: the suite's Tokyo tokens (theme values, ramps, colour names, `tokyo-theme.css`, the font), which become a package both apps consume through the kit's brand slots; and the relay + probe every rt-consuming server needs, which move into rt-client where deck and board can use them too. The UI kit itself is **not** shared — each app scaffolds it from `create-mantine-kit` and owns its copy, by design.

#### Task 0a — repo-tools: `createRelay` and `daemonHealth`

**Branch from:** `main` at or after `85040dcd` (RT-62 / #73 merged; rt-client 0.4.0 on npm). That merge already moved chat's handle derivation onto the identity label — `repoAliasForPath` returns `repoLabel(name)` for identity-keyed index rows, with a test — so there is nothing identity-related left for this task.

**Files:**
- Modify: `packages/rt-client/src/relay.ts`, `packages/rt-client/src/index.ts`, `packages/rt-client/src/transport.ts` (the `subscribeImpl` option), `packages/rt-client/package.json` (version)
- Create: `packages/rt-client/src/health.ts`
- Test: `packages/rt-client/test/relay.test.ts`, `packages/rt-client/test/health.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function createRelay(
    cfg: { match: (topic: string) => boolean; topic: string; publish: (topic: string, data: string) => void },
    opts?: RtClientOptions,
  ): () => void;                                         // relay.ts — one subscribe(), event frames only, predicate-filtered
  export function daemonHealth(opts?: RtClientOptions): Promise<{ reachable: boolean; error?: string }>;  // health.ts — wraps eventsHead
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/rt-client/test/relay.test.ts — a fake server: capture subscribe's callback
import { expect, test, vi } from "bun:test";
import { createRelay } from "../src/relay.ts";

test("republishes only event frames whose topic matches, onto the configured topic", () => {
  const published: Array<[string, string]> = [];
  const cbs: Array<(type: string, data: unknown) => void> = [];
  const stop = createRelay(
    { match: (t) => t.startsWith("chat/"), topic: "chat", publish: (t, d) => published.push([t, d]) },
    { subscribeImpl: (cb) => { cbs.push(cb); return () => {}; } },
  );
  cbs[0]!("event", { topic: "chat/build/msg", payload: { id: 1 } });
  cbs[0]!("event", { topic: "run-updated", payload: {} });
  cbs[0]!("ports", {});
  expect(published).toEqual([["chat", JSON.stringify({ topic: "chat/build/msg", payload: { id: 1 } })]]);
  stop();
});
```

```ts
// packages/rt-client/test/health.test.ts
test("daemonHealth maps an unreachable daemon to reachable:false, never a throw", async () => {
  const res = await daemonHealth({ sockPath: "/nonexistent/rt.sock" });
  expect(res).toMatchObject({ reachable: false });
  expect(res.error).toContain("unreachable");
});
```

`subscribeImpl` is a test seam on `RtClientOptions` (default: the real `subscribe`) — the alternative is a live WebSocket server in a unit test.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/rt-client/test/relay.test.ts packages/rt-client/test/health.test.ts`
Expected: FAIL — `createRelay`/`daemonHealth` not exported.

- [ ] **Step 3: Implement `createRelay` and `daemonHealth`**

`createRelay` is console's `startRelay` with the predicate and target topic lifted to arguments: subscribe once, drop `type !== "event"`, keep frames whose `topic` satisfies `match`, `publish(topic, JSON.stringify(frame))`, return the unsubscribe. `daemonHealth` calls `eventsHead(opts)` and returns `{ reachable: res.ok, error: res.ok ? undefined : res.error }` — 200-shaped, because learning the daemon is down is a success of the probe. Export both from `index.ts`.

- [ ] **Step 4: Run the gate, bump, publish**

Run: `bun run test && bunx tsc --noEmit && sh scripts/repo-purity.sh`
Expected: PASS, `ok repo-purity`.

Bump `packages/rt-client/package.json` (`0.4.0` → `0.5.0`, a new public surface), `bun run build` in `packages/rt-client` (the dist-freshness guard), commit, PR against `main`, and publish after merge — publishing is a push-class side effect: ask first.

```bash
git commit -am "rt-client: createRelay and daemonHealth

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

#### Task 0b — console: extract `@mattstack/mantine-tokyo` (tokens only)

**Files:**
- Create: `packages/mantine-tokyo/` in the console repo — `package.json`, `src/index.ts`, `src/ramps.ts` (the twelve Day/Night tuples), `src/theme.ts` (the `MantineThemeOverride` values console's `app-theme.ts` holds today: `primaryColor`, `primaryShade`, radii, `fontSizes`, `spacing`, `lineHeights`, `fontFamily`, shadows, the virtual colours), `src/colors.ts` (the brand colour NAMES `app-colors.ts` declares), `src/tokyo-theme.css` (the `--tk-*` tokens, the surface ladder remap, the grid, the `@font-face`), `src/fonts/jetbrains-mono.woff2`
- Modify: console `src/ui/design-system/app-theme.ts`, `app-colors.ts` (become re-exports from the package), `src/app/styles/tokyo-theme.css` (imports the package css), `package.json`; delete `src/ui/design-system/app-ramps.ts`
- Test: `tokyo-ramps.test.ts` and `tokyo-theme.test.ts` move with the code; console's suite unchanged and green

**Interfaces:**
- Produces: `import { tokyoTheme, tokyoRamps } from "@mattstack/mantine-tokyo"`, `import type { TokyoColorName } from "@mattstack/mantine-tokyo"` (a string-literal union — the slot it feeds is `export type AppCustomColors`, consumed via `import type` under `verbatimModuleSyntax`, so the re-export is `export type { TokyoColorName as AppCustomColors }`), and `import "@mattstack/mantine-tokyo/tokyo-theme.css"`. Peer dep: `@mantine/core` (for `virtualColor` and the override type). **No components** — `RailShell`, `PageShell`, `GenericError`, the hooks stay in each app's own kit copy.

- [ ] **Step 1: Move the values, not the components**

`git mv` the ramps, theme values, colour names, css and font into the package. Nothing React moves: the package exports data, a type, and css. The `@font-face` in the package css resolves `./fonts/jetbrains-mono.woff2` relative to the package — today console's is absolute (`/fonts/jetbrains-mono.woff2` from `public/fonts/`), so this step also deletes `public/fonts/jetbrains-mono.woff2` and lets Vite serve the package's copy; `tokyo-theme.test.ts`'s `toContain('/fonts/jetbrains-mono.woff2')` still passes on the relative path. The parity capture in Step 3 is what proves the font still loads.

- [ ] **Step 2: Console consumes it through its brand slots**

`"@mattstack/mantine-tokyo": "file:./packages/mantine-tokyo"` in console's `package.json` (in-repo path, the way repo-tools consumes its own `rt-client`). `app-theme.ts` becomes `export { tokyoTheme as appTheme } from "@mattstack/mantine-tokyo"` and `app-colors.ts` becomes `export type { TokyoColorName as AppCustomColors } from "@mattstack/mantine-tokyo"`, so the kit's `theme.ts` merge (`appTheme` depends only on the ramps, `createTheme` and `virtualColor`) and the once-per-repo `mantine.d.ts` augmentation keep working untouched — the slots are the kit's designated extension point, and the rest of console's kit copy stays byte-identical to what it was. The package is a data import, so the `@ui/*` wall needs no exception.

- [ ] **Step 3: Prove nothing moved visually**

Run console's design parity capture (`design/wiring/capture.sh` + `normalize-captures.mjs`) and diff against `design/wiring/reference/*.png`: zero pixel drift is the acceptance test for an extraction.

- [ ] **Step 4: Gate, commit, publish**

Run: `bun run lint && bunx vitest run && bunx tsc -b`
Expected: PASS.

```bash
git commit -am "mantine-tokyo: extract the Tokyo theme and shell into a package console consumes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Publish `@mattstack/mantine-tokyo@0.1.0` after merge (ask first). Task 1 pins it. Adding a token later is a package bump both apps take; adding a *component* is each app's own business.

---

### Task 1: Scaffold, health route, and deck registration

A walking skeleton: a real page on a real https name before any chat feature exists.

**Files:**
- Create: the `create-mantine-kit` scaffold at `~/Documents/GitHub/chat`
- Create: `src/server/index.ts`, `src/server/app.ts`, `src/server/static-disk.ts`
- Test: `src/server/app.test.ts`

**Interfaces:**
- Produces: `export const app: Hono`, with `GET /api/health` **inline**. `health.ts` is NOT created here — it arrives in Task 4 owning `/api/daemon`, the probe. Console has no `health.ts` at all and registers `/api/health` inline in `app.ts`; this plan follows that rather than creating an empty module or a duplicate registration.

- [ ] **Step 1: Scaffold from the mantine-kit checkout**

`create-mantine-kit` is **unpublished** (`mantine-kit/package.json` is
`"private": true`; `npm view` 404s), so `bun create mantine-kit` and
`bunx create-mantine-kit` both fail. Run the scaffolder from the checkout:

```bash
cd ~/Documents/GitHub/mantine-kit
bun create-cli/create.ts ~/Documents/GitHub/chat --name chat
cd ~/Documents/GitHub/chat
```

It refuses to run if the target already exists.

- [ ] **Step 2: Report what the scaffold actually produced, before writing any code**

Paste the generated `package.json` and the `src/` tree into your report. The
dependency actions below are written against the template as it stands today;
if it has moved, say so rather than working around it silently.

- [ ] **Step 3: Fix up dependencies**

The template is **not** console, and the difference runs in both directions. Verified
against `mantine-kit/package.json`:

**Add** — the template does not ship these, and Task 2 onward assumes both:

```bash
bun add hono @tanstack/react-query
```

Then the two mattstack packages from npm — the versions Task 0 published:

```bash
bun add @mattstack/rt-client@^0.5 @mattstack/mantine-tokyo@^0.1
```

**Remove** — the template *does* ship these and this app needs none of them:
`@codemirror/*` and `codemirror`, `@mantine/spotlight`, and the Storybook
devDependencies plus `.storybook/`. **Keep `@tanstack/react-virtual`:** it is
the kit's list primitive (`VirtualList` under `SearchableMenu` and
`SelectableList`, `VirtualTable` under `createDynamicTable`), and
`SearchableMenu` is the base for Task 7's `@` popover — the spec's "leave
virtualization" means do not virtualize the transcript, not strip the kit's
lists. Also do not port console's `build:binary` / `generate:embedded` path —
it buys nothing when deck supervises the process.

Removing a dependency orphans its consumers, and `tsconfig.app.json` includes
all of `src`, so `tsc -b`, `vite build` and vitest all fail until the source
goes too. Delete, in the same step:

- `src/ui/spotlight/` and the `@mantine/spotlight` import in `src/ui/styles/index.css`
- `src/ui/lazy/codemirror/` and its re-export in `src/ui/lazy/index.ts`
- every `*.stories.tsx` under `src/` (34 files import `@storybook/react-vite`) — but **not** `src/ui/storybook/`: `vitest.setup.ts` imports `@ui/storybook/jsdom-polyfills` (matchMedia, ResizeObserver) and every UI test depends on it
- the whole `src/app/docs/` tree (the kit's docs site; it imports Spotlight and CodeMirror), **and** the `/docs*` routes in `src/app/routes.ts` that import `isDocsSlug`/`DocsSlug` from it (`App.tsx` is rewritten by this plan anyway)

Then `bunx tsc -b` must pass before anything is added. It will not yet:
`tsconfig.app.json` types `["vite/client", "vitest/globals"]` only, so
`Bun.serve` in `index.ts` is untyped — add `"bun"` to that array, as console's
`tsconfig.app.json` does. The template's `"build": "tsc -b && vite build"`
script already exists; keep it.

`zod`, Vite, React, Mantine, and vitest are already in the template.

**Point the brand slots at the package.** The template's `src/ui/design-system/app-theme.ts` and `app-colors.ts` become re-exports from `@mattstack/mantine-tokyo`, exactly as console's do after Task 0b, and `src/app/styles` imports the package css. Everything else under `src/ui/` is the template copy and is **this app's kit** — edit `RailShell`, `PageShell`, the icon registry, the wall, as the viewer needs; console's copies are a reference, not a source.

**Add `design/`.** Copy it from the repo-tools checkout that carries this plan — the directory beside it, `docs/superpowers/design/2026-08-24-rt-chat-viewer/` (today that is the worktree `~/Documents/GitHub/repo-tools-chat-wt` on branch `docs/rt-chat-plan2-amend`; after merge, any checkout on `main` — never assume the main checkout's branch, it is switched underneath sessions). Copy `artboards/{Main,DaemonDown,Phone,PhoneRooms,Indicators}.dc.html`, `canvas.json`, `build.py`, `README.md` → `design/`, keeping the README's provenance table and the list of deliberate departures (44px phone controls, 8px status dots, contrast-safe mention badge). Every UI task below is checked against these files, not the hosted canvas.

- [ ] **Step 4: Write the failing test**

```ts
// src/server/app.test.ts
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

- [ ] **Step 5: Run it to verify it fails**

Run: `bunx vitest run src/server/app.test.ts`
Expected: FAIL — no module `./app`.

- [ ] **Step 6: Implement the server**

`app.ts` holds a chained `new Hono().get('/api/health', ...)` — inline, as
console does — and exports it. There is no `health` module to mount yet. `index.ts` calls `Bun.serve` and is the **only** file importing
`hono/bun`. `App.tsx` lays the page out in the kit's own `RailShell` (68px rail with the single Rooms entry and the color-scheme toggle, 64px header with the `chat` wordmark) — the rail stays for shell consistency with console.

Add console's `notFound` and `onError` handlers to `app.ts`, both of which
carry recorded reasons: `c.notFound()` produces a response the RPC client
cannot type, and without an `onError`, Hono answers a thrown error with
`text/plain` "Internal Server Error" — so the client's `res.json()` throws
while parsing it. Every other route's error handling assumes a JSON floor.

- [ ] **Step 7: Serve the built client**

Without this the server has only `/api/*` and `/ws`, and **every UI task from
Task 4 onward assumes a loadable page.** Task 1's health check would pass
regardless, so the gap stays invisible until someone says "load the page."

Create `src/server/static-disk.ts` on console's non-binary path: mount
`serveStatic` for `/assets/*`, `/fonts/*` and the favicon against `./dist`,
and return an `index.html` handler. Two details are load-bearing:

- `serveStatic` comes from **`hono/bun`**, so it mounts in `index.ts`, never
  in `app.ts` — the same constraint as `/ws`, and an easy trap.
- The catch-all fallback **must exclude `/api` and `/ws`**. Console records
  why: a bare `'/*'` static fallback makes an unknown `/api/*` route return
  200 with the SPA's `index.html`, and the RPC client then sees
  `res.ok === true` and throws parsing HTML as JSON.

Run `bun run build` so `dist/` exists before deck serves the app. Deck's working directory must be the repo root, not
`dist` — `--dir ~/Documents/GitHub/chat` already satisfies that.

- [ ] **Step 8: Register with deck**

```bash
deck add chat --cmd "bun src/server/index.ts" --dir ~/Documents/GitHub/chat
```

Confirm `https://chat.localhost/api/health` answers **and that
`https://chat.localhost/` serves the built page** — not just the API. Paste
both into your report.

- [ ] **Step 9: Commit**

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
- Consumes, from plan 1 Task 6: `chatRooms`, `chatWho`, `chatMessages`, `chatMark`, `getSetting` (the `chat.humanHandle` default), and the types `ChatMember`, `ChatMessage`, `RoomSummary`, `WakeMode`. Every `vi.mock("@mattstack/rt-client")` factory in this repo must define **all** of these (plus `daemonHealth` once Task 4 mounts `health`), or vitest throws "No `chatMark` export is defined on the mock" at import.
- Produces: `export const chat: Hono` mounting `GET /api/chat/rooms`, `/api/chat/who/:room`, `/api/chat/messages/:room`, `POST /api/chat/mark`.
- `/api/chat/who/:room` adds `branch?: string` to each member: the server runs `git -C <cwd> branch --show-current` per member with a `cwd` (one spawn per member per request, `undefined` on any failure or when `cwd` is absent). `ChatMember` carries no branch and a worktree path cannot yield one client-side; only the server has the filesystem. `POST /api/chat/mark` `{ room }` calls `chatMark` for the human handle — marking read is explicit (Task 5), never a side effect of viewing.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/chat.test.ts
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("@mattstack/rt-client", () => ({
  chatRooms: vi.fn(),
  chatWho: vi.fn(),
  chatMessages: vi.fn(),
  chatMark: vi.fn(),
  chatJoin: vi.fn(),
  chatPost: vi.fn(),
  daemonHealth: vi.fn(),
  getSetting: vi.fn(() => ({ value: "matt" })),
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
- Consumes: `createRelay` from `@mattstack/rt-client` (Task 0a).
- Produces: `export function startRelay(publish: (topic: string, data: string) => void): () => void` — `createRelay({ match: t => t.startsWith("chat/"), topic: "chat", publish })`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/ws.test.ts
import { expect, test, vi } from "vitest";

const cfgs: Array<{ match: (t: string) => boolean; topic: string }> = [];
vi.mock("@mattstack/rt-client", () => ({
  createRelay: (cfg: { match: (t: string) => boolean; topic: string }) => { cfgs.push(cfg); return () => {}; },
}));
const { startRelay } = await import("./ws");

test("relays onto the chat topic with a prefix predicate, not topic equality", () => {
  // Console filtered `frame.topic !== 'run-updated'` -- one fixed topic. Chat
  // topics carry the room, so equality would drop every real message.
  startRelay(() => {});
  const { match, topic } = cfgs[0]!;
  expect(topic).toBe("chat");
  expect(match("chat/build/msg")).toBe(true);
  expect(match("chat/wake/agent-a")).toBe(true);
  expect(match("chat/some-other-room/msg")).toBe(true);
  expect(match("run-updated")).toBe(false);
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

`ws.ts` is three lines: `createRelay` from rt-client with `match: t => t.startsWith("chat/")` and `topic: "chat"`. The one-subscription-per-process, event-frames-only, server-side filtering behaviour lives in the package (Task 0a) and is tested there; this module only owns the predicate. Server-side filtering is what stops an unrelated daemon tick from making every open tab refetch.

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
- Create: `src/server/health.ts` — the probe, `GET /api/daemon`
- Modify: `src/server/app.ts` — mount it with `.route('/', health)`
- Create: `src/ui/DaemonBanner.tsx`
- Create: `src/ui/memberStatus.ts` — the one place the live/idle/deaf rule lives (Tasks 5, 6 and 7 consume it)
- Modify: `src/app/App.tsx`
- Test: `src/server/health.test.ts`, `src/ui/DaemonBanner.test.tsx`, `src/ui/memberStatus.test.ts`

**Interfaces:**
- Consumes: `daemonHealth` from `@mattstack/rt-client` (Task 0a).
- Produces: `GET /api/daemon` → `{ reachable: boolean; error?: string }` (the `daemonHealth` result, verbatim); `<DaemonBanner reachable={boolean} since={number} probes={number} />`; `memberStatus(m: { armedAt?: number; lastSeenAt?: number }, now: number): "live" | "idle" | "deaf"` and `memberStatusDetail(m, now): string` (the sub-line: `armed · seen 12s ago`, `armed, silent 22m`, `tail died · last seen 2h ago`) in `src/ui/memberStatus.ts` — live = `armedAt` set AND `lastSeenAt` within 10 minutes; idle = no `armedAt`, `lastSeenAt` within 1 hour; deaf = anything else.

- [ ] **Step 1: Write the failing tests**

```ts
test("GET /api/daemon reports unreachable rather than 500ing", async () => {
  vi.mocked(rt.daemonHealth).mockResolvedValueOnce({
    reachable: false, error: "rt daemon unreachable at /x/rt.sock: ECONNREFUSED",
  });
  const res = await app.request("/api/daemon");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ reachable: false });
});
```

```tsx
// src/ui/DaemonBanner.test.tsx
const now = 1_700_000_000_000;

test("the banner supersedes agent statuses", () => {
  render(<App initialState={{ daemonReachable: false, members: [{ handle: "a", armedAt: now, lastSeenAt: now }] }} />);
  expect(screen.getByRole("status")).toHaveTextContent(/daemon/i);
  expect(screen.queryByText("live")).toBeNull();
});
```

```ts
// src/ui/memberStatus.test.ts
const now = 1_700_000_000_000;

test("memberStatus: live requires BOTH an armed waiter and a fresh heartbeat", () => {
  expect(memberStatus({ armedAt: now - 1000, lastSeenAt: now - 60_000 }, now)).toBe("live");
  expect(memberStatus({ armedAt: now - 1000, lastSeenAt: now - 20 * 60_000 }, now)).toBe("deaf");
  expect(memberStatus({ lastSeenAt: now - 60_000 }, now)).toBe("idle");
  expect(memberStatus({ lastSeenAt: now - 5 * 60 * 60_000 }, now)).toBe("deaf");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run`
Expected: FAIL — `/api/daemon` 404s.

- [ ] **Step 3: Implement**

The route returns rt-client's `daemonHealth()` result as-is — it wraps `eventsHead()`, the cheapest call there is, and answers **200 with `reachable: false`** rather than an error status: the probe succeeded in learning the daemon is down, which is not itself a server failure.

`App` accepts an `initialState` prop (`{ daemonReachable?, members?, rooms?, messages? }`) that seeds its query cache — the test seam every UI test uses instead of a network. The client polls `/api/daemon` every 5s. When unreachable, per the `DaemonDown` artboard: the banner (Mantine `Alert` light/`bad`) says *the transcript has gone quiet because nothing is answering at rt.sock, not because every agent is idle*, carries elapsed time and probe count (`down 4m · 48 probes`) and a probe-now action; the member pane goes to opacity 0.6 with hollow dots and `—` for every status; rooms/member counts are marked *last known*; the composer is disabled with the draft kept (Task 7). **Nobody renders as live, idle or deaf.** Agent status is only meaningful while the daemon is reachable — a member list rendered from stale data during an outage is exactly the lie this task exists to prevent.

- [ ] **Step 4: Integration test — a stopped daemon renders as a stopped daemon**

This is the spec's "stopped daemon renders as a stopped daemon" integration test (item 6 in its Testing list; item 5 is the tail's exit-69 test). Stop the daemon, load the page, assert the banner appears and no member renders as live. It is the test that would have caught the original defect.

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/health.ts src/server/app.ts src/ui/DaemonBanner.tsx src/ui/memberStatus.ts src/app/App.tsx src/server/health.test.ts src/ui/DaemonBanner.test.tsx src/ui/memberStatus.test.ts
git commit -m "chat-viewer: daemon probe and banner

subscribe() reconnects silently, so a dead daemon looks identical to an
idle fleet without an explicit probe.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Rooms rail, page bar, and live transcript

**Files:**
- Create: `src/ui/RoomRail.tsx`, `src/ui/PageBar.tsx`, `src/ui/Transcript.tsx`
- Modify: `src/app/App.tsx`
- Test: `src/ui/RoomRail.test.tsx`, `src/ui/PageBar.test.tsx`, `src/ui/Transcript.test.tsx`

**Interfaces:**
- Consumes: `RoomSummary`, `ChatMessage`; `GET /api/chat/rooms`, `/api/chat/messages/:room`, `POST /api/chat/mark`; the `chat` WS topic; `memberStatus` from Task 4 (the page bar's chips name handles by it).

- [ ] **Step 1: Write the failing tests**

```tsx
test("mention badges are visually distinct from plain unread", () => {
  render(<RoomRail rooms={[{ room: "build", memberCount: 3, unread: 4, mentions: 1 }]} />);
  expect(screen.getByLabelText("1 mention")).toHaveTextContent("@1");   // the glyph is the difference, not the colour
  expect(screen.getByLabelText("4 unread")).toHaveTextContent("4");
});

test("the page bar names the handles behind a small status count", () => {
  render(<PageBar room="build" members={[{ handle: "a", status: "live" }, { handle: "gitq-main", status: "deaf" }]} />);
  expect(screen.getByText("1 deaf: gitq-main")).toBeInTheDocument();
});

test("mark read is explicit: rendering never calls it, the control does", async () => {
  render(<PageBar room="build" unread={4} members={[]} />);
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/api/chat/mark"), expect.anything());
  await userEvent.click(screen.getByRole("button", { name: /mark #build read/i }));
  expect(fetchMock).toHaveBeenCalledWith("/api/chat/mark", expect.objectContaining({ method: "POST" }));
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
  // jsdom sees inline styles, not CSS-module rules: the code block's overflow-x is inline.
  expect(screen.getByTestId("code-block").style.overflowX).toBe("auto");
});

// renderTranscriptWithFakeSocket, longCodeBlockMessage and fetchMock are test
// helpers this task writes (src/ui/test-utils.tsx): a WebSocket stub whose
// pushFrame() delivers one frame, a fixture message with a 200-column code
// block, and a vi.fn() installed as globalThis.fetch.
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run src/ui/`
Expected: FAIL — no `RoomRail` module.

- [ ] **Step 3: Implement**

Build to the `Main` artboard and its `Indicators` legend:

- **Rooms rail:** `#room` rows, active row in the accent wash; `@N` filled badge for mentions, outlined `N` for plain unread — distinguishable without colour because the glyph differs. No explanatory footer. The rail lists the rooms the human is **in**: `chat:rooms` is `listRooms(handle)` and no merged handler enumerates other rooms, so the artboards' `not joined` badge is **not built here** (see "What this plan does not build").
- **Page bar** (console's second 64px bar): `#build` at 26px/700, then status chips — `6 members`, `2 live`, `2 idle`, `1 deaf` — computed with `memberStatus()` from Task 4, where a chip whose count is ≤2 names its handles (`1 deaf: gitq-main`), so the stuck agent is read first, not found last. A `mark read` button with the unread count calls `POST /api/chat/mark`; nothing else ever advances the cursor. A sort control is drawn but defaults to join order.
- **Transcript:** one card, rows separated by soft borders — handle (600) and **local** time, then the body. No status dot beside a message: a dot next to a 21:58 message would be a claim about then; status lives on the member row (Task 6). A top edge row (`41 older messages · load on scroll`) is the scrollback affordance; it becomes `Loading older…` while a `before` page is in flight. The `N new` divider marks the read cursor and carries a `mark read` link on the phone. Bodies get `overflow-wrap: anywhere` (agents paste paths), inline `code` gets a rule, code blocks scroll on their own `overflow-x`.

The transcript appends from WS frames and scroll-backs through `GET /api/chat/messages/:room` with `before`. **A frame carries only `{ id }` — a pointer, not prose** (chat owns the message store; the journal is the doorbell), so the client fetches the message body on arrival or refetches the tail.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/RoomRail.tsx src/ui/PageBar.tsx src/ui/Transcript.tsx src/app/App.tsx src/ui/*.test.tsx
git commit -m "chat-viewer: rooms rail, page bar, and live transcript

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Member list — live, idle, deaf

**Files:**
- Create: `src/ui/MemberList.tsx`
- Test: `src/ui/MemberList.test.tsx`

**Interfaces:**
- Consumes: `ChatMember` (`armedAt`, `lastSeenAt`, `cwd`, `pane`) plus the server-derived `branch?` from Task 2's `/api/chat/who/:room`; `memberStatus` / `memberStatusDetail` from Task 4 (this component renders the rule, it does not restate it).

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
    { handle: "acme-dev-42", cwd: "~/GitHub/acme", branch: "fix-auth", pane: "4", armedAt: now, lastSeenAt: now },
  ]} />);
  expect(screen.getByText(/~\/GitHub\/acme/)).toBeInTheDocument();
  expect(screen.getByText(/fix-auth · pane 4/)).toBeInTheDocument();
});

test("deaf says which kind: a dead tail or an armed waiter nobody has heard from", () => {
  render(<MemberList now={now} members={[
    { handle: "a", armedAt: now - 1000, lastSeenAt: now - 22 * 60_000 },
    { handle: "b", armedAt: undefined, lastSeenAt: now - 3 * 60 * 60_000 },
  ]} />);
  expect(screen.getByTestId("sub-a")).toHaveTextContent(/armed, silent 22m/);
  expect(screen.getByTestId("sub-b")).toHaveTextContent(/tail died/);
});

test("withheld: no status word or colour while the daemon is unreachable", () => {
  render(<MemberList now={now} daemonReachable={false} members={[{ handle: "a", armedAt: now, lastSeenAt: now }]} />);
  expect(screen.getByTestId("status-a")).toHaveTextContent("—");
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

Each row, per the `Main` artboard: 8px status dot; handle (600) with the status word; `branch · pane N`; the path on its own line, **head-truncated** (`…/mr-board-wt-invite-onboarding` — the tail is the discriminating end); a sub-line saying why (`armed · seen 12s ago`, `no waiter · seen 9m ago`, `tail died · last seen 2h ago`, `armed, silent 22m`). `branch` comes from the server (Task 2) — **`ChatMember` carries no `branch`** and a worktree path cannot yield one client-side; render the row without it when absent, and likewise without `cwd`/`pane`, both optional. The human's row carries the `you` badge and `wake: none`, never a status. Members stay in **join order** — health indicates, it never groups. Handles are derived and terse, so identifying *which* agent is speaking matters more here than in human chat. Tapping a member inserts `@handle` into the composer (Task 7). Focusing the member's herdr pane from the row is **not built here** — no route exists and `herdr pane focus` addresses neighbours, not a pane id — so the row must read completely on its own, which it does.

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

```ts
// src/server/chat.test.ts — auto-join is the server's job: the browser never imports rt-client
test("posting into a room the human has not joined joins first, then posts", async () => {
  vi.mocked(rt.chatJoin).mockResolvedValueOnce({ ok: true, data: { handle: "matt", memberCount: 2, unread: 0 } });
  vi.mocked(rt.chatPost).mockResolvedValueOnce({ ok: true, data: { id: 1, recipients: [] } });
  const res = await app.request("/api/chat/post", { method: "POST", body: JSON.stringify({ room: "release", body: "hello" }) });
  expect(res.status).toBe(200);
  expect(rt.chatJoin).toHaveBeenCalledWith(expect.objectContaining({ room: "release", handle: "matt" }), expect.anything());
  expect(vi.mocked(rt.chatJoin).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(rt.chatPost).mock.invocationCallOrder[0]);
});
```

```tsx
test("@ autocompletes from room members, all of them, with status", async () => {
  render(<Composer room="build" members={[{ handle: "acme-dev-42", status: "live" }, { handle: "gitq-main", status: "deaf" }]} />);
  await userEvent.type(screen.getByRole("textbox"), "@");
  expect(await screen.findByText("acme-dev-42")).toBeInTheDocument();
  expect(screen.getByText("gitq-main")).toBeInTheDocument();          // idle and deaf are listed, not filtered
  expect(screen.getByText(/won't see this until its tail restarts/)).toBeInTheDocument();
});

test("the composer is disabled, draft kept, while the daemon is unreachable", async () => {
  const { rerender } = render(<Composer room="build" daemonReachable={true} />);
  await userEvent.type(screen.getByRole("textbox"), "merge it");
  rerender(<Composer room="build" daemonReachable={false} />);
  expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  expect(screen.getByRole("textbox")).toHaveValue("merge it");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run`
Expected: FAIL — no `Composer` module, `/api/chat/post` 404s.

- [ ] **Step 3: Implement**

Posts as the `chat.humanHandle` setting (default `matt`). `POST /api/chat/post` calls `chatJoin` before `chatPost` (join is idempotent for an existing member, so the server does it unconditionally) — auto-join is server-side, consistent with plan 1's join-creates, and the browser never touches rt-client.

Per the `Phone` and `PhoneRooms` artboards:

- **Composer:** 16px input on mobile (below that iOS zooms the viewport on focus and the page scrolls sideways — the exact failure the 375px rule forbids); 44px send button and 44px header controls. On the desk `↵` sends and `⇧↵` adds a line; on the phone return adds a line and the button sends. The `@` popover lists **every** member with dot + status (a mention still lands in an idle agent's unread, so idle is not filtered out), 44px rows, the deaf row carrying *won't see this until its tail restarts*, and `@here` last with what it costs (`wakes 4 agents`). Under daemon-down the input is disabled with *Can't post — rt daemon unreachable. Your draft is kept.* and the send button loses its fill; the draft survives.
- **Phone header:** rooms/members toggle (44px), `#room` truncating, and the status counts as one tap target (`● 2 ● 2 ● 1`, live/idle/deaf) that opens the drawer — no separate members button.
- **Drawer** (`Drawer` position left, size sm, overlay 0.4): rooms with the same badges, then the members of the current room; tapping a member inserts `@handle` and closes. No fake status bar or keyboard is drawn.

- [ ] **Step 4: Verify on a phone-sized viewport**

Load the page at **375px** wide and confirm: no horizontal page scroll, the composer is usable with the keyboard up (no zoom on focus), the `@` popover is tappable, and wide content — a pasted path in prose, a code block — scrolls or wraps inside its own container. Compare against `design/Phone.dc.html`. **Screenshot it and put the screenshot in your report** — this is the reason the app is published, and "it reflows" is not the same as "it is usable."

- [ ] **Step 5: Publish**

```bash
deck domain m4tthew.dev          # if not already configured
deck password chat               # gate 1: the gateway password
deck access chat emails <list>   # gate 2: the Google sign-in allow-list (optional, additive)
deck publish chat on             # only after a gate is confirmed — order is the security-relevant part
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

**`not joined` rooms in the rail.** The rail shows the rooms the human is a member of; listing every room needs a store/handler that plan 1 did not ship. Returns with the presence-roster work, where rooms become a view on presence.

**Focusing a herdr pane from a member row.** No route or CLI addresses a pane by id today. Returns when herdr exposes one; the row is designed to read completely without it.

**A shared UI kit.** Console and chat each own their `create-mantine-kit` copy and may edit it freely — the kit is a starting point the app owns, not a library, and not a synced template. Duplication between the two apps is answered by shared *tokens* (`@mattstack/mantine-tokyo`) and owned *components*; component-level divergence is accepted as the price of ownership, and a console improvement worth having in chat is ported on purpose. This is a decision, not an omission.

The `@matt` notifier producer (**plan 1, Task 10**) and optional ntfy push
(**Task 11**) — both rt-side work, and both scheduled rather than left
homeless. Neither is needed for the viewer to be useful. Pushover is
deferred, not scheduled: Task 11 cut it for v1 and rejects it at
validation.
