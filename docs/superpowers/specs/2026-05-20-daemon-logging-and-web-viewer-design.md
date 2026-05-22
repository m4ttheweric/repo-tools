# Daemon Logging + Web Viewer — Design

**Date:** 2026-05-20
**Status:** Approved

## Problem

The rt daemon's logging is handrolled (`lib/daemon.ts:292` — a `log(msg: string)` that `appendFileSync`s a `[ts] msg` line). Three concrete failure modes:

1. **No crash capture.** `process.on('uncaughtException')` and `process.on('unhandledRejection')` are not installed. Async throws kill the daemon silently. launchd restarts via `KeepAlive`, leaving no forensic trail.
2. **Stderr is /dev/null.** The plist comment claims "the daemon redirects its own output," but the code never does. `DAEMON_STDERR_LOG_PATH` is declared in `lib/daemon-config.ts` and never written to. Bun runtime panics / native errors land nowhere.
3. **~100 silent `catch { /* */ }` blocks** across `lib/daemon.ts` and `lib/daemon/*.ts` swallow errors with no record. Intermittent failures (e.g. in `auto-fix`, `tunnel-manager`) are effectively invisible.

The user-facing pain is intermittent daemon-unresponsive episodes that can't be diagnosed because nothing's logged.

## Goal

Replace the handrolled logger with `pino`, install crash/rejection handlers, route JS-side stderr through the logger, audit silent catches in the four high-suspicion subsystems, and ship a browser-based log viewer via `logdy` as a brew dependency.

Non-goals: external log shipping (Sentry/Datadog), full sweep of silent catches in every module, log compression, native-stderr capture (deferred to a separate swift-shim PR).

## Architecture

```
                                    pino                       pino-roll
                            ┌──────────────────┐       ┌──────────────────────────┐
  daemon code  ────────▶    │ root logger      │ ────▶ │ ~/.rt/logs/              │
  logger.info({...})        │ + child(module)  │       │   daemon.log.YYYY-MM-DD  │
                            └────────▲─────────┘       │   (JSON, keep 14 days)   │
                                     │                 └────────────┬─────────────┘
   process.stderr.write   ───────────┘ (routed through                │
   console.error                       logger.error)                logdy follow
                                                                       │
                                                              rt logs (browser)
                                                              rt daemon logs --terminal
```

## Components

### `lib/daemon-logger.ts` — new module

Single configured pino root, exported as `logger`, plus a `childLogger(module: string)` helper.

- Destination: `pino-roll` with `file: ~/.rt/logs/daemon.log`, `frequency: 'daily'`, `limit: { count: 14 }`, `mkdir: true`. Files become `daemon.log.2026-05-20`, etc.
- Level: `process.env.RT_LOG_LEVEL ?? 'info'`
- Serializers: `pino.stdSerializers.err` for the `err` field — captures full stack trace
- Base fields: `{ pid, hostname }` (pino defaults)
- Crash-safety: `pino.final()` wrapper makes `logger.fatal(...)` synchronously flush before exit
- Child loggers stamp `{ module: "auto-fix" }` etc. so logdy / `jq` filters work cleanly

### Crash + stderr capture (in `lib/daemon.ts` startup, before any other init)

```ts
// Capture uncaught throws. pino.final() ensures synchronous flush before exit.
process.on("uncaughtException", pino.final(logger, (err, finalLogger) => {
  finalLogger.fatal({ err }, "uncaughtException");
  process.exit(1);
}));

// Promise rejections — log but don't exit (matches Node default behavior under
// node-deprecation; lets the daemon recover from stray rejections)
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandledRejection");
});

// Route JS-side stderr writes through pino so console.error and any code that
// writes to process.stderr lands in the JSON log instead of disappearing.
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: any) => {
  const text = typeof chunk === "string" ? chunk : chunk.toString();
  logger.error({ source: "stderr" }, text.trimEnd());
  return true;
}) as typeof process.stderr.write;
```

**Native bun panics (e.g. segfaults, runtime asserts) bypass the JS layer and would still vanish under launchd.** Capturing those requires fd-level `dup2` of fd 2 to a file — which Bun does not expose. The proper place to do this is in `rt-tray/Sources-daemon-shim/main.swift` (the Swift exec-proxy that launches bun), using `freopen("daemon-stderr.log", "a", stderr)` before `execv`. **That change is out of scope for this PR** — JS-side coverage above handles >99% of real-world cases. The shim update is tracked as a follow-up.

### Call-site migration

- `lib/daemon.ts`: 41 `log("...")` callsites convert to `logger.info/warn/error(...)`. Levels assigned per call by semantics:
  - `info` — lifecycle ("daemon starting/stopped/ready"), normal scans, cache refreshes
  - `warn` — recoverable failures ("GitLab MR fetch failed", "parking-lot: check failed")
  - `error` — anything in a catch that previously logged via `log()` with an error context
- Each submodule that today receives a `log` callback in its constructor switches to importing `childLogger("<module>")` directly.
- **Targeted silent-catch audit** on four modules where intermittent crashes are most likely:
  - `lib/daemon/auto-fix.ts`
  - `lib/daemon/tunnel-manager.ts`
  - `lib/daemon/parking-lot.ts`
  - `lib/daemon/process-manager.ts`

  Each `catch { /* */ }` in those files gets reviewed:
  - Genuinely-ignorable (e.g. "socket may already be closed") → `log.debug({ err }, "expected: socket closed")`
  - Unexpected → `log.warn({ err }, "what failed")`
  - Already had a comment naming the cause → that comment becomes the log message

### `rt daemon logs` UX (`commands/daemon.ts`, `showLogs`)

