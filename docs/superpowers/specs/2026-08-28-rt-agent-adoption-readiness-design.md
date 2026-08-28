# rt agent adoption-readiness (resume params + daemon-optional herdr)

> Follow-up to `2026-08-25-rt-agent-handoff-design.md` (the shipped `rt agent`
> verb, PR #113). This spec closes the two things that stand between the
> primitive and a clean, opt-in consumer migration, WITHOUT migrating any
> consumer. It makes `rt agent` adoption-ready and honest about when the daemon
> is actually required.

## Problem

A survey of the three launchers the handoff spec named as follow-ups
(board, gitq, shepherdr) found the gap set is small and specific:

- **gitq** (`gitq/src/server/herdr.ts`): fire-and-forget launch only
  (`launchInWorkspace` + `buildPaneCommand`, no resume, no session id, no
  headless). A strict subset of `agent:start` today. Zero rt gaps.
- **board** (`board/src/herdr.ts`): launch fits `agent:start` (it already
  accepts `workspace`/`tab` overrides). Its RESUME does not: board resumes
  into a per-kind workspace (`reviews`/`responds`) with a `↺`/`⟲` tab prefix,
  but `agent:resume` hardcodes `workspace = repoLabel(repo)` and
  `tab = ↺ ${label}`. One gap.
- **shepherdr** (`mattstack-skills/attachments/orchestration/shepherdr`): a
  full parallel-orchestration substrate (own `herd.db`, event bus,
  ask/answer/report bridge, worktree lifecycle, a separate headless herd
  session with `hrd`/`HERDR_SESSION` routing). NOT a launcher. Adopting it
  would force rt to grow into a fan-out orchestrator, which the
  rt-agent-boundary invariant forbids. Out of scope, permanently.

Separately, `rt agent` routes every call through the daemon, which adds a
failure mode to the herdr surface that it does not technically need: only the
**headless** surface requires the daemon (a persistent process must reap the
async `claude -p` child and record its exit). The herdr surface just writes a
record and spawns the herdr CLI, both of which a short-lived CLI can do itself.

## Goal

Two changes, one cohesive lane:

- **A. `agent:resume` gains optional `workspace` + `tab`**, mirroring
  `agent:start`. Unblocks board; a correctness/symmetry fix regardless.
- **B. `rt agent` becomes daemon-optional for the herdr and read verbs.** When
  the daemon is down, the CLI runs the same handler logic in-process against
  the local `state.db`. Headless still requires the daemon.

Adoption of any consumer stays deferred and opt-in. This lane only sharpens the
primitive.

## Ratified decisions (Matt, 2026-08-27)

1. Do A and B together as one lane; write this spec first (state.db writer
   invariant deserves a written contract).
2. B is a **CLI feature**, not a wrapper feature. The rt-client wrappers stay
   pure IPC clients (they cannot import daemon-side handler code). Herdr-only
   consumers that want the fallback shell out to `rt agent ... --json`; that is
   the recommended adoption pattern for them.
3. Headless in fallback is a hard error, not a synchronous foreground run. "It
   genuinely doesn't need the daemon unless headless is wanted" (Matt).
4. No schema change: the `agents` table already exists (it landed in
   `V7_SCHEMA`; current `SCHEMA_VERSION` on main is 8, v8 having added
   `chat_rooms.archived_at`). Neither A nor B bumps `SCHEMA_VERSION`.

## Design

### A. Resume workspace/tab overrides

`agent:resume` payload gains two optional fields; defaults are unchanged when
omitted, so every current caller is unaffected.

```text
Commands["agent:resume"].payload:
  { id: string; prompt?: string; surface?: AgentSurface;
    workspace?: string; tab?: string }   // NEW: workspace, tab
```

Handler (`lib/daemon/handlers/agent.ts`, `agent:resume`):

```text
const tabLabel       = payload.tab       ?? `↺ ${rec.label ?? rec.id}`;
const workspaceLabel = payload.workspace ?? repoLabel(rec.repo);
```

That two-liner is the behavioral change, but delivering it end to end is FOUR
edits, and the wrapper edit is the one that bites if missed:

1. Add `workspace?` / `tab?` to `Commands["agent:resume"].payload`
   (`packages/rt-client/src/commands.ts:318`).
2. Add `"workspace"` / `"tab"` to the `agentResume` WRAPPER's forwarded keys
   (`packages/rt-client/src/client.ts:364-371`). The wrapper today cherry-picks
   `id`/`prompt`/`surface` only... it does NOT forward the whole payload
   (unlike `agentStart` at `:359`, whose key list already includes
   `workspace`/`tab`). Miss this and board's `agentResume({ id, prompt,
   workspace, tab })` type-checks and then silently drops `workspace`/`tab` at
   the wrapper before the IPC call: the "types promise verbs the runtime does
   not deliver" footgun (CLAUDE.md). This edit is mandatory, not incidental.
3. The handler default change above (`lib/daemon/handlers/agent.ts:195-196`).
4. `commands/agent.ts` `resume` parsing gains `--workspace` / `--tab` for
   shell/human parity (board uses the wrapper, not the CLI, but the CLI surface
   must stay consistent).

board then maps directly: `agentResume({ id, prompt: reReviewResumePrompt(iid),
workspace: config.reviewsWorkspace, tab: mrTabLabel(iid, author, "⟲") })`.

### B. Daemon-optional herdr + read verbs

`commands/agent.ts` branches on `isDaemonRunning()` (from
`lib/daemon-client.ts`, a real `ping` probe) BEFORE dispatching. This is
precise: it never guesses "unreachable vs. command-failed" from an error
string, and it mirrors the existing precedent in `commands/port.ts` ("falls
back to direct lsof scan when daemon is not running") and `commands/sync.ts`.

```text
if (await isDaemonRunning()) {
  <today's path: rt-client wrapper -> IPC -> daemon handler>   // unchanged
} else {
  <in-process fallback below>
}
```

The fallback reuses the exact handler logic for the surfaces it supports, zero
duplication. The **headless refusal is a gate in `commands/agent.ts` BEFORE the
handler is ever constructed or called** — NOT inside the reused handler. This is
load order, and it is the subtle correctness point: the handler's
`agent:start`/`agent:resume` will happily spawn `claude -p` async and insert a
record for a headless surface, so routing headless THROUGH the reused handler
would spawn a child the exiting CLI then orphans and contradict "records
nothing". So:

```text
if (surface === "headless") fail(HEADLESS_NEEDS_DAEMON);   // in commands/agent.ts, before the handler
const db = openStateDbForFallback();                       // version-guarded, below
const handlers = createAgentHandlers({ db, emitEvent: () => {}, log });
// only herdr start/resume + get/list reach the handler:
// handlers["agent:start" | "agent:resume" | "agent:get" | "agent:list"]
```

Per verb, daemon down:

- `start` / `resume`, `surface: "herdr"` (the default): runs fully via the
  reused handler. Builds the pane command, calls `launchInWorkspace` (spawns
  the herdr CLI directly), and records to the SAME `state.db` the daemon reads
  when it returns. The record is durable and unified; `rt agent list` shows it
  later.
- `start` / `resume`, `surface: "headless"`: hard error, raised in the CLI
  before the handler (above). Message: `"headless needs the rt daemon to reap
  completion; start it (rt daemon start) or use --surface herdr"`. Nothing is
  recorded and nothing is spawned.
