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
| `rt events wait <topic-pattern> [--after <cursor>] [--timeout <dur>]` | blocking subscribe | `{ok, events: [...], cursor}` or `{ok, timedOut: true, cursor}` |
| `rt events tail <topic-pattern> [--after <cursor>]` | follow-mode NDJSON stream | one event per line |
| `rt events list <topic-pattern> [--after <cursor>] [--limit <n>]` | non-blocking journal read | `{ok, events: [...], cursor}` |

Semantics:

- Payload is optional JSON. Convention for shepherdr: files stay the payload
  store, events carry pointers.
- `wait` with no `--after` means "only events emitted from now on."
- **Every response carries a cursor, including empty ones.** The daemon
  snapshots the max rowid at waiter registration; a wait that expires empty
  still returns that cursor, and the CLI threads it into every re-poll. The
  CLI-level `{timedOut: true}` result includes the final cursor too. This is
  the mechanism that makes the poll loop race-free — without it, a no-
  `--after` loop would lose events emitted between polls.
- `--timeout` takes a duration with suffix (`30s`, `5m`); a bare number is
  seconds. Default is no timeout (wait forever). Timeout exits with code
  **124** (GNU-timeout convention) and `{ok: true, timedOut: true, cursor}`
  so skills can branch without parsing errors.
- **One glob matcher everywhere: `Bun.Glob`.** `*` does not cross `/`;
  `**` matches across segments; a bare topic matches itself. `wait` and
  `list` share a single JS match function — `list` fetches `id > ?` from
  SQLite and filters in JS (fine at the 50k cap, and it keeps the
  `(topic, id)` index honest: the index serves exact-topic queries only).
  Never use SQLite's `GLOB` operator, whose `*` crosses slashes and would
  make `wait` and `list` match different event sets.
- `wait` may return multiple events (everything after the cursor at wake
  time); the returned `cursor` is the id of the last event delivered.
- `tail` is pure client-side composition: an `events:list` catch-up
  followed by the same poll loop as `rt events wait`, printing one JSON
  line per event. No new daemon verb, no server-side streaming.

## Daemon architecture

**`lib/daemon/events-bus.ts`** — the bus unit. Owns:

- SQLite handle for `~/.rt/events.db` (WAL mode). Schema:
  `events(id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL,
  payload TEXT, emittedAt INTEGER NOT NULL)` with an index on `(topic, id)`.
- The waiter registry: a set of `{pattern, afterId, resolve}` entries. An
  insert resolves every matching waiter. Promise plumbing only — **no
  sync-exec on the daemon thread** (MAT-222 lesson). Four properties are
  load-bearing:
  - **Atomic check-then-register.** The catch-up journal query and the
    waiter registration happen in one synchronous segment — no `await`
    between them. Bun's single-threaded loop plus `bun:sqlite`'s
    synchronous API make this atomicity free; an `await` in the middle
    opens a missed-insert window.
  - **Connection-lifetime cleanup via AbortSignal.** The seam is widened to
    `handleCommand(cmd, payload, signal?)`; both servers source the signal
    from `req.signal` and `events:wait` removes its waiter on abort. The
    daemon-enforced wait cap (below) is the backstop for signals that never
    fire, so a dead client's waiter lingers at most one cap interval.
  - **Daemon-enforced wait cap.** The per-request wait duration is clamped
    daemon-side to 240s (under the 255s socket idle timeout) regardless of
    what the client asks for — a client-supplied cap must not be able to
    outlive its own connection.
  - **Ahead-cursor clamp.** If `after > max(id)` (a persisted cursor from a
    prior db generation — deleted/recreated `~/.rt/events.db`), the daemon
    clamps it down to `max(id)`. Ids only grow within one generation, so an
    ahead cursor can only mean a stale generation; clamping degrades to
    "from now on" instead of a permanent-looking hang. Cursors pointing
    into retention-deleted ranges silently skip, which is correct.
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
  daemon-side waits (clamped daemon-side to 240s, see above), re-issuing
  with the cursor from each response — including empty cap-expiry
  responses — until an event arrives or the user's `--timeout` elapses.
- **Cap expiry is a normal response, not an error:** the daemon returns
  `{ok: true, events: [], cursor}`. `timedOut` exists only at the CLI
  level. (This also keeps `handleCommand`'s `ok === false` warn-log path
  quiet on every idle poll.)
- Enabling fixes to the seam: `lib/daemon/socket-server.ts` sets
  `idleTimeout: 255` (Bun's max; today's implicit 10s default would reap
  any held request), and `handleCommand` in `lib/daemon.ts` grows the
  optional third `signal` parameter, threaded from `req.signal` in both
  servers.
- The CLI's poll calls must pass a per-call client timeout comfortably
  above the 240s daemon cap (not `daemonQuery`'s 2s default), and must
  branch the optional-backend fallback on an explicit refusal/absence
  signal — distinguishing "no events yet" (normal empty response) from
  "daemon down" (`null` from `daemonQuery`, which also triggers the
  existing restart path and serves the restart-mid-wait resume story).
- REST: `POST /api/events/emit` is a mutating route behind the existing
  `X-RT-Token`; `GET /api/events` maps to `events:list`, with the handler
  coercing `after`/`limit` from the string values that
  `Object.fromEntries(url.searchParams)` produces. Everything stays
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
