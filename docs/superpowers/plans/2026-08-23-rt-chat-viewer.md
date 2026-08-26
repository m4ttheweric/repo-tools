# rt chat — web viewer (plan 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser view of the chat rooms — live transcript, who is actually listening, and a composer so Matt can answer his agents from a phone.

**Architecture:** A Bun + Hono server that reaches the rt daemon through `@mattstack/rt-client` over the unix socket, plus a Vite/React client. One `subscribe()` per process is filtered server-side to chat frames and republished onto a Bun pub/sub topic, so tab count never multiplies daemon load. Registered with deck for HTTPS, supervision, and public access control.

**Tech Stack:** Bun, Hono, Vite, React, Mantine via `create-mantine-kit` (the app owns its kit copy), `@mattstack/mantine-tokyo` (the Tokyo tokens, extracted from console in Task 0), `@mattstack/rt-client` from npm (relay + probe added in Task 0), TanStack Query, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-rt-chat-design.md` — read the **Web viewer** and **Notifications** sections before Task 1. On any conflict, the spec wins.

**Depends on:** plan 1 (`docs/superpowers/plans/2026-08-23-rt-chat-core.md`, shipped) and plan 3 (`docs/superpowers/plans/2026-08-24-rt-chat-presence.md`, shipped in rt PR #97): the exported rt-client wrappers and types (`chatRooms`/`chatWho`/`chatMessages`/`chatMark`/`chatJoin`/`chatPost` from plan 1; `chatBuddies`/`chatDm` and the presence-joined `status`, `kind`/`participants` on rooms, from plan 3), plus the `chat.humanHandle` settings def, read here through `getSetting` (already exported from `packages/rt-client/src/index.ts`). Nothing here needs the CLI, skill, hook or plugin, and **no `/api/chat/*` REST routes exist on the daemon**; this server is the only chat HTTP surface that will ever exist. The presence spec's **Web viewer** section (`docs/superpowers/specs/2026-08-24-rt-chat-presence-design.md`) is what Tasks 5–7 build; on any conflict with the base spec it wins.

**Reference implementation:** `~/Documents/GitHub/console` is the precedent for every structural decision below. Read `src/server/{app,index,ws,runs}.ts` before Task 2 — to understand the shape. What is genuinely shared (the Tokyo tokens, the relay, the probe) arrives as packages in Task 0; the UI kit is scaffolded from the template and is this app's own to edit.

**Design reference:** the approved mockups — https://claude.ai/code/artifact/933b24c5-9edd-4c70-9930-f5afbf14c9a9 — land in this repo as `design/` in Task 1 (console's `design/wiring` pattern: artboards, `canvas.json`, README naming what each value was lifted from). Implementation is checked against them, not against memory of them.

**Repo:** a new checkout at `~/Documents/GitHub/chat`. It depends on nothing by sibling path: `@mattstack/rt-client` and `@mattstack/mantine-tokyo` come from npm.

## Global Constraints

- **`@mattstack/rt-client` NEVER throws.** `rtCommand` wraps its whole fetch in try/catch and returns `{ ok: false, error: "rt daemon unreachable at <sock>: ..." }` for connection-refused exactly as for a refusal. **Console's `runs.ts` and `runs.test.ts` both state the opposite** — that a throw means unreachable and falls through to `app.onError` as a 500. That is wrong; the test passes only because it mocks a rejection the real client cannot produce. **Do not copy that comment or that test.** Daemon-down and daemon-refused are indistinguishable by shape, which is why Task 4 exists.
- **Packages come from npm, never a sibling `file:` path.** `@mattstack/rt-client` (`^0.6` — Task 0a's release, which also carries the unpublished 0.5.0 presence surface; `0.4` is the RT-62 line and has neither) and `@mattstack/mantine-tokyo`. A `file:../` dependency is a build that only works on one machine; deck's own move to npm is the precedent.
- **Shared tokens, owned components.** `src/ui/*` is scaffolded from the `create-mantine-kit` template and is **this app's own**: edit `RailShell`, `PageShell`, wrap a Mantine component and expose the wrapper through the wall — that is what the kit is for, and divergence from console's copy is accepted as the price of ownership. What the two apps *share* is the suite's identity, as versioned packages: the Tokyo tokens via `@mattstack/mantine-tokyo` (consumed through the kit's brand slots), and the relay + daemon probe via `rt-client`. Chat never reaches into console's tree; a console component worth having here is ported deliberately, not synced.
- **`hono/bun` reads the `Bun` global at module load.** Any module that must stay importable under vitest's Node runtime cannot import it. The `/ws` route registers in `index.ts` only — never in `app.ts`, never in `ws.ts`.
- **Routes are chained and handlers inline.** A handler lifted into a named function loses path-param typing, and an unchained `app.get(...)` never reaches `typeof routes`. This is Hono RPC inference, not style.
- **Never render an agent status while the daemon is unreachable.** Statuses are only meaningful when the daemon answers; see Task 4. The banner also disables the composer (every post goes over `rt.sock`) and marks counts as last known.
- **Statuses are the daemon's.** Every member and buddy arrives with `status: BuddyStatus` computed daemon-side from the two heartbeats; the client renders it (and a sub-line explaining it) and never re-derives listening/idle/deaf/offline. `branch` is presence's too — this server spawns no git.
- **DM rooms are never joined.** `chat:join` refuses them and the human is a member of every DM by construction; the post route reads `kind` before joining. A DM is named by its pair (`a ↔ b`) everywhere a human reads it; its hashed room id is a key.
- **Viewing never mutates.** Opening a room does not advance the read cursor; *mark read* is an explicit control (Task 5). Status lives on the member row, never beside a message.
- **The page must not scroll horizontally at 375px.** The composer is the reason this app is published; a desktop layout that technically reflows is a failure.
- **Clean-code comments only.** A comment states a constraint the code cannot show. No narration, no ticket numbers, no decision history in source.
- **Commits:** prefix `chat-viewer:`, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
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
package.json                   NEW: rt-client ^0.6 and mantine-tokyo from npm
src/ui/**                      NEW: the create-mantine-kit template copy — this app's own kit, edited freely
src/ui/design-system/app-{theme,colors}.ts  MODIFY: brand slots re-export from @mattstack/mantine-tokyo
design/                        NEW: the approved artboards, canvas.json, README (console's design/ pattern)
src/server/index.ts            NEW: entry — Bun.serve, /ws route, relay start
src/server/app.ts              NEW: Hono app, chained routes, import-safe under vitest
src/server/chat.ts             NEW: /api/chat/* routes over rt-client wrappers (rooms incl. DMs, who, buddies + room tags, messages, mark, post, dm)
src/server/health.ts           NEW (Task 4): GET /api/daemon over rt-client's daemonHealth()
src/server/static-disk.ts      NEW: serves dist/ — mounted from index.ts (hono/bun)
src/server/ws.ts               NEW: startRelay — createRelay with the chat/ predicate
src/server/*.test.ts           NEW: one beside each server module
src/ui/PageBar.tsx             NEW: room or pair title + fleet chips (names handles when ≤2) + wakes chip + mark read
src/ui/RoomRail.tsx            NEW
src/ui/Transcript.tsx          NEW
src/ui/Roster.tsx              NEW: the fleet roster — listening/idle/deaf/offline, away text, room tags
src/ui/Composer.tsx            NEW
src/ui/DaemonBanner.tsx        NEW
src/ui/statusDetail.ts         NEW (Task 4): status words + sub-lines; the status itself comes from the daemon
src/app/App.tsx                NEW: layout in the kit's own RailShell + the banner-supersedes-status rule
src/main.tsx                   NEW: Vite entry — the kit's theme (whose brand slots carry the Tokyo tokens)
```

Server modules split by responsibility, not layer: `chat.ts` owns every route that reads or writes chat, `health.ts` owns the daemon probe, `ws.ts` owns the relay. `ws.ts` stays free of `hono/bun` so it is unit-testable.

---

### Task 0: Shared packages — tokens and daemon plumbing

Three PRs in three repos, all before Task 1. They carry the only two things console and the viewer genuinely share: the suite's Tokyo tokens (theme values, ramps, colour names, `tokyo-theme.css`, the font), which become a package both apps consume through the kit's brand slots; and the relay + probe every rt-consuming server needs, which move into rt-client where deck and board can use them too. The UI kit itself is **not** shared — each app scaffolds it from `create-mantine-kit` and owns its copy, by design.

#### Task 0a — repo-tools: `createRelay` and `daemonHealth`

**Branch from:** `main` at or after rt PR #97 merged — the presence system: schema v4 with `chat_room_defaults`, the presence and DM stores, and rt-client 0.5.0's chat surface (unpublished). `defaultWake` below joins a table that exists only from that merge on. The RT-62 identity work (#73) is already in that history; nothing identity-related is left for this task.

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
- Also produces, in the same release: `RoomSummary.defaultWake?: WakeMode` — `chat:rooms` (`lib/daemon/handlers/chat.ts`) left-joins `chat_room_defaults` so a room's default wake mode travels with its summary (the page bar's `wakes:` chip, Task 5). Read-only: no verb sets it from the viewer. Publish as **0.6.0** — the first publish since 0.4.x, so it carries the 0.5.0 presence surface (chat wrappers, `timeoutMs`, `ChatMember.status` required) as well; ask before publishing.

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

Bump `packages/rt-client/package.json` (`0.5.0` → `0.6.0` — the unpublished 0.5.0 presence surface ships with it), `bun run build` in `packages/rt-client` (the dist-freshness guard), commit, PR against `main`, and publish after merge — publishing is a push-class side effect: ask first.

```bash
git commit -am "rt-client: createRelay and daemonHealth

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

#### Task 0b — console: extract `@mattstack/mantine-tokyo` (tokens only)

**Files:**
- Create: `packages/mantine-tokyo/` in the console repo — `package.json`, `src/index.ts`, `src/ramps.ts` (the twelve Day/Night tuples), `src/theme.ts` (the `MantineThemeOverride` values console's `app-theme.ts` holds today: `primaryColor`, `primaryShade`, radii, `fontSizes`, `spacing`, `lineHeights`, `fontFamily`, shadows, the virtual colours), `src/colors.ts` (the brand colour NAMES `app-colors.ts` declares), `src/tokyo-theme.css` (the `--tk-*` tokens, the surface ladder remap, the grid, the `@font-face`), `src/fonts/jetbrains-mono.woff2`
- Modify: console `src/ui/design-system/app-theme.ts`, `app-colors.ts` (become re-exports from the package), `src/app/styles/tokyo-theme.css` (imports the package css), `package.json`; delete `src/ui/design-system/app-ramps.ts`
- Test: `tokyo-ramps.test.ts` and `tokyo-theme.test.ts` move with the code; console's suite unchanged and green

**Interfaces:**
- Produces: `import { tokyoTheme, tokyoRamps } from "@mattstack/mantine-tokyo"`, `import type { TokyoColorName } from "@mattstack/mantine-tokyo"` (a string-literal union — the slot it feeds is `export type AppCustomColors`, consumed via `import type` under `verbatimModuleSyntax`, so the re-export is `export type { TokyoColorName as AppCustomColors }`), and `import "@mattstack/mantine-tokyo/tokyo-theme.css"`. Peer dep: `@mantine/core` (for `virtualColor` and the override type). **No components** — `RailShell`, `PageShell`, `GenericError`, the hooks stay in each app's own kit copy.

**Blocking input: console PR #9's theme additions must survive the move.** PR #9 (open, green, awaiting Matt's review) adds two things to the very `app-theme.ts` this task extracts, and its components consume them directly (`px="xxl"`, `p="xxxl"`, the heading ladder). Extract a stale copy of that file and the run views break on tokens that no longer exist.

Two orderings work, and it is Matt's call which:

- **(a) preferred** ... #9 merges first, then 0b extracts a theme that already carries the tokens. No transcription step, nothing to lose.
- **(b) fallback** ... 0b lands first and carries the additions into `src/theme.ts` **verbatim**, and #9 rebases onto it.

Under (b) these are requirements, not notes. `spacing` gains:

```ts
xxl: '1.125rem',
xxxl: '1.5rem',
```

and `headings` gains a `sizes` ladder (fontSize / lineHeight / fontWeight):

| level | fontSize | lineHeight | fontWeight |
| ----- | -------- | ---------- | ---------- |
| h1 | 1.35rem | 1.3 | 700 |
| h2 | 1.1rem | 1.35 | 700 |
| h3 | 0.98rem | 1.4 | 700 |
| h4 | 0.9rem | 1.45 | 600 |
| h5 | 0.82rem | 1.45 | 600 |
| h6 | 0.76rem | 1.5 | 600 |

Mantine's stock unsized `h2` renders about twice the largest body text in this monospace kit, and the dense ladder stops at `xl` 0.9rem, which is why bordered surfaces were rendering at 9.6px against a 20-26px design. The run views consume both ladders directly, so a dropped row is a visible regression, not a lint warning.

- [ ] **Step 1: Move the values, not the components**

`git mv` the ramps, theme values, colour names, css and font into the package. Nothing React moves: the package exports data, a type, and css. The `@font-face` in the package css resolves `./fonts/jetbrains-mono.woff2` relative to the package — today console's is absolute (`/fonts/jetbrains-mono.woff2` from `public/fonts/`), so this step also deletes `public/fonts/jetbrains-mono.woff2` and lets Vite serve the package's copy; `tokyo-theme.test.ts`'s `toContain('/fonts/jetbrains-mono.woff2')` still passes on the relative path. The parity capture in Step 3 is what proves the font still loads.

- [ ] **Step 2: Console consumes it through its brand slots**

`"@mattstack/mantine-tokyo": "file:./packages/mantine-tokyo"` in console's `package.json` (in-repo path, the way repo-tools consumes its own `rt-client`). `app-theme.ts` becomes `export { tokyoTheme as appTheme } from "@mattstack/mantine-tokyo"` and `app-colors.ts` becomes `export type { TokyoColorName as AppCustomColors } from "@mattstack/mantine-tokyo"`, so the kit's `theme.ts` merge (`appTheme` depends only on the ramps, `createTheme` and `virtualColor`) and the once-per-repo `mantine.d.ts` augmentation keep working untouched — the slots are the kit's designated extension point, and the rest of console's kit copy stays byte-identical to what it was. The package is a data import, so the `@ui/*` wall needs no exception.

- [ ] **Step 3: Prove nothing moved visually**

Run console's design parity capture (`design/wiring/capture.sh` + `normalize-captures.mjs`) and diff against `design/wiring/reference/*.png`: zero pixel drift is the acceptance test for an extraction.

**Known defect, read before you trust this gate.** The capture renders static mocks, not the running app, so it can pass while the real theme is broken. Zero drift here is necessary, not sufficient. Until the harness renders the app, back it with something that actually observes the merged theme... a test asserting the resolved `appTheme` still carries every spacing key and heading level by name is cheap and would catch the exact failure this task risks. Do not report a green capture as proof the extraction is visually clean.

- [ ] **Step 4: Gate, commit, publish**

Run: `bun run lint && bunx vitest run && bunx tsc -b`
Expected: PASS.

```bash
git commit -am "mantine-tokyo: extract the Tokyo theme and shell into a package console consumes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Publish `@mattstack/mantine-tokyo@0.1.0` after merge (ask first). Task 1 pins it. Adding a token later is a package bump both apps take; adding a *component* is each app's own business.

---

#### Task 0c — Mantine 9.5.2, and teaching an agent to look Mantine up

> **Landed.** mantine-kit `47014c8` on main (CI green). Console PR #10. Step 5 is Task 1's to check.

**The point of this task is the docs path, not the version.** 9.4.1 → 9.5.2 is a minor already inside both repos' `^9.4.1` range: a lockfile move, gated by the normal suite, with no visual-regression ceremony. What earns the task is everything after Step 1 — an implementer building this viewer should never write a Mantine prop from memory. Guessing produces code that compiles, renders, and is subtly wrong: the variant that does not exist, the prop that moved, a size off the scale. Mantine now ships the cure, and it ships it *per release*, so the docs an agent reads match the version the app installs.

**mantine-kit goes first**, because `create-cli/create.ts` scaffolds from `git ls-files` and copies the template's own `package.json`, `bun.lock`, `AGENTS.md` and `CLAUDE.md` into every generated app. Whatever the template holds is what chat inherits at Task 1. Console's bump is independent of that ordering — it never re-scaffolds — but it shares the artifacts, so it follows the same shape.

**Files:**
- Modify (mantine-kit): `package.json` (the eight `@mantine/*` deps → `^9.5.2`, plus `.mcp.json` and `docs/mantine-llms.txt` added to the `files` whitelist), `bun.lock`, `AGENTS.md`
- Create (mantine-kit): `.mcp.json`, `docs/mantine-llms.txt`
- Modify (console): `package.json`, `bun.lock`, `AGENTS.md`
- Create (console): `.mcp.json`, `docs/mantine-llms.txt`
- chat: nothing of its own — Task 1 inherits from the template and verifies

- [x] **Step 1: mantine-kit — the version, scoped**

Set the eight `@mantine/*` ranges (`code-highlight`, `core`, `dates`, `form`, `hooks`, `modals`, `notifications`, `spotlight`) to `^9.5.2` and `bun install`. **Do not run a bare `bun update`** — it would move vite, storybook, eslint, React and TypeScript in the same commit, and the gate would then be covering a dozen upgrades wearing one task's name.

Gate (the kit's real scripts — `bun run test` alone is vitest in **watch mode** and will hang):

```bash
bun run typecheck && bun run lint && bun run test -- --run && bun run build
```

- [x] **Step 2: the three artifacts that make an agent look things up**

**a. The MCP server.** Create `.mcp.json` at the template root, pinned to the Mantine version it documents:

```json
{
  "mcpServers": {
    "mantine": { "command": "npx", "args": ["-y", "@mantine/mcp-server@9.5.2"] }
  }
}
```

`@mantine/mcp-server` is versioned in lockstep with Mantine, so pinning it to the installed version is what keeps the answers true rather than merely recent. It exposes `list_items`, `get_item_doc`, `get_item_props` and `search_docs`. Never float `latest`: this runs on every session in every scaffolded app, and the pin is bumped deliberately, alongside Mantine.

**b. The offline copy.** Vendor `https://mantine.dev/llms.txt` to `docs/mantine-llms.txt` (~42 KB — an index of every component and hook page with a one-line description and a per-page `.md` URL). It is what a session without MCP, or offline, reads. Head it with a comment naming its source and the version it was fetched at.

**9.5.2 ends up stated in four places** — the eight ranges, the `.mcp.json` pin, the instruction block, and this file's provenance header. They move together, in one commit, or the server starts documenting a version the app no longer installs.

**Do not vendor `llms-full.txt`.** It is 4.1 MB — Mantine's own guide still calls it ~1.8 MB, so it is growing fast — and it would compete with the code for context while going stale every release.

**c. The instruction, which is the part that changes behaviour.** Tooling nobody is told to use gets used by nobody. Add it to `AGENTS.md` **only** — `CLAUDE.md` in both repos is a 15-byte pointer (`See AGENTS.md.`) and stays one. Two copies of a paragraph carrying a version string drift on the next bump:

> **Mantine: look it up, don't recall it.** This app pins Mantine 9.5.2. Before using a component you have not already used in this session, or any prop you are not certain of, call the `mantine` MCP server: `get_item_props` for a signature, `get_item_doc` for behaviour, `search_docs` when you know the effect but not the component name. Without MCP there is `docs/mantine-llms.txt`, but know what it is: an *index* — it names the components and links a page each, so offline it tells you what exists, never a prop signature. A guessed prop compiles and renders and is still wrong; the props table costs one call.

- [x] **Step 3: prove all three actually arrive**

`.mcp.json` and `docs/mantine-llms.txt` are **new files**, and the scaffold walks `git ls-files`. An untracked file reaches no scaffold, and `git commit -am` stages only tracked modifications — so `git add` both explicitly, and add both to the `files` whitelist in `package.json` (the published-tarball scaffold path uses it and would otherwise drop them silently).

Then scaffold a throwaway app **after** staging, the way the kit's own CI does it, and assert all three arrived:

```bash
rm -rf /tmp/mantine-probe                       # create.ts aborts on an existing target
bun create-cli/create.ts /tmp/mantine-probe --name mantine-probe
grep -q '"@mantine/core": "\^9.5.2"' /tmp/mantine-probe/package.json
test "$(grep -c '"@mantine/[a-z-]*": "\^9.5.2"' /tmp/mantine-probe/package.json)" = 8
grep -q '9\.5\.2' /tmp/mantine-probe/bun.lock  # the lock is what actually pins a scaffold
test -f /tmp/mantine-probe/.mcp.json
test -f /tmp/mantine-probe/docs/mantine-llms.txt
grep -q "look it up" /tmp/mantine-probe/AGENTS.md
(cd /tmp/mantine-probe && bun install && bun run build)   # generation still works, as kit CI does it
```

Every line must be a real assertion. A `grep` whose expected value sits in a trailing comment passes on the old version too — and the version is the one thing this probe exists to catch.

Verify the server itself **out of band** — a project-scoped MCP server loads at session start and needs the project's servers approved, so the agent that just wrote the file has no such tool in its own session and cannot check it by calling it:

```bash
npx -y @mantine/mcp-server@9.5.2   # confirm the handshake lists the four tools
```

Run `bun run format` before committing: `format:check` is a CI gate and covers the JSON and Markdown this step hand-writes.

- [x] **Step 4: console — the same three artifacts, same scoped bump**

Set console's eight `@mantine/*` ranges to `^9.5.2`, `bun install`, and gate with `bun run lint && bunx vitest run && bunx tsc -b`. Copy `.mcp.json`, `docs/mantine-llms.txt` and the AGENTS.md instruction across.

**Order against Task 0b (reversed, and settled):** both tasks edit console's `package.json`, so one has to be the base. It is 0c. 0b sits behind a question only Matt can answer (console PR #9, open and green, edits the very `app-theme.ts` that 0b extracts), while 0c is a small independent bump touching nothing under `src/ui/design-system`. So 0c landed first as console PR #10, and **0b rebases onto it**. Do not run them as independent parallel PRs into the same repo.

**Scope the install deliberately.** Console consumes `@mattstack/rt-client` by `file:` path, and a `file:` consumer copies that package's gitignored `dist/` verbatim at install time from a checkout whose branch other sessions switch. An unscoped install can swap console's rt-client build as a side effect of a Mantine bump.

- [ ] **Step 5: chat inherits, and Task 1 checks**

Task 1 scaffolds from the updated template, so the viewer starts on 9.5.2 with all three artifacts present. Task 1 asserts they arrived (the greps above); the server handshake is the out-of-band check from Step 3. A server that is configured but never answers is worse than none, because it looks wired.

- [x] **Step 6: Commit**

Two repos, two commits. Both belong to other lanes — announce before touching them, per the coordination rules in the root `CLAUDE.md`.

```bash
# in mantine-kit
git add .mcp.json docs/mantine-llms.txt
git commit -am "mantine: 9.5.2, and the docs path every scaffold inherits"
# in console (rebased onto 0b)
git add .mcp.json docs/mantine-llms.txt
git commit -am "mantine: 9.5.2 and the docs path"
```

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
bun add @mattstack/rt-client@^0.6 @mattstack/mantine-tokyo@^0.1
# then assert what the template handed over (Task 0c): package.json reads @mantine/* ^9.5.2,
# .mcp.json and docs/mantine-llms.txt are present, and AGENTS.md carries the look-it-up rule
# (Task 0c Step 3 has the exact assertions; run those).
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
- the whole `src/app/docs/` tree (the kit's docs site; it imports Spotlight and CodeMirror), the `/docs*` routes in `src/app/routes.ts` that import `isDocsSlug`/`DocsSlug` from it, **and** `src/app/landing/` (the kit's marketing page; `FeaturesSection.tsx` imports `docsPath`/`DocsSlug`) — `App.tsx` is rewritten by this plan anyway

Then `bunx tsc -b` must pass before anything is added. It will not yet:
`tsconfig.app.json` types `["vite/client", "vitest/globals"]` only, so
`Bun.serve` in `index.ts` is untyped — add `"bun"` to that array, as console's
`tsconfig.app.json` does. The template's `"build": "tsc -b && vite build"`
script already exists; keep it.

`zod`, Vite, React, Mantine, and vitest are already in the template.

**Point the brand slots at the package.** The template's `src/ui/design-system/app-theme.ts` and `app-colors.ts` become re-exports from `@mattstack/mantine-tokyo`, exactly as console's do after Task 0b, and `src/app/styles` imports the package css. Everything else under `src/ui/` is the template copy and is **this app's kit** — edit `RailShell`, `PageShell`, the icon registry, the wall, as the viewer needs; console's copies are a reference, not a source.

**Add `design/`.** Copy it from the repo-tools checkout that carries this plan — the directory beside it, `docs/superpowers/design/2026-08-24-rt-chat-viewer/` (any checkout on `main` once this plan's revision has merged — never assume the main checkout's branch, it is switched underneath sessions). Copy `artboards/{Main,DaemonDown,DirectMessage,Roster,Phone,PhoneRooms,Indicators}.dc.html`, `canvas.json`, `build.py`, `README.md` → `design/`, keeping the README's provenance table and the list of deliberate departures (44px phone controls, 8px status dots, contrast-safe mention badge). Every UI task below is checked against these files, not the hosted canvas.

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

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Chat read routes over rt-client

**Files:**
- Create: `src/server/chat.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/chat.test.ts`

**Interfaces:**
- Consumes, from `@mattstack/rt-client` (plan 1 Task 6 + plan 3 Task 5): `chatRooms`, `chatWho`, `chatMessages`, `chatMark`, `chatBuddies`, `getSetting` (the `chat.humanHandle` default), and the types `ChatMember` (carries `status: BuddyStatus` — the daemon attaches it), `ChatMessage`, `RoomSummary` (carries `kind?: "dm"`, `participants?`, and `defaultWake?` from Task 0a), `PresenceRow`, `BuddyStatus`, `WakeMode`. Every `vi.mock("@mattstack/rt-client")` factory in this repo must define **all** of these (plus `chatJoin`, `chatPost`, `chatDm` from Task 7 and `daemonHealth` from Task 4), or vitest throws "No `chatMark` export is defined on the mock" at import.
- Produces: `export const chat: Hono` mounting `GET /api/chat/rooms`, `GET /api/chat/who/:room`, `GET /api/chat/buddies`, `GET /api/chat/messages/:room`, `POST /api/chat/mark`.
- **Statuses are the daemon's.** `chat:who` and `chat:buddies` both return `status` computed by the daemon from the two heartbeats; this server passes it through and never re-derives live/idle/deaf. `branch` comes from presence (`PresenceRow.branch`, kept fresh by the agent's pulse hook) — the server spawns no git per member. `ChatMember` has no branch at all; only buddies (`PresenceRow`) carry one.
- `GET /api/chat/buddies` → `{ buddies: Array<PresenceRow & { status: BuddyStatus; rooms: string[] }> }`: `chatBuddies()` plus, per buddy, the rooms it is in — composed here from the human's `chatRooms()` and one `chatWho()` per room, inverted by handle (DM rooms contribute the tag `dm`, never their hashed name). One request, `1 + rooms` daemon calls; fleet scale, no cache.
- `POST /api/chat/mark` `{ room }` calls `chatMark` for the human handle — marking read is explicit (Task 5), never a side effect of viewing.

- [ ] **Step 1: Write the failing tests**

```ts
// src/server/chat.test.ts
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("@mattstack/rt-client", () => ({
  chatRooms: vi.fn(),
  chatWho: vi.fn(),
  chatMessages: vi.fn(),
  chatMark: vi.fn(),
  chatBuddies: vi.fn(),
  chatJoin: vi.fn(),
  chatPost: vi.fn(),
  chatDm: vi.fn(),
  daemonHealth: vi.fn(),
  getSetting: vi.fn(() => ({ value: "matt" })),
}));
const rt = await import("@mattstack/rt-client");
const { app } = await import("./app");

beforeEach(() => vi.resetAllMocks());

test("rooms returns the daemon's payload, DM rows included", async () => {
  vi.mocked(rt.chatRooms).mockResolvedValueOnce({ ok: true, data: { rooms: [
    { room: "build", memberCount: 3, unread: 0, mentions: 0 },
    { room: "dm-9f3a2b1c0d4e", memberCount: 3, unread: 1, mentions: 1, kind: "dm", participants: { a: "deck-main", b: "rt-chat-wt" } },
  ] } });
  const res = await app.request("/api/chat/rooms?handle=matt");
  expect(res.status).toBe(200);
  expect((await res.json()).rooms[1]).toMatchObject({ kind: "dm", participants: { a: "deck-main", b: "rt-chat-wt" } });
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

test("who passes the daemon's status through and never spawns git", async () => {
  vi.mocked(rt.chatWho).mockResolvedValueOnce({ ok: true, data: { members: [
    { room: "build", handle: "a", joinedAt: 1, lastReadId: 0, wakeOn: "mention", cwd: "/w/a", status: "deaf" },
  ] } });
  const res = await app.request("/api/chat/who/build");
  expect((await res.json()).members[0]).toMatchObject({ status: "deaf" });
  expect((await res.json()).members[0].branch).toBeUndefined();   // branch is presence's, not this server's
});

test("buddies carries each buddy's rooms as tags, with DMs collapsed to `dm`", async () => {
  vi.mocked(rt.chatBuddies).mockResolvedValueOnce({ ok: true, data: { buddies: [
    { sessionId: "s1", handle: "a", baseHandle: "a", signedInAt: 1, lastSeenAt: 1, branch: "fix-auth", status: "live" },
  ] } });
  vi.mocked(rt.chatRooms).mockResolvedValueOnce({ ok: true, data: { rooms: [
    { room: "build", memberCount: 2, unread: 0, mentions: 0 },
    { room: "dm-9f3a2b1c0d4e", memberCount: 3, unread: 0, mentions: 0, kind: "dm", participants: { a: "a", b: "b" } },
  ] } });
  vi.mocked(rt.chatWho)
    .mockResolvedValueOnce({ ok: true, data: { members: [{ room: "build", handle: "a", joinedAt: 1, lastReadId: 0, wakeOn: "mention", status: "live" }] } })
    .mockResolvedValueOnce({ ok: true, data: { members: [{ room: "dm-9f3a2b1c0d4e", handle: "a", joinedAt: 1, lastReadId: 0, wakeOn: "all", status: "live" }] } });
  const res = await app.request("/api/chat/buddies");
  expect((await res.json()).buddies[0]).toMatchObject({ handle: "a", status: "live", branch: "fix-auth", rooms: ["build", "dm"] });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/server/chat.test.ts`
Expected: FAIL — route not found (404, not 200/502).

- [ ] **Step 3: Implement**

Follow console's `runs.ts` shape — chained routes, inline handlers, `if (!res.ok) return c.json({ error: res.error }, 502)` — but **not** its comment about throws. The handle comes from the query string, defaulting to the `chat.humanHandle` setting. Every wrapper call passes an options object (`{ sockPath }` from config, as console does) — the tests assert that second argument. `who` and `buddies` return the daemon's rows as they are; the only server-side composition is the `rooms` tag list on buddies.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/chat.ts src/server/chat.test.ts src/server/app.ts
git commit -m "chat-viewer: chat read routes over rt-client

rt-client never throws; daemon-down and daemon-refused are both ok:false
and both map to 502. Statuses and branches are the daemon's.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
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

`chat/wake/<handle>` frames are republished too. A wake frame means a message needs delivering to that handle, not that its tail is alive — the viewer treats one as a hint to refetch the room's tail and the roster, never as a status change; status is the daemon's.

- [ ] **Step 4: Register `/ws` in `index.ts`**

In `index.ts` only — `app.ts` and `ws.ts` must stay importable under vitest's Node runtime. Subscribe each socket to the `chat` topic in `onOpen`, via `socket.raw`. No middleware may touch this route: header-modifying middleware plus the websocket helper throws on immutable headers.

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/ws.ts src/server/ws.test.ts src/server/index.ts
git commit -m "chat-viewer: one daemon subscription, chat-filtered, fanned out

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: The daemon probe and banner

**This task exists because of a specific failure mode, and an implementer who does not understand it will build the wrong thing.** `subscribe()` reconnects silently forever, so a stopped daemon does not error — the live pane simply goes quiet. Without a probe, "the daemon is dead" and "every agent is idle" render identically, which defeats the one thing this viewer earns its keep on: telling you which agent stopped listening.

**Files:**
- Create: `src/server/health.ts` — the probe, `GET /api/daemon`
- Modify: `src/server/app.ts` — mount it with `.route('/', health)`
- Create: `src/ui/DaemonBanner.tsx`
- Create: `src/ui/statusDetail.ts` — the status words and sub-lines (Tasks 5, 6 and 7 consume it); **the live/idle/deaf/offline rule itself lives in the daemon** and arrives as `status` on every member and buddy — nothing here re-derives it
- Modify: `src/app/App.tsx`
- Test: `src/server/health.test.ts`, `src/ui/DaemonBanner.test.tsx`, `src/ui/statusDetail.test.ts`

**Interfaces:**
- Consumes: `daemonHealth` from `@mattstack/rt-client` (Task 0a); `BuddyStatus`.
- Produces: `GET /api/daemon` → `{ reachable: boolean; error?: string }` (the `daemonHealth` result, verbatim); `<DaemonBanner reachable={boolean} since={number} probes={number} />`; in `src/ui/statusDetail.ts`: `STATUS_WORD: Record<BuddyStatus, string>` (`live → "listening"`, `idle → "idle"`, `deaf → "deaf"`, `offline → "offline"`) and `statusDetail(row: { status: BuddyStatus; armedAt?: number; lastSeenAt?: number; tailSeenAt?: number; signedOutAt?: number }, now: number): string` — fed `PresenceRow`s only (`lastSeenAt` is the session heartbeat there; `ChatMember.lastSeenAt` is the tail's and never goes through this) — the sub-line: `armed · touched 12s ago` (live), `no tail · prompted 9m ago` (idle), `armed, silent 22m — tail died` (deaf with `armedAt`), `silent 2h` (deaf without), `signed out 2h ago` (offline).

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
  render(<App initialState={{ daemonReachable: false, buddies: [{ handle: "a", status: "live", armedAt: now, lastSeenAt: now }] }} />);
  expect(screen.getByRole("status")).toHaveTextContent(/daemon/i);
  expect(screen.queryByText("listening")).toBeNull();
});
```

```ts
// src/ui/statusDetail.test.ts
const now = 1_700_000_000_000;

test("statusDetail explains the daemon's status; it never contradicts it", () => {
  expect(statusDetail({ status: "live", armedAt: now - 1000, tailSeenAt: now - 12_000 }, now)).toBe("armed · touched 12s ago");
  expect(statusDetail({ status: "idle", lastSeenAt: now - 9 * 60_000 }, now)).toBe("no tail · prompted 9m ago");
  expect(statusDetail({ status: "deaf", armedAt: now - 30 * 60_000, tailSeenAt: now - 22 * 60_000 }, now)).toBe("armed, silent 22m — tail died");
  expect(statusDetail({ status: "offline", signedOutAt: now - 2 * 60 * 60_000 }, now)).toBe("signed out 2h ago");
  expect(STATUS_WORD.live).toBe("listening");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run`
Expected: FAIL — `/api/daemon` 404s.

- [ ] **Step 3: Implement**

The route returns rt-client's `daemonHealth()` result as-is — it wraps `eventsHead()`, the cheapest call there is, and answers **200 with `reachable: false`** rather than an error status: the probe succeeded in learning the daemon is down, which is not itself a server failure.

`App` accepts an `initialState` prop (`{ daemonReachable?, buddies?, rooms?, members?, messages? }`) that seeds its query cache — the test seam every UI test uses instead of a network. The client polls `/api/daemon` every 5s. When unreachable, per the `DaemonDown` artboard: the banner (Mantine `Alert` light/`bad`) says *the transcript has gone quiet because nothing is answering at rt.sock, not because every agent is idle*, carries elapsed time and probe count (`down 4m · 48 probes`) and a probe-now action; the roster goes to opacity 0.6 with hollow dots and `presence unknown while the daemon is down` for every buddy; the page bar's fleet chips read `6 signed in · last known` and `presence withheld`; the composer is disabled with the draft kept (Task 7). **Nobody renders as listening, idle, deaf or offline.** Agent status is only meaningful while the daemon is reachable — a roster rendered from stale data during an outage is exactly the lie this task exists to prevent.

- [ ] **Step 4: Integration test — a stopped daemon renders as a stopped daemon**

This is the spec's "stopped daemon renders as a stopped daemon" integration test (item 6 in its Testing list; item 5 is the tail's exit-69 test). Stop the daemon, load the page, assert the banner appears and no buddy renders a status word. It is the test that would have caught the original defect.

- [ ] **Step 5: Run the tests**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/health.ts src/server/app.ts src/ui/DaemonBanner.tsx src/ui/statusDetail.ts src/app/App.tsx src/server/health.test.ts src/ui/DaemonBanner.test.tsx src/ui/statusDetail.test.ts
git commit -m "chat-viewer: daemon probe and banner

subscribe() reconnects silently, so a dead daemon looks identical to an
idle fleet without an explicit probe.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Rooms rail with DMs, the fleet page bar, and the live transcript

**Files:**
- Create: `src/ui/RoomRail.tsx`, `src/ui/PageBar.tsx`, `src/ui/Transcript.tsx`
- Modify: `src/app/App.tsx`
- Test: `src/ui/RoomRail.test.tsx`, `src/ui/PageBar.test.tsx`, `src/ui/Transcript.test.tsx`

**Interfaces:**
- Consumes: `RoomSummary` (`kind`, `participants`, `defaultWake`), `ChatMessage`; `GET /api/chat/rooms`, `/api/chat/buddies`, `/api/chat/messages/:room`, `POST /api/chat/mark`; the `chat` WS topic; `STATUS_WORD` from Task 4. `PageBar` (and Task 7's `Composer`) type their `buddies` prop as `Array<{ handle: string; status: BuddyStatus }>` — the narrow shape their tests pass — not the full buddy row.

- [ ] **Step 1: Write the failing tests**

```tsx
test("mention badges are visually distinct from plain unread", () => {
  render(<RoomRail rooms={[{ room: "build", memberCount: 3, unread: 4, mentions: 1 }]} />);
  expect(screen.getByLabelText("1 mention")).toHaveTextContent("@1");   // the glyph is the difference, not the colour
  expect(screen.getByLabelText("4 unread")).toHaveTextContent("4");
});

test("DM rooms sit in a direct section and are named by their pair, never the hash", () => {
  render(<RoomRail rooms={[
    { room: "build", memberCount: 3, unread: 0, mentions: 0 },
    { room: "dm-9f3a2b1c0d4e", memberCount: 3, unread: 1, mentions: 1, kind: "dm", participants: { a: "deck-main", b: "rt-chat-wt" } },
  ]} />);
  expect(screen.getByRole("heading", { name: /direct/i })).toBeInTheDocument();
  expect(screen.getByText("deck-main ↔ rt-chat-wt")).toBeInTheDocument();
  expect(screen.queryByText(/dm-9f3a/)).toBeNull();
});

test("the page bar counts the fleet, names handles behind a small count, and shows the room's wake mode", () => {
  render(<PageBar room={{ room: "build", memberCount: 3, unread: 0, mentions: 0, defaultWake: "mention" }} buddies={[
    { handle: "a", status: "live" }, { handle: "b", status: "live" }, { handle: "c", status: "idle" }, { handle: "gitq-main", status: "deaf" },
  ]} />);
  expect(screen.getByText("4 signed in")).toBeInTheDocument();
  expect(screen.getByText("2 listening: a, b")).toBeInTheDocument();
  expect(screen.getByText("1 deaf: gitq-main")).toBeInTheDocument();
  expect(screen.getByText("wakes: mention")).toBeInTheDocument();
});

test("mark read is explicit: rendering never calls it, the control does", async () => {
  render(<PageBar room={{ room: "build", memberCount: 3, unread: 4, mentions: 0 }} buddies={[]} />);
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

Build to the `Main` and `DirectMessage` artboards and the `Indicators` legend:

- **Rooms rail:** `#room` rows, active row in the accent wash; `@N` filled badge for mentions, outlined `N` for plain unread — distinguishable without colour because the glyph differs. Below the rooms, a **direct** section: every `kind: "dm"` row from `/api/chat/rooms`, labelled `a ↔ b` from `participants` and carrying the same badges; the hashed room name is never shown. Opening a DM shows its transcript like any room. The rail lists what the human is **in**: channels he joined and every DM (he is a member of all of them); the artboards' `not joined` badge is **not built here** (see "What this plan does not build").
- **Page bar** (console's second 64px bar): `#build` at 26px/700 — or `deck-main ↔ rt-chat-wt` with a `dm` tag for a DM — then the **fleet** chips from `/api/chat/buddies`: `N signed in` (buddies whose status is not `offline`), `N listening`, `N idle`, `N deaf`, where a chip whose count is ≤2 names its handles (`1 deaf: gitq-main`), so the stuck agent is read first, not found last; `offline` is not a chip. A `wakes: <mode>` chip shows the room's `defaultWake` (`mention` when unset) — read-only in v1; a DM shows `wakes: all` since its memberships are. A `mark read` button with the unread count calls `POST /api/chat/mark`; nothing else ever advances the cursor. Under daemon-down the chips read `N signed in · last known` and `presence withheld` (Task 4).
- **Transcript:** one card, rows separated by soft borders — handle (600) and **local** time, then the body. No status dot beside a message: a dot next to a 21:58 message would be a claim about then; status lives on the roster row (Task 6). A top edge row (`41 older messages · load on scroll`) is the scrollback affordance; it becomes `Loading older…` while a `before` page is in flight. The `N new` divider marks the read cursor and carries a `mark read` link on the phone. Bodies get `overflow-wrap: anywhere` (agents paste paths), inline `code` gets a rule, code blocks scroll on their own `overflow-x`. A DM transcript opens with `start of this conversation · <day>` and the page bar says `2 participants · you see every DM`.

The transcript appends from WS frames and scroll-backs through `GET /api/chat/messages/:room` with `before`. **A frame carries only `{ id }` — a pointer, not prose** (chat owns the message store; the journal is the doorbell), so the client fetches the message body on arrival or refetches the tail. DM rooms wake over the same `chat/<room>/msg` topic — the relay predicate from Task 3 already matches them.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/RoomRail.tsx src/ui/PageBar.tsx src/ui/Transcript.tsx src/app/App.tsx src/ui/*.test.tsx
git commit -m "chat-viewer: rooms rail with DMs, fleet page bar, live transcript

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: The roster — listening, idle, deaf, offline

**Files:**
- Create: `src/ui/Roster.tsx`
- Modify: `src/app/App.tsx` — mounts the roster as the third column
- Test: `src/ui/Roster.test.tsx`, `src/app/App.test.tsx` (the mount assertion)

**Interfaces:**
- Consumes: `GET /api/chat/buddies` (Task 2) — `PresenceRow & { status, rooms }` per buddy; `STATUS_WORD` and `statusDetail` from Task 4 (this component renders the daemon's status and the sub-line, it derives neither).
- Produces: `<Roster buddies now roomMembers daemonReachable compact? onPick(handle, { inRoom: boolean })>` — `roomMembers` is the current room's member handles from `/api/chat/who/:room` (for a DM, its two participants), so `inRoom = roomMembers.includes(handle)`; `compact` drops the path line (the phone drawer, Task 7); `onPick` is what the composer (Task 7) wires to *insert @handle* or *DM instead*.

- [ ] **Step 1: Write the failing test**

```tsx
const now = 1_700_000_000_000;
const b = (handle: string, status: BuddyStatus, extra: Partial<PresenceRow & { rooms: string[] }> = {}) =>
  ({ sessionId: handle, handle, baseHandle: handle, signedInAt: now - 60_000, lastSeenAt: now, rooms: [], status, ...extra });

test("four sections in the spec's order, offline collapsed to one line", () => {
  render(<Roster now={now} roomMembers={[]} buddies={[
    b("gitq-main", "deaf", { armedAt: now - 30 * 60_000, tailSeenAt: now - 22 * 60_000 }),
    b("rt-chat-wt", "live", { armedAt: now, tailSeenAt: now - 12_000, rooms: ["build", "repo-tools", "dm"] }),
    b("workforest-e2e", "offline", { signedOutAt: now - 2 * 60 * 60_000 }),
    b("board-fix-auth", "idle", { statusText: "waiting on CI", rooms: ["build"] }),
  ]} />);
  const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
  expect(headings).toEqual(["listening 1", "idle 1", "deaf 1", "offline · last 24h 1"]);
  expect(screen.getByTestId("status-rt-chat-wt")).toHaveTextContent("listening");
  expect(screen.getByTestId("sub-gitq-main")).toHaveTextContent(/armed, silent 22m — tail died/);
  expect(screen.getByText("“waiting on CI”")).toBeInTheDocument();
  expect(screen.getByTestId("row-workforest-e2e")).toHaveTextContent(/signed out 2h ago/);
  expect(screen.getByTestId("row-workforest-e2e").querySelector("[data-testid=sub-workforest-e2e]")).toBeNull();   // collapsed: the signed-out line is the row itself, no sub- element
});

test("a buddy is identified by what it is: branch, pane, path, and its rooms as tags", () => {
  render(<Roster now={now} roomMembers={[]} buddies={[
    b("acme-dev-42", "live", { cwd: "/Users/m/GitHub/acme-wt-invite-onboarding", branch: "fix-auth", pane: "4", rooms: ["build", "dm"] }),
  ]} />);
  expect(screen.getByText(/…\/acme-wt-invite-onboarding/)).toBeInTheDocument();   // head-truncated: the tail discriminates
  expect(screen.getByText(/fix-auth · pane 4/)).toBeInTheDocument();
  expect(screen.getByText("#build")).toBeInTheDocument();
  expect(screen.getByText("dm")).toBeInTheDocument();
});

test("picking a buddy says whether it is in this room", async () => {
  const onPick = vi.fn();
  render(<Roster now={now} roomMembers={["a"]} onPick={onPick} buddies={[
    b("a", "live", { rooms: ["build"] }), b("c", "idle", { rooms: ["release"] }),
  ]} />);
  await userEvent.click(screen.getByTestId("row-a"));
  await userEvent.click(screen.getByTestId("row-c"));
  expect(onPick).toHaveBeenNthCalledWith(1, "a", { inRoom: true });
  expect(onPick).toHaveBeenNthCalledWith(2, "c", { inRoom: false });
});

test("withheld: no status word or colour while the daemon is unreachable", () => {
  render(<Roster now={now} roomMembers={[]} daemonReachable={false} buddies={[b("a", "live", { armedAt: now })]} />);
  expect(screen.getByTestId("status-a")).toHaveTextContent("—");
  expect(screen.getByTestId("sub-a")).toHaveTextContent(/presence unknown while the daemon is down/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/ui/Roster.test.tsx`
Expected: FAIL — no module.

- [ ] **Step 3: Implement**

The roster is the **fleet**, not the room — everyone signed in, per the `Roster` and `Main` artboards, under the heading `BUDDIES` with `the fleet, not the room` as its caption. Four sections in this order, each captioned with its count: **listening**, **idle**, **deaf**, **offline · last 24h**. Within a section, sign-in order (`signedInAt`) — the sections are the status the user asked to see; nothing else re-sorts.

Each row, per the artboards: 8px status dot (green/amber/red; hollow for offline); handle (600) with `STATUS_WORD[status]`; the away message as an italic quote when `statusText` is set; `branch · pane N` (either half omitted when absent); the path on its own line, **head-truncated** (`…/mr-board-wt-invite-onboarding` — the tail is the discriminating end); the sub-line from `statusDetail`; the buddy's rooms as small tags (`#build`, and `dm` for any DM membership). Offline buddies collapse to handle + `signed out 2h ago` rendered on the row itself (no `sub-` element, no deets), since they are stale by definition. `branch`, `cwd`, `pane`, `statusText` are all optional; a plan-1 member that never signed in is not a buddy and does not appear here (it still appears in `who <room>` on the phone drawer's room view).

The human is never a buddy: presence is per agent session. Tapping a row calls `onPick(handle, { inRoom })` with `inRoom` from `roomMembers` — the composer decides whether that means `@handle` or *DM instead* (Task 7). `compact` renders the same rows without the path line.

`App` mounts the roster as the third column of the kit's `RailShell` (the `Main` artboard: rail, transcript, roster), fed by `/api/chat/buddies` polled every 5s and refetched on any `chat/wake/*` frame, and by the current room's `/api/chat/who/:room` for `roomMembers`. A `Roster` that exists but is never mounted is the failure this step exists to prevent — assert in `App.test.tsx` that seeding `initialState.buddies` renders a `row-<handle>`. Focusing the buddy's herdr pane from the row is **not built here** — no route addresses a pane by id — so the row must read completely on its own, which it does.

`now` is a prop so relative times are testable without faking timers; `daemonReachable={false}` withholds every status (Task 4's rule), never showing a stale word.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/Roster.tsx src/app/App.tsx src/ui/Roster.test.tsx src/app/App.test.tsx
git commit -m "chat-viewer: the fleet roster — listening, idle, deaf, offline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Composer with DM-instead, mobile, and publishing

**Files:**
- Create: `src/ui/Composer.tsx`
- Modify: `src/server/chat.ts` (the post and dm routes), `src/app/App.tsx`
- Test: `src/ui/Composer.test.tsx`, `src/server/chat.test.ts`

**Interfaces:**
- Consumes: `chatPost` (with `mentions?`), `chatJoin`, `chatDm`, `chatRooms` from `@mattstack/rt-client`; the roster's `onPick` (Task 6).
- Produces: `POST /api/chat/post` `{ room, body }` and `POST /api/chat/dm` `{ to, body }` → `{ room, id }`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/server/chat.test.ts
test("a dropped write surfaces as an error, never a silent success", async () => {
  // plan 1 maps an exhausted retry budget to ok:false precisely so this
  // path cannot look like the normal silent success of a post.
  vi.mocked(rt.chatRooms).mockResolvedValueOnce({ ok: true, data: { rooms: [{ room: "r", memberCount: 1, unread: 0, mentions: 0 }] } });
  vi.mocked(rt.chatJoin).mockResolvedValueOnce({ ok: true, data: { handle: "matt", memberCount: 2, unread: 0 } });
  vi.mocked(rt.chatPost).mockResolvedValueOnce({ ok: false, error: "write dropped" });
  expect((await app.request("/api/chat/post", { method: "POST", body: JSON.stringify({ room: "r", body: "x" }) })).status).toBe(502);
});

test("posting into a room the human has not joined joins first, then posts", async () => {
  vi.mocked(rt.chatRooms).mockResolvedValueOnce({ ok: true, data: { rooms: [] } });
  vi.mocked(rt.chatJoin).mockResolvedValueOnce({ ok: true, data: { handle: "matt", memberCount: 2, unread: 0 } });
  vi.mocked(rt.chatPost).mockResolvedValueOnce({ ok: true, data: { id: 1, recipients: [] } });
  const res = await app.request("/api/chat/post", { method: "POST", body: JSON.stringify({ room: "release", body: "hello" }) });
  expect(res.status).toBe(200);
  expect(rt.chatJoin).toHaveBeenCalledWith(expect.objectContaining({ room: "release", handle: "matt" }), expect.anything());
  expect(vi.mocked(rt.chatJoin).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(rt.chatPost).mock.invocationCallOrder[0]);
});

test("posting into a DM never joins: the human is already its silent member and join refuses DM rooms", async () => {
  vi.mocked(rt.chatRooms).mockResolvedValueOnce({ ok: true, data: { rooms: [
    { room: "dm-9f3a2b1c0d4e", memberCount: 3, unread: 0, mentions: 0, kind: "dm", participants: { a: "deck-main", b: "rt-chat-wt" } },
  ] } });
  vi.mocked(rt.chatPost).mockResolvedValueOnce({ ok: true, data: { id: 2, recipients: ["deck-main", "rt-chat-wt"] } });
  const res = await app.request("/api/chat/post", { method: "POST", body: JSON.stringify({ room: "dm-9f3a2b1c0d4e", body: "seen — fine by me" }) });
  expect(res.status).toBe(200);
  expect(rt.chatJoin).not.toHaveBeenCalled();
});

test("dm opens or reuses the pair's room and posts as the human", async () => {
  vi.mocked(rt.chatDm).mockResolvedValueOnce({ ok: true, data: { room: "dm-1a2b3c4d5e6f", id: 3, recipients: ["rt-chat-wt"] } });
  const res = await app.request("/api/chat/dm", { method: "POST", body: JSON.stringify({ to: "rt-chat-wt", body: "ping" }) });
  expect(await res.json()).toMatchObject({ room: "dm-1a2b3c4d5e6f", id: 3 });
  expect(rt.chatDm).toHaveBeenCalledWith(expect.objectContaining({ from: "matt", to: "rt-chat-wt", body: "ping" }), expect.anything());
});
```

```tsx
// src/ui/Composer.test.tsx
test("@ autocompletes from the roster, offers DM instead for a buddy outside the room, and warns on deaf", async () => {
  render(<Composer room="build" roomMembers={["acme-dev-42", "gitq-main"]} buddies={[
    { handle: "acme-dev-42", status: "live" }, { handle: "gitq-main", status: "deaf" }, { handle: "board-fix-auth", status: "idle" },
  ]} />);
  await userEvent.type(screen.getByRole("textbox"), "@");
  expect(await screen.findByText("acme-dev-42")).toBeInTheDocument();
  expect(screen.getByText("gitq-main")).toBeInTheDocument();                       // idle and deaf are listed, not filtered
  expect(screen.getByText(/won't see this until its tail restarts/)).toBeInTheDocument();
  expect(screen.getByText(/not in #build — DM instead/)).toBeInTheDocument();      // board-fix-auth is signed in but elsewhere
  expect(screen.getByText(/@here/)).toHaveTextContent(/wakes 2 agents/);
});

test("choosing DM instead posts through /api/chat/dm and navigates to the pair's room", async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ room: "dm-1a2b3c4d5e6f", id: 3 })));
  const onNavigate = vi.fn();
  render(<Composer room="build" roomMembers={[]} onNavigate={onNavigate} buddies={[{ handle: "board-fix-auth", status: "idle" }]} />);
  await userEvent.type(screen.getByRole("textbox"), "can you take the flaky one? @");
  await userEvent.click(await screen.findByText("board-fix-auth"));
  await userEvent.click(screen.getByRole("button", { name: /send/i }));
  expect(fetchMock).toHaveBeenCalledWith("/api/chat/dm", expect.objectContaining({ method: "POST" }));
  expect(onNavigate).toHaveBeenCalledWith("dm-1a2b3c4d5e6f");
});

test("the composer is disabled, draft kept, while the daemon is unreachable", async () => {
  const { rerender } = render(<Composer room="build" roomMembers={[]} buddies={[]} daemonReachable={true} />);
  await userEvent.type(screen.getByRole("textbox"), "merge it");
  rerender(<Composer room="build" roomMembers={[]} buddies={[]} daemonReachable={false} />);
  expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  expect(screen.getByRole("textbox")).toHaveValue("merge it");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bunx vitest run`
Expected: FAIL — no `Composer` module, `/api/chat/post` and `/api/chat/dm` 404.

- [ ] **Step 3: Implement**

Posts as the `chat.humanHandle` setting (default `matt`). `POST /api/chat/post` looks the room up in `chatRooms(human)`: a `kind: "dm"` row is posted into directly (the human is a member of every DM by construction, and `chat:join` refuses DM rooms); any other room is `chatJoin`ed before `chatPost` (join is idempotent for an existing member, so the server does it unconditionally) — auto-join is server-side, consistent with plan 1's join-creates, and the browser never touches rt-client. Explicit mentions picked from the popover travel as `mentions` so a buddy picked by name wakes even if the body was edited after. `POST /api/chat/dm` calls `chatDm({ from: human, to, body })` and returns its `{ room, id }`; the client navigates to that room, which then appears in the rail's direct section.

Per the `Phone`, `PhoneRooms`, `DirectMessage` artboards and the `Indicators` legend:

- **Composer:** 16px input on mobile (below that iOS zooms the viewport on focus and the page scrolls sideways — the exact failure the 375px rule forbids); 44px send button and 44px header controls. On the desk `↵` sends and `⇧↵` adds a line; on the phone return adds a line and the button sends. The `@` popover draws from the **roster** — everyone signed in, dot + status word, 44px rows, listening first, idle and deaf listed rather than filtered (a mention still lands in an idle agent's unread); a buddy not in this room is labelled `not in #room — DM instead` and choosing it turns the send into `POST /api/chat/dm`; the deaf row carries *won't see this until its tail restarts* — the one failure this viewer exists to catch, delivered at the moment of the mistake; `@here` last with what it costs (`wakes N agents`, the room's members minus the human). Inside a DM the popover offers only the other participant. Under daemon-down the input is disabled with *Can't post — rt daemon unreachable. Your draft is kept.* and the send button loses its fill; the draft survives.
- **Phone header:** rooms/roster toggle (44px), `#room` or `a ↔ b` truncating, and the fleet counts as one tap target (`● 3 ● 2 ● 1`, listening/idle/deaf) that opens the drawer — no separate members button.
- **Drawer** (`Drawer` position left, size sm, overlay 0.4), per `PhoneRooms`: rooms with the same badges, the direct section, then **buddies** (`tap to mention or DM`) rendered by the Task 6 roster with `compact` (no path line); tapping a buddy inserts `@handle` when it is in the room, otherwise starts a DM, and closes. No fake status bar or keyboard is drawn.

- [ ] **Step 4: Verify on a phone-sized viewport**

Load the page at **375px** wide and confirm: no horizontal page scroll, the composer is usable with the keyboard up (no zoom on focus), the `@` popover is tappable including a *DM instead* row, and wide content — a pasted path in prose, a code block — scrolls or wraps inside its own container. Compare against `design/artboards/Phone.dc.html` and `PhoneRooms.dc.html`. **Screenshot it and put the screenshot in your report** — this is the reason the app is published, and "it reflows" is not the same as "it is usable."

- [ ] **Step 5: Publish**

```bash
deck domain m4tthew.dev          # if not already configured
deck password chat               # gate 1: the gateway password
deck access chat emails <list>   # gate 2: the Google sign-in allow-list (optional, additive)
deck publish chat on             # only after a gate is confirmed — order is the security-relevant part
```

Deck's per-app gates are the whole auth story — no auth code is written for this feature. Confirm the gate actually challenges from a logged-out browser before reporting done; **an unauthenticated page that can post into rooms — and now DM any agent — is a page that can steer Matt's agents.**

- [ ] **Step 6: Run everything**

Run: `bunx vitest run && bunx tsc -b`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/Composer.tsx src/server/chat.ts src/app/App.tsx src/ui/Composer.test.tsx src/server/chat.test.ts
git commit -m "chat-viewer: composer with DM-instead, mobile layout, deck gates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
## What this plan does not build

**`not joined` rooms in the rail.** The rail shows the rooms the human is a member of plus every DM; listing every channel needs an all-rooms handler that neither plan 1 nor plan 3 shipped (`chat:rooms` is `listRooms(handle)`). Returns with a `chat:rooms --all` verb.

**Focusing a herdr pane from a member row.** No route or CLI addresses a pane by id today. Returns when herdr exposes one; the row is designed to read completely without it.

**A shared UI kit.** Console and chat each own their `create-mantine-kit` copy and may edit it freely — the kit is a starting point the app owns, not a library, and not a synced template. Duplication between the two apps is answered by shared *tokens* (`@mattstack/mantine-tokyo`) and owned *components*; component-level divergence is accepted as the price of ownership, and a console improvement worth having in chat is ported on purpose. This is a decision, not an omission.

The `@matt` notifier producer (**plan 1, Task 10**) and optional ntfy push
(**Task 11**) — both rt-side work, and both scheduled rather than left
homeless. Neither is needed for the viewer to be useful. Pushover is
deferred, not scheduled: Task 11 cut it for v1 and rejects it at
validation.

**Setting a room's default wake mode from the viewer.** The `wakes:` chip is read-only; `rt chat join --wake-on` on the creating join sets it. Returns with a `chat:room-default` verb.

**Sign-on notifications** (the AIM door sound) and **signing the human in as a buddy** — presence is per agent session and the human is never a buddy; the spec keeps both out of scope.
