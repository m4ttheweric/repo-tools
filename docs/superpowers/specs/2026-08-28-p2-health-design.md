# Daemon health you can see (Phase 2 / RT-79)

Design record for Phase 2 of the rt daemon stability roadmap. Makes a
non-author user able to tell, from `rt daemon status`, the tray dot, and
`/api/status`, whether the daemon is serving, degraded, stalled, or dead, and
why. Builds on Phase 0 (the status classifier in `lib/daemon-status.ts`, the
`daemon-supervision` kv namespace, the pre-db breadcrumb file). Covers audit
findings R011, R012, R003, R004, S031, S032, S033, R005, R008, R021.

## Health model

A single server-computed verdict every surface reads, replacing three
independent client-side classifications (CLI, Swift tray, none in `/api/status`).

`lib/daemon/health.ts` exports a pure `computeHealth(inputs): HealthSnapshot`:

```
HealthSnapshot = {
  level: "ok" | "degraded" | "unhealthy",
  reasons: string[],              // one subsystem-prefixed line per trigger
  metrics: { rss, heapUsed, external, uptimeMs, wsClients, watchers },
                                        // watchers = fs.watch handle count (watchedConfigs.size)
  eventLoop: { maxLagMs, lastStallAt, lastStallCmd, stalls },
}
```

Level is severity-ordered; unhealthy wins over degraded.

- **unhealthy** if any: logger degraded (ENOSPC, from S032); event loop currently
  stalled (heartbeat/monitor); restart storm (Phase 0 `isCrashLooping`, or >= N
  supervision failures in the last hour); disk free under a hard floor.
- **degraded** if any: a freshness watcher is `degraded`
  (`getFreshnessSnapshot()`); the last refresh cycle had `failedRepos > 0` or
  `enrichErrors > 0`; last successful refresh age > 2x the refresh interval; rss
  over a soft threshold or grown > 50% in the last hour; event-loop `maxLagMs`
  over the lag threshold within the window; recovered-error rate over a small
  threshold in the window; disk free under a soft floor.
- **ok** otherwise.

`reasons` name the failing subsystem so the operator knows where to look, e.g.
`"refresh: 3 repos failing (auth?)"`, `"event-loop: stalled 8s"`,
`"logging: disabled (ENOSPC)"`, `"disk: 180MB free"` (R011). `metrics` gives the
memory/handle/uptime numbers a leak hunt needs (R012).

A daemon-side adapter (`buildHealthSnapshot(ctx)`) gathers the inputs from `ctx`,
the loop monitor, the logger handle, Phase 0 supervision, and an optional
`fs.statfs` probe, then calls the pure function. Inputs that need new tracking:
`refreshStatusRef` grows from `{ lastRefreshAt }` to also carry the last cycle's
`{ lastSuccessAt, failedRepos, enrichErrors }` (populated in `cache-refresh.ts`);
`wsClients.size` is exposed from `api-server.ts` to the adapter. **Deferred behind
a typed hook** (V1 does not wire them): SQLITE_BUSY-skip and critical-write-failure
counters. `HealthInputs` declares the fields so they slot in later without a shape
change.

### Where each surface reads it

- `status` and `tray:status` verbs (`lib/daemon/handlers/status.ts`) gain
  additive `health`, `metrics`, `eventLoop` blocks. `/api/status` aliases
  `tray:status`, so it carries the verdict.
- `ping` gains `health.level`, `version` (`ctx.identity.version`), and the
  heartbeat `seq` (all cheap).
- `rt daemon status` (`commands/daemon.ts` `statusLines`) renders `level` +
  `reasons` and metrics/eventLoop lines on the running branch; on the
  alive-but-not-serving branch it prints `maxLag` / last stall instead of today's
  "likely mid-sync" guess (R003).
- **Swift tray is deferred** (brief constraint): no `rt-tray/` edits. Documented
  contract for the follow-up: read `data.health.level` -> green/orange/red and
  `data.health.reasons[0]` as `statusText`; the current client derivation
  (pendingNotifications + two-miss) becomes the fallback when `health` is absent.

## Heartbeat and stall detection (R003)

`lib/daemon/loop-monitor.ts`: a ~250ms `setInterval` measuring drift
(`actualElapsed - expected`) into a preallocated `LoopStats` object. The tick is
allocation-free (no per-tick closures/objects) and the timer is `unref()`'d so it
never keeps the process alive. It maintains `{ lagMs, maxLagMs, stalls,
lastStallAt, lastStallCmd }`; on drift > 1s it increments `stalls`, records
`lastStallCmd` (a module `currentCmd` set by `handleCommand`), and logs one warn.

