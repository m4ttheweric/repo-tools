# rt — repo tools

Personal developer CLI built with Bun. Compiled to a standalone binary via `bun build --compile` and distributed as a GitHub Release tarball that mattstack.app (and `rt --post-install`) installs.

## Architecture docs live in Linear, not this repo

rt is one piece of a plan spanning five repos, so the governing design docs are
not in any single repo. Before proposing anything about rt's scope, mr-board,
glance, gitq, or the acme skills, read `docs/architecture.md` for the links.

## Logging architecture

Logging is structural, not per-feature. Outcomes are logged at central seams; feature code only logs domain events. When adding a feature, you almost never need to add logging — check this list before writing any.

**The seams (do not log outcomes yourself):**

- **CLI commands** — `dispatch()` in `lib/command-tree.ts` logs every command's outcome, and `installCliLogging()` (wired in `cli.ts`) covers every `process.exit()` path and persists crash stacks. A new command gets usage + error + crash logging with zero code.
- **Daemon commands** — every IPC/REST command funnels through `handleCommand` in `lib/daemon.ts`, which logs ok/rejected/threw with duration. A new handler in `lib/daemon/handlers/` inherits this; do not log request/response or wrap handlers in logging try/catches.
- **Daemon crashes** — `installCrashHandlers` + `redirectNativeStderr` (`lib/daemon-logger.ts`) capture uncaught exceptions, rejections, JS stderr, and native bun panics.
- **Tray** — `TrayLog` (`rt-tray/Sources/TrayLog.swift`) is the only logging API (never bare `NSLog`); spawn subprocesses via `TrayLog.runLogged`/`spawnLoggedDetached`; `TrayServer.sendResponse` logs all non-2xx replies.

**The file convention:** every surface appends JSON lines to `~/.rt/logs/<surface>.YYYY-MM-DD[.N].log` (daemon, cli, tray today). `rt daemon logs` auto-discovers surfaces by that pattern — a new surface that follows it appears in the viewer with no registration.

**What feature code SHOULD log:** domain events only — things invisible at the seams (a sync fast-forwarded, a watcher rewired). Daemon modules use `(await getDaemonLogger()).childLogger("<module>")`; handlers use `ctx.log`. Noisy periodic events go at `debug` (default level is `info`; `RT_LOG_LEVEL=debug` to see them).

**The catch policy:** never swallow errors in a seam. Below a logged seam, an empty catch is acceptable only for genuinely expected conditions (socket already closed, file already gone) — anything else logs at `warn` with `{ err }`.

## Footguns

### Module registry

When adding a new command module referenced by `cli.ts` (any file with a `module:` entry in the command tree), you **must** also register it in `lib/module-registry.ts` with a static import and registry entry. `bun build --compile` cannot resolve dynamic `import()` with runtime-constructed paths, so the compiled binary relies entirely on this registry. Running from source (`bun run cli.ts`) works fine without the registry entry because the dynamic import fallback succeeds, so you won't catch this locally -- it only breaks in the distributed binary.
