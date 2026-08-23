# rt — repo tools

Personal developer CLI built with Bun. Compiled to a standalone binary via `bun build --compile` and distributed as a GitHub Release tarball that mattstack.app (and `rt --post-install`) installs.

## Architecture docs live in Linear, not this repo

rt is one piece of a plan spanning five repos, so the governing design docs are
not in any single repo. Before proposing anything about rt's scope, mr-board,
glance, gitq, or the acme skills, read `docs/architecture.md` for the links.

## Settings architecture

Every key any mattstack app reads lives in the suite settings stores behind the
resolver in `packages/rt-client`. Before adding a key, porting config, or
touching `~/.mattstack`, read `docs/settings-architecture.md` — it carries the
scope model, the registry checklist, the ownership-latch pattern, and the
footguns (call-time HOME, file:-dep copies, sops cwd triple).

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

## Operating on this machine

This repo's tooling runs as live services on the developer's own machine. Six
rules, each written after it cost real damage:

- **A built binary is only ever run under an isolated HOME** — `env -i HOME=<temp> …`,
  every invocation, not just tests. The daemon shim and the compiled `rt` both
  read `~/.mattstack` and will act on it: a single unisolated run started a real
  daemon that spent minutes creating worktrees and running installs.
- **Never rebuild, re-sign, or reinstall an app bundle macOS has blessed**
  (`/Applications/mattstack.app`, `rt-tray/mattstack-dev.app`). Build into a
  scratch directory instead. Re-signing invalidates Login Items and TCC grants,
  and the failure is silent.
- **Check `git branch --show-current` before syncing the main checkout.** It is
  shared with other sessions and is what the dev-mode `rt` wrapper executes;
  it is not always on `main`. That second half makes it operational, not
  hygiene: **the branch that checkout sits on is the dev daemon's deployed
  code.** A daemon that has been up for hours is running whatever was checked
  out when it started — another lane's branch, quite possibly — so a merge
  changes nothing in service until the checkout syncs AND the daemon restarts.
- **Diagnose live services without starting competing instances.** An extra
  daemon squats `rt.sock` and produces exactly the symptom — starts, binds
  nothing, logs nothing — that then gets misdiagnosed as a permissions problem.
- **Re-read a ticket immediately before acting on it.** Tickets here are
  written by other live sessions while you work, so the copy you read at the
  start of a task is a snapshot, not the current state. A prune ran against a
  ticket that had, in the meantime, grown a section explaining that the very
  row being removed was being kept deliberately — the eviction orphaned a
  daemon registry and silently stopped worktree reconciliation. The same
  applies to any shared artifact a peer session can edit underneath you.

A claimed recovery path (self-heal, fallback, retry) is load-bearing: trace the
code that performs it before documenting it, or the docs will tell users to run
something that does nothing.

## Footguns

### Module registry

When adding a new command module referenced by `cli.ts` (any file with a `module:` entry in the command tree), you **must** also register it in `lib/module-registry.ts`. `bun build --compile` cannot resolve dynamic `import()` with runtime-constructed paths, so the compiled binary relies entirely on this registry to discover and bundle every command module. Running from source (`bun run cli.ts`) works fine without the registry entry because the dynamic import fallback succeeds, so you won't catch this locally -- it only breaks in the distributed binary.

Every registry value is a thunk — `() => import("../commands/x.ts")` with the path spelled out literally — not an eagerly-evaluated namespace import. That's what keeps `rt --version` and every other dispatch from paying for the whole command surface: the bundler still statically discovers all 30 modules, but none of them evaluate until a command actually dispatches to it. Adding a static (non-thunked) `import` of a command module to `lib/module-registry.ts`, or a static value import of `lib/rt-render.tsx`/`ink` to `lib/command-tree.ts`, is a startup regression — `scripts/bench-startup.ts` gates this in the release workflow (`.github/workflows/release.yml`), and `lib/__tests__/no-eager-tui.test.ts` gates the command-tree and command-module cases directly.

### `packages/rt-client/dist/` goes stale without warning

`dist/` is gitignored, but `file:` consumers (mr-board, gitq, the console) copy it **verbatim** at install time rather than building from source. So any change or merge that touches rt-client's source leaves every consumer installing the previous build — the source is right, the shipped artifact is not, and nothing about the working tree looks wrong. Run `bun run build` in `packages/rt-client` after touching it, and after any merge that does.

`packages/rt-client/test/dist-freshness.test.ts` is the guard and names the fix in its failure message. Treat that failure as a real instruction, not as a flaky artifact test — it caught this three separate times in one day across three sessions.

### Bytecode compile (`--bytecode`) silently falls back on failure

`bun build --compile --bytecode` does not reliably fail loudly when bytecode generation fails. Ink's dependency graph (via `yoga-layout`) and top-level await in `cli.ts` both currently break bytecode generation, but when the *post-bundle* bytecode step itself fails (as opposed to a bundling/parse error), bun still writes out a working binary — just without bytecode, and only a few hundred KB smaller than the non-bytecode build, so the artifact looks like a success. Never conclude `--bytecode` worked because a binary appeared and ran; check the build's stderr for `Failed to generate bytecode` (or read the exit code) before trusting the artifact. A hard parse-time failure (e.g. the top-level `await` in `cli.ts`) does exit non-zero with no binary produced, so that failure mode is safe -- it's specifically the later stage that goes silent.