- `show` / `list`: run against the local db (read path) via the handler. Work
  daemon-up or daemon-down identically.

### The state.db writer / migration contract (the invariant this lane touches)

rt makes the daemon the sole `state.db` writer and the owner of migrations.
B introduces a second writer (the CLI), so it must not violate the guarantees
that convention protects. The fallback:

1. **Writes to the same `state.db` path** the daemon uses (`getStateDb`), never
   a private copy. Records unify.
2. **Goes through `runCriticalWrite`.** `agents-store` already wraps its
   inserts/updates in it, so BUSY is retried and the write is safe concurrent
   with any other writer (WAL). No new concurrency code. The
   probe-then-act race (the daemon starts between `isDaemonRunning()` and the
   fallback write) is benign for the same reason: `state.db` is a shared
   CLI+daemon store in WAL mode, both writers go through `runCriticalWrite`, and
   records land in one unified table. Worst case is a record written by the CLI
   while a just-started daemon also runs — still one durable, visible row.
3. **Never migrates a db newer than this build.** `openStateDb` runs
   `runMigrations` unconditionally, which would stamp `user_version` up to this
   binary's `SCHEMA_VERSION`. That is safe on a normal install (one binary, so
   CLI and daemon share `SCHEMA_VERSION`) but hazardous across dev lanes
   (CLAUDE.md `SCHEMA_VERSION` footgun). Guard: read `PRAGMA user_version`
   first; if it is **greater than** `SCHEMA_VERSION`, refuse the fallback with
   `"state.db is newer than this rt build; start the matching daemon"`. Equal
   or behind proceeds (migrating up is data-preserving, IF NOT EXISTS).

   Scope honestly: this guard refuses only the **db-strictly-newer** direction.
   It does NOT address the estate's equal-version-divergent-schema footgun (two
   lanes both at `vN` with different tables, first-to-stamp wins) — and it need
   not, because this lane bumps no `SCHEMA_VERSION`, so it introduces no new
   divergence, and the CLI flavor already migrates `state.db` today. Do not
   describe the guard as "closing the cross-lane footgun"; it refuses a db
   newer than this build, nothing more.

   Implementation note: `openStateDb(path, flavor)` opens AND migrates in one
   call with no pre-migrate seam, so `openStateDbForFallback()` must either
   raw-open the file → read `PRAGMA user_version` → close → (bail, or
   `openStateDb(path, "cli")`), or inline the same pragma check. The daemon
   uses flavor `"daemon"`; the fallback uses the default `"cli"` flavor, same as
   every other CLI `state.db` open today.
