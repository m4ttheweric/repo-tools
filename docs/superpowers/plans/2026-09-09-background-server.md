# Background Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One daemon-owned background herdr server, addressable from every pane-consuming verb via the `bg:` ref prefix, with herd hidden mode, the runner's `--herdr` engine, and `rt agent start --bg` as its clients; plus the RT-114 `--help` fix.

**Architecture:** A `bg-service` daemon unit (generalized from `lib/daemon/herd-session.ts`) owns server lifecycle, login-shell env seeding, a parity probe, and a persistent claims registry. A `parsePaneRef`/`formatPaneRef` pair in rt-client makes `bg:w1:p2` the wire/display form riding existing string fields (no schema changes). The behavior fork lives only in `pane:focus` (bare ref = tray, `bg:` ref = attend); every other seam just resolves the ref to a socket.

**Tech Stack:** Bun/TypeScript daemon + CLI, bun:sqlite stores, herdr unix-socket RPC, rt-client (`packages/rt-client`, file: consumers).

**Spec:** `docs/superpowers/specs/2026-09-09-background-server-design.md` (this worktree; read it first — the audit-grade census behind it lives in the spec's Decisions/Environment/Addressing sections).

## Global Constraints

- No em dashes or en dashes anywhere (code, comments, commit messages, docs). Use `--` or rephrase.
- This repo is PUBLIC: neutral fixture names only; `sh scripts/repo-purity.sh` must pass before every commit.
- Never push; never publish rt-client; never restart the dev daemon. The hard cutover (merge, daemon restart, `packages/rt-client` publish at 0.18.0 with the bump announced to peer sessions, `herdr session stop herd` for the legacy hidden server) is the operator's, listed in Task 10.
- `packages/rt-client`: bump version `0.17.0` -> `0.18.0` in the same commit as the first source change there; run `bun run build` in `packages/rt-client` after every change to it (`test/dist-freshness.test.ts` enforces; treat its failure as an instruction).
- No new CLI command modules (no `lib/module-registry.ts` changes needed); no eager imports added to `lib/command-tree.ts` or command modules (`lib/__tests__/no-eager-tui.test.ts` and `scripts/bench-startup.ts` gate this).
- Claims persist in their own SQLite file (`~/.mattstack/rt/bg-claims.db`), opened with the `lib/daemon/herd-store.ts` idiom. Never `state.db`; `SCHEMA_VERSION` is not touched anywhere in this plan.
- Logging: no outcome logging in handlers (the seams own it); domain events only, via `ctx.log`/module child loggers, per CLAUDE.md's logging architecture.
- Every daemon-side herdr call takes its socket explicitly where a `bg:` ref can reach it; a bare ref always means the visible server (backcompat, permanent).
- Run `bun run test` while iterating, and `bun run test:all` (includes e2e) before calling the branch done — e2e is NOT in `bun run test` and CI runs it.
- Commit after every task; imperative messages, no dashes, trailer:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## File structure

| File | Change |
|---|---|
| `lib/cli-verb-help.ts` | Create: `verbHelpRequested()` helper (RT-114) |
| `commands/agent.ts`, `commands/chat.ts` | Modify: verb-level `--help` guards |
| `lib/__tests__/command-tree-help.test.ts` | Modify: self-dispatching leaf coverage + structural sweep |
| `packages/rt-client/src/pane-ref.ts` | Create: `PaneRef`, `parsePaneRef`, `formatPaneRef`, `BG_PREFIX` |
| `packages/rt-client/src/index.ts`, `package.json` | Modify: export + version 0.18.0 |
| `lib/daemon/bg-service.ts` | Create: generalizes `herd-session.ts` (session `bg`, env seeding, parity probe) |
| `lib/daemon/bg-claims-store.ts` | Create: persistent claims (owner, optional pane) |
| `lib/daemon/handlers/bg.ts` | Create: `bg:ensure`/`bg:status`/`bg:stop`/`bg:release` handlers |
| `lib/daemon.ts`, `lib/daemon/command-router.ts` | Modify: construct + thread bg service/claims; retire `herdHidden` |
| `lib/daemon/attend.ts` | Create: `attendPane()` extracted from `herd:attend` |
| `lib/daemon/handlers/herd.ts` | Modify: bg service + claims; attend delegates; refs in display |
| `lib/daemon/herd-session.ts` | Delete (superseded by bg-service; its test migrates) |
| `lib/daemon/pane-ref-socket.ts` | Create: `resolvePaneRef()` ref -> socket resolver |
| `lib/daemon/inject.ts`, `lib/daemon/gate-escape.ts` | Modify: socket threading by ref |
| `lib/daemon/handlers/pane.ts` | Modify: ref parsing on peek/send; dual-server list; focus fork |
| `lib/daemon/handlers/chat.ts` | Modify: ref-aware pane->session resolution |
| `lib/daemon/handlers/agent.ts`, `commands/agent.ts` | Modify: `--bg` flag, ensure+claim, ref in results |
| `commands/runner.ts` | Modify: `--herdr` gets socket via daemon ensure+claim; release in teardown |
| `packages/rt-client/src/commands.ts`, `client.ts` | Modify: `bg:*` shapes + wrappers; `agent:start` payload `bg?` |
| `e2e/tests/bg.test.ts` | Create: end-to-end recipe |
| `lib/daemon/__tests__/bg-service.test.ts`, `bg-claims-store.test.ts`, `bg-handlers.test.ts` | Create |

Read before starting: the spec; `lib/daemon/herd-session.ts`, `lib/daemon/handlers/herd.ts` (attend body, lines ~406-441), `lib/daemon/inject.ts`, `lib/daemon/gate-escape.ts`, `lib/daemon/handlers/pane.ts`, `commands/agent.ts`, `commands/runner.ts`, `lib/command-tree.ts` (dispatch lines ~160-250), `lib/daemon/herd-store.ts` (store idiom), `lib/daemon/__tests__/herd-session.test.ts` and `pane-handlers.test.ts` (fake patterns), `e2e/tests/herd.test.ts` (e2e recipe).

---

### Task 1: RT-114 — `--help` on self-dispatching leaves

**Files:**
- Create: `lib/cli-verb-help.ts`
- Modify: `commands/agent.ts` (the `agent()` verb dispatch, ~line 234), `commands/chat.ts` (same pattern at its verb dispatch)
- Test: `lib/__tests__/command-tree-help.test.ts`

**Interfaces:**
- Produces: `verbHelpRequested(rest: string[]): boolean` — true iff `rest[0]` is `--help` or `-h`. Self-dispatching leaf contract: after peeling its verb token, the module calls this and prints its own usage + returns 0 before any side effect.

- [ ] **Step 1: Write the failing tests**

In `lib/__tests__/command-tree-help.test.ts` add:

```ts
import { verbHelpRequested } from "../cli-verb-help.ts";
import { readFileSync } from "node:fs";

describe("verbHelpRequested", () => {
  test("true for --help/-h as first remaining token", () => {
    expect(verbHelpRequested(["--help"])).toBe(true);
    expect(verbHelpRequested(["-h", "x"])).toBe(true);
  });
  test("false otherwise, including value-position --help", () => {
    expect(verbHelpRequested([])).toBe(false);
    expect(verbHelpRequested(["--text", "--help"])).toBe(false);
  });
});

describe("self-dispatching leaves guard --help (RT-114)", () => {
  // Self-dispatching leaf = tree leaf whose module routes its own verbs.
  // Structural enforcement, same idiom as no-ui-in-cli.test.ts: the module
  // source must consult verbHelpRequested.
  for (const mod of ["commands/agent.ts", "commands/chat.ts"]) {
    test(`${mod} consults verbHelpRequested`, () => {
      expect(readFileSync(mod, "utf8")).toContain("verbHelpRequested(");
    });
  }
});
```

- [ ] **Step 2: Run to verify failure** — `bun test lib/__tests__/command-tree-help.test.ts` fails: module not found / source lacks the call.

- [ ] **Step 3: Implement**

`lib/cli-verb-help.ts`:

```ts
/** RT-114: self-dispatching leaves (agent, chat) route their own verbs, so
    the tree's leaf --help guard (rest[0] only) never sees `start --help`.
    Each such module calls this after peeling its verb token. First-token
    only, so a flag value like `--text --help` still reaches the handler. */
export function verbHelpRequested(rest: string[]): boolean {
  return rest[0] === "--help" || rest[0] === "-h";
}
```

In `commands/agent.ts` `agent()` right after the verb is peeled and before any verb function runs: `if (verbHelpRequested(rest)) { usage(); return 0; }` (use the module's existing usage printer; if only an error-path usage string exists, extract it into a `usage()` that prints to stdout and reuse it in both places). Same guard in `commands/chat.ts`'s verb dispatch.

- [ ] **Step 4: Verify green + manual probe** — tests pass; `bun run cli.ts agent start --help` prints usage, exits 0, and `rt agent list` shows no new record.

- [ ] **Step 5: Purity + commit**

```bash
sh scripts/repo-purity.sh
git add lib/cli-verb-help.ts commands/agent.ts commands/chat.ts lib/__tests__/command-tree-help.test.ts
git commit -m "cli: --help on self-dispatching leaf verbs prints usage instead of dispatching"
```

---

### Task 2: Pane refs in rt-client

**Files:**
- Create: `packages/rt-client/src/pane-ref.ts`
- Modify: `packages/rt-client/src/index.ts`, `packages/rt-client/package.json` (0.17.0 -> 0.18.0)
- Test: `packages/rt-client/test/pane-ref.test.ts`

**Interfaces:**
- Produces (used by Tasks 5-9):

```ts
export const BG_PREFIX = "bg:";
export type PaneServer = "visible" | "bg";
export interface PaneRef { server: PaneServer; paneId: string }
export function parsePaneRef(ref: string): PaneRef;   // "bg:w1:p2" -> {server:"bg",paneId:"w1:p2"}; bare -> visible
export function formatPaneRef(paneId: string, server: PaneServer): string; // inverse; visible stays bare
```

- [ ] **Step 1: Failing tests** — `packages/rt-client/test/pane-ref.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { BG_PREFIX, formatPaneRef, parsePaneRef } from "../src/pane-ref.ts";

describe("pane refs", () => {
  test("bare ref is visible", () => {
    expect(parsePaneRef("w1:p2")).toEqual({ server: "visible", paneId: "w1:p2" });
  });
  test("bg prefix parses and strips", () => {
    expect(parsePaneRef("bg:w1:p2")).toEqual({ server: "bg", paneId: "w1:p2" });
  });
  test("round trip: format output always parses back", () => {
    for (const server of ["visible", "bg"] as const) {
      const ref = formatPaneRef("w7A:pY", server);
      expect(parsePaneRef(ref)).toEqual({ server, paneId: "w7A:pY" });
    }
  });
  test("format visible is bare (backcompat byte-identical)", () => {
    expect(formatPaneRef("w1:p2", "visible")).toBe("w1:p2");
  });
  test("double prefix does not nest", () => {
    expect(parsePaneRef(BG_PREFIX + BG_PREFIX + "w1:p2").paneId).toBe(BG_PREFIX + "w1:p2");
  });
});
```

- [ ] **Step 2: Verify fail, implement** — `pane-ref.ts` exactly per the interface; export `* from "./pane-ref.ts"` in `index.ts`; bump version to `0.18.0`.
- [ ] **Step 3: Build + green** — `cd packages/rt-client && bun run build && bun test` and repo root `bun test packages` (dist-freshness must pass).
- [ ] **Step 4: Commit** — `git add packages/rt-client && git commit -m "rt-client 0.18.0: pane ref grammar with bg prefix"`

---

### Task 3: The bg service

**Files:**
- Create: `lib/daemon/bg-service.ts`
- Test: `lib/daemon/__tests__/bg-service.test.ts` (port + extend `herd-session.test.ts` fakes)

**Interfaces:**
- Consumes: nothing new (herdr client, Bun.spawn — same as `herd-session.ts`).
- Produces (Tasks 5-6 wire this):

```ts
export const BG_SESSION = "bg";
export function bgSocketPath(home?: string): string; // ~/.config/herdr/sessions/bg/herdr.sock
export interface BgService {
  socketPath(): string;
  up(): Promise<boolean>;
  ensure(): Promise<string>;           // returns socket; starts if down; env-seeded; runs parity probe on fresh start
  stop(): Promise<void>;               // no refusal here; refusal is the handler's (claims) job
  reprobe(): Promise<ParityReport>;    // lazy re-run for command-not-found-shaped spawn failures
  lastParity(): ParityReport | null;
}
export interface ParityReport { ok: boolean; drift: string[] }  // drift lines name the binary + both paths
export function createBgService(opts: {
  log: Logger;
  spawn?: (argv: string[], env: Record<string, string>, logPath: string) => void;
  available?: (sock: string) => Promise<boolean>;
  run?: (argv: string[], env: Record<string, string>) => Promise<{ exitCode: number; stdout: string }>;
  probePane?: (socket: string | null, cmd: string) => Promise<string>; // spawns a throwaway pane, returns its output; null socket = visible server
  home?: string; logDir?: string; readyTimeoutMs?: number;
}): BgService;
```

- [ ] **Step 1: Port the mechanics** — copy `herd-session.ts`'s start command (`set -m; nohup "$0" server >>"$1" 2>&1 &`), `envWithoutSocket`, cooldown + in-flight dedup, `stop()` via `herdr session stop bg`, renamed to `BG_SESSION`/`bgSocketPath`. Keep the doc comment about `HERDR_SOCKET_PATH` outranking `HERDR_SESSION`.
- [ ] **Step 2: Env seeding (new)** — before spawn, `run(["zsh", "-lc", 'printf "%s\\n" "$PATH" "$HOME" "$SHELL" "$TMPDIR" "$LANG"'], process.env)`; merge those five into the server env over the daemon's own values (missing probe output = log warn, fall back to today's behavior). The seeded env is captured once per `ensure()` that actually starts a server.
- [ ] **Step 3: Parity probe (new)** — after a fresh start: `probePane(socket, PROBE_CMD)` and `probePane(null, PROBE_CMD)` where `PROBE_CMD = 'zsh -lc "which bun node claude rt git; echo $PATH"'`; diff line-by-line; `ok: false` logs one structured `warn` with the drift lines; store as `lastParity()`. Default `probePane` uses the herdr runner (workspace `bg-probe`, one tab, `pane.read`, close workspace) — reuse the launch helpers `lib/daemon/handlers/agent.ts` uses (`launchInWorkspace`/`defaultHerdrRunner`); the visible-side probe uses the default socket. `reprobe()` re-runs both probes against a running server.
- [ ] **Step 4: Failing tests, then green** — port `herd-session.test.ts` cases (ensure spawns once, cooldown, up/stop) against the new names; add: env-seed test (fake `run` returns fixed five lines, assert spawn env contains them and `HERDR_SESSION=bg`, not the daemon PATH), parity test (fake `probePane` returns differing `which rt` lines -> `ok:false`, drift names `rt`), probe-failure tolerance (probe throws -> ensure still returns socket, warn logged). Run `bun test lib/daemon/__tests__/bg-service.test.ts`.
- [ ] **Step 5: Purity + commit** — `git add lib/daemon/bg-service.ts lib/daemon/__tests__/bg-service.test.ts && git commit -m "daemon: bg service with env seeding and parity probe"`

---

### Task 4: Claims store

**Files:**
- Create: `lib/daemon/bg-claims-store.ts`
- Test: `lib/daemon/__tests__/bg-claims-store.test.ts`

**Interfaces:**
- Produces:

```ts
export interface BgClaimsStore {
  claim(owner: string, pane?: string): void;       // idempotent upsert; owner like "herd:<id>" | "runner:<pid>" | "agent:<recId>"
  release(owner: string): boolean;
  releaseByPane(pane: string): string[];           // returns released owners (bg pane.closed hook)
  list(): Array<{ owner: string; pane: string | null; createdAt: number }>;
}
export function createBgClaimsStore(opts: { dbPath: string; log: Logger }): BgClaimsStore;
```

- [ ] **Step 1: Failing tests** — claim/release round trip; idempotent double-claim; `releaseByPane` releases only matching rows and returns owners; persistence across a close/reopen of the same `dbPath`; corrupt-file quarantine path (copy the herd-store test's idiom if one exists, else skip quarantine test and keep the code path).
- [ ] **Step 2: Implement** — copy `lib/daemon/herd-store.ts`'s open idiom verbatim (mkdir, WAL pragmas, quarantine-on-corruption); single table `claims(owner TEXT PRIMARY KEY, pane TEXT, created_at INTEGER NOT NULL)`, plain `CREATE TABLE IF NOT EXISTS` (no versioned migrations needed for one table).
- [ ] **Step 3: Green, purity, commit** — `git commit -m "daemon: persistent bg claims store"`

---

### Task 5: Daemon wiring + bg verbs

**Files:**
- Create: `lib/daemon/handlers/bg.ts`
- Modify: `lib/daemon.ts` (~560 store block, ~868-900 handler block), `lib/daemon/command-router.ts` (~60-140), `packages/rt-client/src/commands.ts`, `packages/rt-client/src/client.ts`
- Test: `lib/daemon/__tests__/bg-handlers.test.ts`

**Interfaces:**
- Consumes: `createBgService` (T3), `createBgClaimsStore` (T4).
- Produces — rt-client `Commands` additions (exact shapes):

```ts
"bg:ensure":  { payload: { claim?: string }; data: { socket: string; started: boolean; parity: { ok: boolean; drift: string[] } | null } };
"bg:status":  { payload: Record<string, never>; data: { up: boolean; socket: string; claims: Array<{ owner: string; pane: string | null; createdAt: number }> } };
"bg:stop":    { payload: Record<string, never>; data: { stopped: boolean } };   // live claims -> handler rejects with error naming them
"bg:release": { payload: { claim: string }; data: { released: boolean } };
```

plus `client.ts` wrappers `bgEnsure`, `bgStatus`, `bgStop`, `bgRelease` following the file's existing one-liner pattern.

- [ ] **Step 1: Failing handler tests** — with a fake `BgService` and real claims store on a tmp db: `bg:ensure` returns socket + registers the claim when given; `bg:ensure` with no claim just ensures; `bg:stop` rejects while `list()` is non-empty with an error message containing each owner; after `bg:release`, stop succeeds and calls `service.stop()`; `bg:status` reflects `up()` and claims. Follow `pane-handlers.test.ts` structure.
- [ ] **Step 2: Implement handlers** — `createBgHandlers(deps: { service: BgService; claims: BgClaimsStore; lifecycle: { watch(socket: string): void } })`. `bg:ensure` calls `service.ensure()`, then `deps.lifecycle.watch(socket)` (idempotent by socket, per `herd-lifecycle.ts`), then optional claim. No outcome logging (the router seam owns it).
- [ ] **Step 3: Wire** — `lib/daemon.ts`: `bgClaims = createBgClaimsStore({ dbPath: join(RT_DIR, "bg-claims.db"), log })`; `bgService = createBgService({ log })`; pass both through `buildRoutedHandlers` -> `command-router.ts` -> `createBgHandlers` and (T6) `createHerdHandlers`. Keep `herdHidden` construction in place until T6 removes it.
- [ ] **Step 4: rt-client** — add shapes + wrappers; `cd packages/rt-client && bun run build`; root `bun test packages`.
- [ ] **Step 5: Green, purity, commit** — `git commit -m "daemon: bg ensure, status, stop, release verbs with claim gated stop"`

---

### Task 6: Herd on the bg service; attend extracted

**Files:**
- Create: `lib/daemon/attend.ts`
- Modify: `lib/daemon/handlers/herd.ts`, `lib/daemon/command-router.ts`, `lib/daemon.ts`
- Delete: `lib/daemon/herd-session.ts` (+ its test, whose cases T3 already ported)
- Test: `lib/daemon/__tests__/herd-handlers.test.ts` (update), `lib/daemon/__tests__/attend.test.ts`

**Interfaces:**
- Consumes: `BgService`, `BgClaimsStore`, `parsePaneRef`/`formatPaneRef`.
- Produces:

```ts
// lib/daemon/attend.ts — extracted verbatim from herd:attend (handlers/herd.ts ~406-441)
export function attendPane(opts: {
  socket: string;                     // the bg/hidden server the pane lives on
  paneId: string;                     // bare id on that server
  session: string;                    // herdr session name for HERDR_SESSION in the attach command
  label: string;                      // visible tab label
  herdrRunnerFor: (socket: string | null) => HerdrRunner;
}): Promise<{ ok: true; tab: string; pane: string } | { ok: false; error: string }>;
```

- [ ] **Step 1: Extract attend** — move the `herd:attend` body (terminal_id resolution via the hidden runner, visible-tab creation via `herdrRunnerFor(null)`, the `env -u HERDR_SOCKET_PATH HERDR_SESSION=<session> herdr terminal attach <termId> --takeover` command) into `attendPane`; `herd:attend` becomes a thin delegate passing `session: BG_SESSION`. Unit-test `attendPane` with a fake runner asserting the attach command shape and tab creation on the visible runner.
- [ ] **Step 2: Re-point herd deps** — `HerdDeps.hidden` becomes `bg: BgService` + `claims: BgClaimsStore`. `herd:start --hidden`: `socket = await deps.bg.ensure(); deps.claims.claim("herd:" + id)`. `herd:stop-hidden`: claim-based — reject while `claims.list()` has ANY owner, naming them (herd or not); on empty, `deps.bg.stop()`. Wrap-up (and the crash/close paths that end a herd) release `herd:<id>`.
- [ ] **Step 3: Refs in display** — everywhere herd surfaces print a pane (`herd:spawn` result, `herd:status` jobs, room lifecycle posts), format with `formatPaneRef(pane, herd.hidden ? "bg" : "visible")`. Job rows and the `herdrSocket` column stay as stored today.
- [ ] **Step 4: Update tests, green** — herd-handlers tests swap the fake hidden for a fake bg service + tmp claims db; add: start claims, wrap-up releases, stop-hidden refuses on a foreign claim (`runner:999`).
- [ ] **Step 5: Purity + commit** — `git commit -m "herd: hidden mode rides the bg service with claims; attend extracted"`

---

### Task 7: The socket sweep — inject, escape, pane, chat

**Files:**
- Modify: `lib/daemon/inject.ts`, `lib/daemon/gate-escape.ts`, `lib/daemon/gate-push.ts` (injector construction site only), `lib/daemon/handlers/pane.ts`, `lib/daemon/handlers/chat.ts`, `lib/daemon/handlers/herd.ts` (gate origin refs)
- Test: existing handler tests + new cases

**Interfaces:**
- Consumes: `parsePaneRef`, `bgSocketPath()`.
- Produces: every pane-id-shaped payload field accepts a ref; a shared daemon-side resolver:

```ts
// lib/daemon/pane-ref-socket.ts (new, ~10 lines)
import { parsePaneRef } from "../../packages/rt-client/src/pane-ref.ts";
import { bgSocketPath } from "./bg-service.ts";
/** ref -> {paneId, sockPath}; sockPath undefined = visible default. */
export function resolvePaneRef(ref: string): { paneId: string; sockPath: string | undefined } {
  const { server, paneId } = parsePaneRef(ref);
  return { paneId, sockPath: server === "bg" ? bgSocketPath() : undefined };
}
```

- [ ] **Step 1: `inject.ts`** — add `sockPath?: string` to `InjectOptions`; every internal `herdr(...)` call passes `{ sockPath: opts.sockPath }`. Callers (`pane:send`, `chat:invite`) resolve the incoming ref first. Test: fake herdr records opts; a `bg:`-ref send reaches it with the bg socket.
- [ ] **Step 2: `gate-escape.ts`** — `createEscapeInjector` resolves the ref it is handed: `const { paneId, sockPath } = resolvePaneRef(ref); herdr("pane.send_keys", { pane_id: paneId, keys: ["escape"] }, { sockPath })`. `gate-push.ts` keeps passing `row.origin.paneId` unchanged — the ref now rides in that string (Step 5).
- [ ] **Step 3: `pane.ts` handlers** — `pane:peek`/`pane:send`: `resolvePaneRef(payload.paneId)`, thread `sockPath`. `pane:list`: visible snapshot as today; if `deps.bg.up()`, also snapshot the bg socket and append its panes with `paneId: formatPaneRef(id, "bg")` (and a `server: "bg"` field is NOT added — the ref carries it). `pane:focus`: parse; visible -> tray path unchanged; bg -> `attendPane({ socket: bgSocketPath(), paneId, session: BG_SESSION, label: paneId, herdrRunnerFor })`, result `{ paneId, focused: true, attendTab: tab }` — extend `PaneFocusResult` with `attendTab?: string` in rt-client (additive). Tests: peek/send/focus fakes assert socket choice; focus-bg asserts no tray call.
- [ ] **Step 4: `chat.ts` resolution** — `findPaneSessionRetrying` gains `sockPath?`; the `--pane` sign-in/sign-out/invite paths resolve refs before polling. Test: bg-ref sign-in resolves against the bg snapshot fake.
- [ ] **Step 5: Gate origins carry refs** — in `herd:ask`/`herd:milestone` (handlers/herd.ts), when the herd is hidden, store the pane ref (`formatPaneRef(job.pane, "bg")`) in the gate's `--pane`/origin field so escape injection round-trips. Test: hidden herd ask -> gate row's pane field is `bg:`-prefixed; escape injector called with it hits the bg socket.
- [ ] **Step 6: Green across handler suites, purity, commit** — `git commit -m "daemon: pane refs resolve sockets across inject, escape, pane, chat, gate origins"`

---

### Task 8: `rt agent start --bg`

**Files:**
- Modify: `commands/agent.ts` (flag), `lib/daemon/handlers/agent.ts`, `packages/rt-client/src/commands.ts` (`agent:start` payload `bg?: boolean`), `lib/daemon/herd-lifecycle.ts` (claim release hook)
- Test: `lib/daemon/__tests__/agent-handlers.test.ts` (extend)

**Interfaces:**
- Consumes: `bg:ensure` plumbing (T5), claims store `releaseByPane` (T4).
- Produces: `agent:start` with `bg: true` -> record's `paneId` stored/printed as `bg:`-ref; claim `agent:<record id>` with the pane; released on that pane's `pane.closed`/`pane.exited`.

- [ ] **Step 1: Failing tests** — agent-handlers: `bg: true` payload -> handler calls `bg.ensure()`, launches with `herdrSocket` = bg socket (existing `launch()` path — assert via the fake runner factory), claims `agent:<id>` with the bare pane, and the stored `AgentRecord.paneId` is the `bg:` ref. Lifecycle: a bg-socket `pane.closed` event releases the claim (fake claims store records `releaseByPane`).
- [ ] **Step 2: Implement** — handler: `if (payload.bg) { const socket = await deps.bg.ensure(); ... herdrSocket: socket }`, claim after launch returns the pane, format ref into the record. When a bg launch fails with a command-not-found shape (`exit 127` or a spawn error naming the binary), call `deps.bg.reprobe()` and include its drift lines in the returned error (the spec's lazy reprobe; this is its one call site). `herd-lifecycle.ts`: in the `pane.closed`/`pane.exited` handling, when the event's socket is the bg socket, call `deps.bgClaims.releaseByPane(formatPaneRef(paneId, "bg"))` (thread `bgClaims` in via daemon wiring). CLI: `--bg` boolean in `parseStartArgs` + tree def args list + help hint; refused together with `--surface headless` (error: `--bg is a herdr-surface option`).
- [ ] **Step 3: Green, rt-client rebuild, purity, commit** — `git commit -m "agent: --bg launches on the background server with a pane scoped claim"`

---

### Task 9: Runner `--herdr` on the bg server

**Files:**
- Modify: `commands/runner.ts` (~108-159 gate, teardown hook ~135-144)
- Test: `commands/__tests__/runner.test.ts` if present, else `lib/runner/__tests__` pattern — unit-test the new socket acquisition seam by extracting it

**Interfaces:**
- Consumes: `bgEnsure`/`bgRelease` rt-client wrappers (T5).
- Produces: extracted seam so the gate is testable:

```ts
// in commands/runner.ts
export async function acquireBgSocket(claim: string, deps = { bgEnsure, bgRelease }): Promise<{ sock: string; release: () => Promise<void> }>;
```

- [ ] **Step 1: Failing test** — `acquireBgSocket("runner:123", fakeDeps)` returns the fake socket, passes the claim through, and `release()` calls `bgRelease` with the same claim.
- [ ] **Step 2: Implement** — replace the ambient `herdrSocketPath()` + `herdrAvailable` gate in the `--herdr` branch with `const { sock, release } = await acquireBgSocket("runner:" + process.pid)`; daemon unreachable -> the existing error style, reworded: `the rt daemon is required for --herdr mode; start it and retry`. Engine construction unchanged (`new HerdrEngine(sock)`). Hook `release()` into the same signal handlers that call `runner.teardown()`, after teardown, best-effort.
- [ ] **Step 3: Green, purity, commit** — `git commit -m "runner: herdr mode acquires the bg server through the daemon with a board claim"`

---

### Task 10: e2e, invariants, cutover checklist

**Files:**
- Create: `e2e/tests/bg.test.ts`
- Modify: none beyond fixes it surfaces
- Test: full `bun run test:all`

- [ ] **Step 1: e2e recipe** — following `e2e/tests/herd.test.ts`'s fake-herdr recipe (unix-socket fake for snapshots/events + CLI shim journal): `bg:ensure` starts the fake server env-seeded (assert the journal's spawn env contains the probe PATH, not the daemon's); spawn an agent with `--bg`; `rt pane peek bg:<pane>` and `rt pane send bg:<pane>` hit the bg socket (journal); `rt pane focus bg:<pane>` produces an attach command containing `terminal attach` and `--takeover` (journal) and no tray call; `bg:stop` refused while the agent claim lives, naming it; release -> stop ok.
- [ ] **Step 2: Round-trip invariant already unit-covered (T2); spot-check display surfaces** — grep-assert in the e2e that `rt herd status --json` and `rt agent show --json` outputs for hidden/bg records carry `bg:`-prefixed pane fields.
- [ ] **Step 3: Full gates** — `bun run test:all`, `bun run picker:check`, `sh scripts/repo-purity.sh`, `bun run bench-startup` comparison if the script flags regressions.
- [ ] **Step 4: Commit** — `git commit -m "e2e: background server lifecycle, refs, focus as attend, claim gated stop"`
- [ ] **Step 5: Cutover checklist (operator's, NOT run by the implementer)** — merge to main; restart the dev daemon; `herdr session stop herd` (legacy hidden server); publish `@mattstack/rt-client` 0.18.0 from main (announce the bump to peer sessions first); consumers `bun install` per the file:-copy rule.

---

## Self-review against the spec

| Spec section | Task |
|---|---|
| bg service (ensure/up/stop, nohup mechanics, lazy) | 3, 5 |
| Claims + stop refusal naming owners | 4, 5, 6 |
| Ensure-on-touch write-shaped vs read-shaped | 5 (ensure verbs), 7 (list/peek answer without ensure) |
| Environment: seeding, parity probe, lazy reprobe, structural non-parity named | 3 |
| Addressing: prefix, parser in rt-client, refs ride existing strings | 2, 7 |
| Round-trip rule on every display surface | 6 (herd), 7 (pane list), 8 (agent), 10 (e2e spot-check) |
| Focus fork (only fork; herd attend as sugar) | 6, 7 |
| inject/gate-escape socket gap closed | 7 |
| Herd consumer (claims, stop-hidden alias, display refs) | 6 |
| Runner consumer (daemon RPC new, die-with-board kept) | 9 |
| agent --bg (herdrSocket head start, claim by pane) | 8 |
| RT-114 + whole-tree guard scoping | 1 |
| Hard cutover incl. legacy `herd` session stop | 10 |