- `rt daemon logs` (default, web mode):
  1. Verify `logdy` is on PATH. If missing, print install hint and exit non-zero.
  2. Resolve today's log path: `~/.rt/logs/daemon.log.${YYYY-MM-DD}` (pino-roll's filename pattern). If today's file doesn't yet exist (daemon just started, no rotation tick yet), fall back to the most recent `daemon.log.*` by mtime.
  3. Spawn `logdy follow <path> --port 5544`. logdy serves a web UI at the chosen port; does NOT auto-open a browser.
  4. After a brief readiness check (poll `http://localhost:5544/` for ≤2s), `open http://localhost:5544` (macOS `open`).
  5. Print "rt logs viewer running on http://localhost:5544 — Ctrl-C to stop" and stay attached to logdy's stdout so the user can Ctrl-C to terminate.
- `rt daemon logs --terminal` / `-t` → `tail -F ~/.rt/logs/daemon.log.* | bunx pino-pretty` (pipe; pino-pretty reads stdin by default).
- `logdy` missing on PATH → print: `for the web viewer, run: brew install logdy-network/logdy/logdy`. `--terminal` works without logdy.
- Historical rotated files (`daemon.log.YYYY-MM-DD`) accessible via `tail -F` glob in `--terminal` mode; web mode tails only the current day. Cross-day browsing is out of scope (use `lnav ~/.rt/logs/`).

Port `5544` is hardcoded; if collisions become an issue we add `--port` later.

### File layout change

Old: `~/.rt/daemon.log` (flat), `~/.rt/daemon-stderr.log` (declared, unused).
New: directory `~/.rt/logs/`:
- `daemon.log.2026-05-20`, `daemon.log.2026-05-19`, ... (pino-roll's default naming: `<basename>.<date>`. Today's file is the one with today's date.)
- 14 most-recent kept; older auto-deleted by pino-roll's `limit: { count: 14 }`.

(Native-stderr capture is deferred to the swift-shim follow-up noted above. `~/.rt/logs/daemon-stderr.log` is not created by this PR.)

One-shot cutover: no migration of the old `~/.rt/daemon.log`. It stays in place; subsequent code only writes to the new location. `rt daemon logs` reads only the new location.

### Brew formula

Add `depends_on "logdy-network/logdy/logdy"` to the rt-tools brew formula (lives in the user's homebrew tap repo, outside this repo). Spec notes the change; the user handles the release-side merge.

## Testing

- **Unit (`lib/__tests__/daemon-logger.test.ts`):**
  - `logger.info("msg")` writes a JSON line with `level: 30, msg: "msg"`
  - `childLogger("foo").info("msg")` adds `module: "foo"`
  - `logger.error({ err: new Error("x") })` serializes `err.stack`
  - `RT_LOG_LEVEL=warn` filters out info-level calls

- **Integration:**
  - Spawn daemon under launchd (existing dev-mode shim path), kickstart it, assert the rotated file `~/.rt/logs/daemon.log.<today>` contains `{"level":30,...,"msg":"daemon stopped"}`
  - Throw from a `setTimeout` inside a test harness wrapping the logger setup; assert a `level: 60` fatal line lands AND was flushed before exit code 1

- **Manual:**
  - Verify `rt daemon logs` opens browser with logdy showing live tail
  - Verify `rt daemon logs --terminal` shows pretty terminal output via pino-pretty

## Files touched

| File | Change |
|---|---|
| `lib/daemon-logger.ts` | **New** — pino root, childLogger helper, final-wrapped crash handler factory |
| `lib/__tests__/daemon-logger.test.ts` | **New** — unit tests above |
| `lib/daemon-config.ts` | `LOG_DIR = ~/.rt/logs/`, `DAEMON_LOG_PATH = ~/.rt/logs/daemon.log` (pino-roll's basename — rotated files become `daemon.log.YYYY-MM-DD`). Remove unused `DAEMON_STDERR_LOG_PATH`. |
| `lib/daemon.ts` | Remove handrolled `log()`; import `logger`; install `uncaughtException` + `unhandledRejection` handlers; intercept `process.stderr.write` through logger; migrate 41 callsites |
| `lib/daemon/auto-fix.ts` | `childLogger("auto-fix")`; audit silent catches |
| `lib/daemon/tunnel-manager.ts` | `childLogger("tunnel")`; audit silent catches |
| `lib/daemon/parking-lot.ts` | `childLogger("parking-lot")`; audit silent catches |
| `lib/daemon/process-manager.ts` | `childLogger("process-manager")`; audit silent catches |
| `lib/daemon/*` (other submodules with `log` callback param) | Drop the param; use `childLogger("<module>")` directly |
| `commands/daemon.ts` | `showLogs` rewritten: `--web` (default), `--terminal`/`-t` mode; logdy detection + brew hint |
| `cli.ts` | Add `--terminal`/`-t` flag handling for `logs` subcommand |
| `package.json` | Add `pino`, `pino-roll`, `pino-pretty` deps |

## Out of scope

- Silent-catch audit outside the four targeted modules (`lib/daemon.ts` itself's catches, `proxy-manager.ts`, `workspace-sync.ts`, `mr-subscriptions.ts`, `remedy-engine.ts`, `state-store.ts`, etc.) — follow-up work, conventions established by this PR
- External log shipping (Sentry, Datadog, OpenTelemetry)
- Compression of rotated daily files (14 × ~3 MB ≈ 40 MB, fine uncompressed)
- Backward compatibility with the old `~/.rt/daemon.log` flat path
- A native in-daemon web log viewer (we use logdy, off the shelf, per "don't invent")
- Multi-machine log aggregation