4. **Never starts a daemon.** The fallback is in-process work, then exit. It
   does not spawn, kickstart, or auto-start `rt daemon` (CLAUDE.md: diagnose
   live services without starting competing instances).
5. **Emits no events.** `emitEvent` is a no-op in fallback; there is no live
   bus without the daemon. Fallback-created records emit no `agent/…` event.
   Acceptable: the herdr surface has no completion event anyway, and no
   consumer subscribes to agent create events today. Documented, not silent.

### Delivery

- **A** changes the `Commands` type and the `agentResume` wrapper contract, so
  it ships in a **new rt-client version** (main-only publish, `prepack`
  rebuilds `dist`, OTP-gated by Matt, grep the built bundle for `agentStart`
  and the new resume fields before publish). Consumer version state differs:
  gitq's `^0.4.1` predates the `agent:*` wrappers entirely (they landed at
  0.6.1, #113); board's `^0.6.1` sits in the wrapper-bearing range, so board
  needs only A's new resume fields (a publish `>0.7.0`). (board's *installed*
  dist was grep-verified to lack `agentStart` today — the dist-staleness
  footgun; that is board's to resolve at its migration, not this lane.) Either
  way A's fields require a fresh publish and no consumer bump lands here.
- **B** is binary-only (lives in `commands/agent.ts` + `lib/state`), no
  rt-client change.
- **No consumer bump** in this lane. Consumers upgrade their pin only when they
  actually migrate (a separate, opt-in decision).
- After touching rt-client: `bun run build` in `packages/rt-client`
  (`dist-freshness.test.ts` guards).

## Testing

- **A**: handler unit test asserting resume uses `payload.workspace`/`tab` when
  given and the historical defaults when omitted (injectable herdr runner,
  exact arg arrays). rt-client type test that the new fields are accepted.
- **B**: `commands/agent.ts` fallback tests with `isDaemonRunning` forced false
  and an injected herdr runner:
  - herdr `start`/`resume` records to the local db and spawns the expected
    herdr args.
  - headless `start`/`resume` returns the daemon-required error, records
    nothing.
  - `show`/`list` read the local db.
  - version guard: a db stamped `> SCHEMA_VERSION` refuses with the newer-db
    message and does not write.
- **e2e** (`e2e/tests/agent.test.ts`, compiled binary under isolated
  `env -i HOME=<temp>`, fake `herdr` shim on PATH): a `start` with the daemon
  NOT running still journals the herdr argv and the record is readable via a
  subsequent `rt agent show` (also daemon-down). Preserves the existing
  hermetic shim approach; no live herdr, no API calls.

## Non-goals

- Migrating board / gitq (opt-in follow-ups; this lane makes them pure-consumer
  changes with no further rt work).
- shepherdr, ever (orchestration substrate; rt-agent-boundary invariant).
- Synchronous foreground headless in fallback (possible later; out of scope).
- A wrapper-level fallback (impossible: wrappers cannot import daemon code).
- Any schema change, new provider, liveness, or supervision (unchanged from the
  handoff spec's Non-goals).

## Appendix: adoption survey (so a future session need not re-run it)

| launcher | file | resume? | session id | headless | rt gap |
|---|---|---|---|---|---|
| gitq | `gitq/src/server/herdr.ts` | no | no | no | none for launch (fits `agent:start`); at migration time verify whether its caller consumes `focusedExisting`, which `agent:start` does not surface to the caller today |
| board | `board/src/herdr.ts` | yes, per-kind ws + `↺`/`⟲` | captured late via status-bin `CLAUDE_CODE_SESSION_ID` | no | A (resume workspace/tab) |
| shepherdr | skill package | own substrate | own `herd.db` | yes, at scale | out of scope (boundary) |

board's session-id capture simplifies on migration: rt mints the uuid up front,
so `agentStart` returns it synchronously and board's existing `sessionId?`
state field is populated at launch (closing the current "no session id on file
yet" window at `server.ts:759`). Resume accepts a session-uuid, so no
state-schema change. The status-bin `--session` write becomes redundant but
harmless; removing it is a deferred board-side cleanup, not part of any rt lane.
board's `config.claudeCommand` retires in favor of `agent.model`/`agent.effort`/
`agent.account` as part of the board migration, not this lane.