**Heartbeat is a file, not kv** (ratified): every ~2s the monitor writes
`{ at, seq }` (seq monotonic) to `RT_DIR/daemon-heartbeat.json` via atomic rename
(write temp + `renameSync`), the same db-free pattern as Phase 0's breadcrumb.
Rationale: state.db is the WAL every CLI contends on, and a stalled or
lock-wedged daemon is exactly when it is least readable. `lib/daemon/heartbeat-file.ts`
owns `writeHeartbeat`/`readHeartbeat` (missing/corrupt -> null).

Cross-process detection extends `lib/daemon-status.ts`: `classifyDaemonStatus`
takes an optional `heartbeat: { at, seq } | null` plus a stale threshold. In the
alive-not-serving branch, when `breadcrumb.phase === "ready"` and
`now - heartbeat.at` exceeds the threshold, the detail becomes a new `"stalled"`
(with age) instead of `"wedged"`. The `alive-not-serving` detail union grows to
`"booting" | "wedged" | "quarantined" | "stalled"`. `commands/daemon.ts` reads the
heartbeat file only when the pid probe is already needed (`needsPidProbe`), and
`statusLines` prints "event loop stalled Ns ago".

## Log level and growth policy

- **rt.logLevel** (R004): new registry row, `type: "string"`,
  `scopes: ["machine", "user"]`, `default: "info"`, `merge: "replace"`, following
  `docs/settings-architecture.md`'s checklist exactly as `rt.apiPort` did (add the
  row, `cd packages/rt-client && bun run build` so the dist-freshness test stays
  green). `getDaemonLogger` resolves `level = RT_LOG_LEVEL env ?? getSetting("rt.logLevel") ?? "info"`
  (env wins, mirroring `resolveApiPort`).
- **Live control** (R004): a `daemon:log-level` IPC verb sets `logger.level`
  at runtime and logs the change; `rt daemon log-level <level>` dispatches it. The
  new command registers in `command-tree-def.ts` and `lib/module-registry.ts`, and
  its required positional `level` (a select over pino levels) declares
  `omitBehavior: "picker"` so `bun run picker:check` stays green.
- **Slow-command visibility** (R004): `handleCommand` logs successful commands at
  `info` when `durationMs > 2s` (else `debug`, as today), so latency outliers are
  visible at the default level.
- **Growth cap** (S031): pino-roll gets `size: "50m"` beside `limit: { count: 14 }`
  (bounds within-day growth independent of the daily/age sweep). Per-(cmd,error)
  suppression in `handleCommand`: a Map keyed `${cmd}|${errorKey}` tracking
  `{ count, lastLoggedAt }`. **Guardrail:** always log the first occurrence
  immediately; within 60s of the last logged line, increment silently; at >= 60s
  emit one line carrying `suppressed: <count>` and reset. `pruneLogs` takes an
  `onError` callback so the janitor's readdir/unlink failures log at warn instead
  of being swallowed.

## Logger resilience and stderr noise

- **Stream error listener** (S032): `createDaemonLogger` adds
  `stream.on("error", ...)` that sets a `loggerDegraded` flag and does a raw
  `fs.writeSync(2, ...)`, so a full-disk write never throws out of a log call. The
  handle exposes `loggerDegraded` (feeds health -> unhealthy). The
  `uncaughtException` / `unhandledRejection` handler bodies are wrapped in
  try/catch with a raw-write fallback that still calls `process.exit(1)` (Phase 0's
  boot-vs-steady-state semantics preserved).
- **stderr demotion** (S033, R005): the stderr interceptor logs at `warn` with
  `source: "stderr"`, escalating to `error` only for known panic/exception
  prefixes. `unhandledRejection` and recovered errors increment a process-wide
  counter exposed in `health`/`metrics`.
- **Resolver warn sink** (S033): `packages/rt-client`'s resolver
  (`resolve.ts` `warnInvalid` and siblings) takes an injectable warn sink
  defaulting to `console.warn` (CLI/test behavior unchanged). The daemon binds a
  sink that dedupes per `(key, scope, reason)` to `log.warn`, so a hot-path
  `getSetting` on a disallowed-scope key warns once, not every tick.

## Request attribution

