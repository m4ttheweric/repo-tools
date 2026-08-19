# rt events — optional event-driven pane-communication backend

**Ticket:** RT-44
**Date:** 2026-08-18
**Status:** Approved design, pre-implementation

## Problem

Pane-to-orchestrator communication today is polling and files: shepherdr
watches workers with `herdr agent wait` (which fires spuriously on transient
settles whenever a worker's own subagents make the pane look idle) and
exchanges question/report contract files through `~/.shepherdr/jobs/`. There
is no push channel: a shepherd cannot be told "worker X published a milestone"
without a flappy wait firing or a file poll.

rt's daemon becomes an **optional** event bus for panes: any process can
publish an event over the existing IPC seam, and any process can hold a
blocking, replayable subscription. Herdr pane waits and file contracts remain
the fallback — herdr is not an rt dependency and vice versa.

## Decisions and rationale

- **Journaled retention on SQLite (`bun:sqlite`), not ephemeral pub/sub.**
  A consumer that is between polls or relaunched after a crash must see what
  it missed; a wake-then-miss race would reintroduce exactly the flappiness
  this replaces. `bun:sqlite` is bundled into the compiled binary (no
  module-registry or native-module risk) and gives crash-safety, concurrent
  readers, and cursor queries for free. Surveyed alternatives (Aedes/MQTT,
  ZeroMQ, BullMQ, event-sourcing frameworks) are servers, in-process-only, or
  the wrong replay model; "SQLite as a message log" is the well-trodden
  pattern, implemented directly.
- **Global topic namespace with slash conventions.** Topics like
  `job/<name>/question` are just strings; the daemon never interprets topic
  meaning. Scoping (per-herd, per-repo) is a naming convention owned by the
  producer. Consumers match with globs (`job/myherd/*`).
- **Caller-held cursors, no consumer registry.** Every event gets a monotonic
  id (the SQLite rowid). Consumers thread `--after <cursor>` through their
  loop and persist it wherever they already keep state (e.g. the shepherdr
  job dir). The daemon stays stateless about consumers — nothing to name,
  lease, expire, or GC — and rt stays out of the business of knowing
  orchestration participants. Daemon-stored offsets can be added later if
  threading cursors proves annoying; the reverse migration would be uglier.

## Command surface

Four verbs under `rt events`, all plain English, all JSON out:

| Verb | Shape | Returns |
|---|---|---|
| `rt events emit <topic> [--json '{...}']` | fire-and-forget publish | `{ok, id}` |
| `rt events wait <topic-pattern> [--after <cursor>] [--timeout <dur>]` | blocking subscribe | `{ok, events: [...], cursor}` or `{ok, timedOut: true}` |
| `rt events tail <topic-pattern> [--after <cursor>]` | follow-mode NDJSON stream | one event per line |
| `rt events list <topic-pattern> [--after <cursor>] [--limit <n>]` | non-blocking journal read | `{ok, events: [...], cursor}` |

Semantics:

- Payload is optional JSON. Convention for shepherdr: files stay the payload
  store, events carry pointers.
- `wait` with no `--after` means "only events emitted from now on."
- `wait` timeout exits with a distinct non-zero exit code and
  `{timedOut: true}` so skills can branch without parsing errors.
- Patterns are glob-on-slashes; a bare topic matches itself.
- `wait` may return multiple events (everything after the cursor at wake
  time); the returned `cursor` is the id of the last event delivered.

## Daemon architecture

**`lib/daemon/events-bus.ts`** — the bus unit. Owns:

- SQLite handle for `~/.rt/events.db` (WAL mode). Schema:
  `events(id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL,
  payload TEXT, emittedAt INTEGER NOT NULL)` with an index on `(topic, id)`.
- The waiter registry: a set of `{pattern, afterId, resolve}` entries. An
  insert resolves every matching waiter. Everything is async promise
  plumbing — **no sync-exec on the daemon thread** (MAT-222 lesson), and
  waiters are removed when their request dies (timeout or connection close),
  so entries cannot leak across connection lifetimes.
- Retention: a periodic sweep riding the existing pollers deletes rows older
  than 7 days, keeping at least the newest 50k regardless of age.

**`lib/daemon/handlers/events.ts`** — thin typed handlers (`events:emit`,
`events:wait`, `events:list`) delegating to the bus. Commands are cataloged
in `packages/rt-client/src/commands.ts` so payload/response drift is a tsc
error (MAT-31 pattern).

**Broadcast integration:** every emit also flows through the daemon's
`emit()` broadcast as an `event` frame — WS clients (tray, dashboards) and
the cron trigger layer see pane events with zero extra wiring.

**Logging:** the seams already log outcomes; the bus logs domain events at
`debug` only (waiter woken, retention sweep).

## Transport

- `wait` is a **long-poll loop**, not one held connection: the CLI issues
  daemon-side waits capped at ~4 minutes, re-issuing with the same cursor
  until an event arrives or the user's `--timeout` elapses. Cursors make
  re-polls idempotent, so the loop is race-free.
- Enabling fix: `lib/daemon/socket-server.ts` sets `idleTimeout: 255`
  (Bun's max). Today's implicit 10s default would reap any held request.
- REST: `POST /api/events/emit` is a mutating route behind the existing
  `X-RT-Token`; `GET /api/events` maps to `events:list`. Everything stays
  loopback/same-user only. The unix socket is the primary transport.

## Consumer picture (out of scope for rt, recorded for context)

Shepherdr workers emit `job/<name>/question` and `job/<name>/report`; the
shepherd holds one `rt events wait 'job/<name>/*'` per herd instead of N
flappy pane waits, persisting its cursor in the job dir. That adoption is a
follow-up change in the shepherdr skill, and it must degrade gracefully to
herdr waits + file polls when the rt daemon is absent. ci-attendant leases
and mr-board peer signals are potential future riders; nothing in this
design special-cases them.

## Non-goals

- No consumer registry, groups, leases, or acks.
- No delivery guarantees beyond the journal + cursor replay.
- No orchestration logic in rt; skills own workflow.
- No network exposure beyond loopback.

## Error handling

- Daemon down: verbs fail fast with a clear "daemon not running" error;
  callers treat the bus as absent and fall back (optional backend).
- Daemon restart mid-wait: the CLI's poll loop reconnects and resumes from
  its cursor; the journal survives restarts.
- Malformed `--json`: rejected client-side before any IPC.
- Unmatched pattern forever: that's what `--timeout` is for.

## Testing

- **Unit** (`lib/daemon/events-bus.test.ts`): wildcard matching, cursor
  semantics (`--after` boundaries, multi-event delivery), waiter wake and
  cleanup, retention sweep, WAL db creation.
- **E2E**: emit → blocked wait → wake across two real processes — this is
  RT-44's spike, kept as the permanent proof rather than thrown away. Plus
  timeout behavior and daemon-restart-mid-wait resume. HOME isolation via
  the existing bunfig preload.

## Footguns pre-checked

- New CLI module registered in `lib/module-registry.ts` (compiled-binary
  dynamic-import footgun).
- Daemon restart required before new handlers exist (dev-mode swap note).
- `idleTimeout` change on the unix socket server is deliberate and shared
  with all IPC traffic; it raises a cap, never holds connections open.