- **reqId + caller** (R008): `handleCommand` mints a short request id per request
  and logs `{ reqId, cmd, caller, durationMs }` on every seam line; `ok:false`
  envelopes echo `reqId`. Caller comes from an `X-RT-Client` header (REST) or a
  `_client` field on the socket frame, formatted `<client>/<pid>` (default
  `unknown`). On reject/fail, log a redacted payload digest: top-level keys plus
  the whitelisted `repo`/`branch`/`iid`/`room` when present. rt's own transport
  (`lib/daemon-client.ts`) and `packages/rt-client`'s transport both send the tag.
- **Unknown-command envelope** (R021): the `routeCommand` default returns
  `{ ok: false, code: "unknown-command", error, version }`. Both transports map
  `code === "unknown-command"` to distinct text ("daemon at version X does not know
  <cmd>; restart or upgrade rt"). `ping` optionally exposes the command-name list
  for pre-checks.

**rt-client blast radius:** the `packages/rt-client` edits (registry row, warn
sink, caller tag, unknown-command text) ship as source + a `dist` rebuild; the
version is **not** bumped and the package is **not** published (publishing is
release-class, from `main` only). The estate-wide rollout to board/gitq/console
rides the next release from `main`.

## Constraints and invariants

- No `SCHEMA_VERSION` bump. The only new persisted state is the heartbeat file
  (`RT_DIR/daemon-heartbeat.json`); everything else is computed live or reuses the
  Phase 0 `daemon-supervision` kv namespace.
- `rt.logLevel` goes through the settings registry per the checklist; rebuild
  rt-client `dist`; no version bump, no publish.
- No `rt-tray/` edits; the tray read contract above is a documented follow-up.
- Never start a daemon or run `dist/rt` except under `env -i HOME=<temp dir>`.
- Do not touch the p6-portability-owned files, nor the module-scope
  `resolveUserPath()` call in `lib/daemon.ts` (p6 makes it awaited-async).

## Components

**New:** `lib/daemon/health.ts` (pure `computeHealth` + `HealthInputs`),
`lib/daemon/loop-monitor.ts`, `lib/daemon/heartbeat-file.ts`, the
`buildHealthSnapshot` adapter, the `rt daemon log-level` command handler.

**Changed:** `lib/daemon.ts` (handleCommand reqId/caller/suppression/currentCmd,
loop-monitor + metrics-logger wiring), `lib/daemon/handlers/status.ts`
(health/metrics/eventLoop in status + tray:status + ping; unknown-command code),
`lib/daemon/handlers/types.ts` (extend `refreshStatusRef`, expose health inputs),
`lib/daemon/cache-refresh.ts` (populate the extended ref),
`lib/daemon/api-server.ts` (read `X-RT-Client`, expose `wsClients`),
`lib/daemon-logger.ts` (level from setting, stream error listener, stderr
demotion, crash-handler wrap, size cap, `loggerDegraded`), `lib/daemon-status.ts`
(heartbeat input + `stalled` detail), `commands/daemon.ts` (render health + read
heartbeat), `lib/log-janitor.ts` (`onError`), `lib/daemon-client.ts` (send caller
tag, surface unknown-command), `packages/rt-client` (registry row, warn sink,
transport caller tag + unknown-command text), `lib/command-tree-def.ts` +
`lib/module-registry.ts` (log-level command).

## Testing

- `health.ts`: each level transition and reason string (pure, table-driven).
- `loop-monitor.ts`: drift math with injected clock; unref'd; no per-tick
  allocation.
- `heartbeat-file.ts`: write/read round trip via atomic rename; missing/corrupt
  -> null.
- `daemon-status.ts`: `stalled` detail when heartbeat is stale + pid alive + boot
  reached ready; every existing verdict unchanged.
- `daemon-logger.ts`: stream error -> `info()` does not throw and `loggerDegraded`
  set; crash handler still exits under a throwing logger; a non-panic stderr line
  logs at warn not error; the size cap option is present.
- `handleCommand`: reqId minted and echoed in `ok:false`; caller logged; a burst
  of identical `ok:false` produces a bounded number of lines with a suppressed
  count.
- unknown-command envelope carries `code` + `version`; transport surfaces the
  distinct text.
- resolver warn sink dedupes once per `(key, scope, reason)`.
- settings: `rt.logLevel` row + settings-paths parity + dist freshness.
- E2E `e2e/tests/daemon.test.ts`: status/tray:status/ping additive fields;
  `/api/status` shape stays additive.
