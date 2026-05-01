# Doppler template + auto-sync per repo

**Status:** Design — pending implementation plan
**Owner:** Matthew Goodwin
**Date:** 2026-04-30

## Summary

Today, every new git worktree of a Doppler-using monorepo requires running an interactive `make initDoppler`-style script to populate `~/.doppler/.doppler.yaml` with per-app project mappings. The browser flow alone (per-worktree `doppler login`) takes minutes, and the per-app `doppler setup` calls are mechanical. This design replaces that workflow with a single per-repo template file managed by rt, plus an automatic reconciler in the daemon that keeps `~/.doppler/.doppler.yaml` consistent with the template across all worktrees.

After this lands, adding a new worktree to a Doppler-using repo requires zero Doppler-specific user action — the daemon detects the new worktree on its next tick and writes the right entries to the global Doppler config. New machines run `rt doppler init` once per repo to capture the existing mapping, then never touch Doppler config again.

This is a prerequisite for the auto-fix feature's ephemeral worktree provisioning, but it's also valuable on its own — every dev who uses rt benefits whether or not auto-fix runs.

## Goals

- Eliminate per-worktree `doppler login` browser flows.
- Eliminate per-worktree `doppler setup` per-app calls.
- Make Doppler "just work" in any worktree the moment it appears, with no shell hook, no env var, no wrapper script.
- Single source of truth per repo (`~/.rt/<repo>/doppler-template.yaml`).
- Preserve per-path overrides — devs can still `doppler setup -p X -c staging` to deviate from the template default for a specific path.
- No repo-level changes (no in-repo `doppler.yaml`, no Makefile edits required to ship this).

## Non-goals

- Managing Doppler auth tokens. Tokens are stored where they already are (`~/.doppler/.doppler.yaml` `/` scope, or per-repo) and discovered via Doppler's normal path-walk. The auth model isn't changing.
- Replacing Doppler's CLI. The reconciler writes the same YAML structure `doppler setup` writes; Doppler reads it natively.
- Removing existing per-worktree token entries — those are harmless leftovers and stay until the user decides to clean them up.
- Cross-repo deduplication. Each repo has its own template; mappings aren't shared between repos.
- Solving non-Doppler env management (`.env` files, `~/.aws/credentials`, etc.).

## Why a cache, not a wrapper or env-var injection

Two design alternatives were considered and rejected:

1. **Shell hook + env vars (`DOPPLER_PROJECT`/`DOPPLER_CONFIG`)** — only works in shells that source the user's rc files. IDE terminals, agents, scripts that don't go through interactive shells silently miss the env vars. Not bulletproof.

2. **`doppler` wrapper binary in PATH** — works everywhere, but requires intercepting every Doppler call and parsing args, which is fragile and duplicates Doppler's CLI behavior. Also: any tool that spawns a child process with the absolute path `/opt/homebrew/bin/doppler` bypasses the wrapper.

Treating `~/.doppler/.doppler.yaml` as a cache that rt manages avoids both problems. Doppler reads it natively at runtime; anything that calls `doppler` from any context works without further configuration.

## Template file format

Per-repo file at `~/.rt/<repo>/doppler-template.yaml`. List of per-app mapping entries; the worktree root is implicit (resolved per-worktree by the reconciler).

```yaml
- { path: apps/adjuster,                 project: adjuster,      config: dev }
- { path: apps/backend,                  project: backend,       config: dev }
- { path: apps/billing,                  project: billing,       config: dev }
- { path: apps/frontend,                 project: frontend,      config: dev }
- { path: apps/hub,                      project: hub,           config: dev }
- { path: apps/sidekick-voice-ai,        project: voice-ai,      config: dev }
- { path: packages/design-system,        project: design-system, config: dev }
- { path: packages/e2e,                  project: e2e,           config: dev }
- { path: packages/guided-photo-capture, project: frontend,      config: dev }
- { path: packages/sidekick,             project: adjuster,      config: dev }
```

Fields:

- `path` — relative path from worktree root to the app/package directory.
- `project` — the Doppler project name to bind for that path.
- `config` — the Doppler config name (almost always `dev`; left explicit so non-dev defaults are possible per app).

## Reconciler behavior

The reconciler runs in the daemon on every cache-refresh tick (the same loop that already drives MR enrichment and parking-lot scans). For each repo with a `doppler-template.yaml`:

1. Resolve all worktree roots for the repo via `git worktree list --porcelain`. (Uses the existing repo identity — `~/.rt/repos.json` — to know which paths to enumerate.)
2. For each worktree root × each template entry, compute the absolute path: `<worktree-root>/<entry.path>`.
3. Read the current `~/.doppler/.doppler.yaml`.
4. For each computed path, check whether a `scoped:` entry exists.
   - **No entry** → write `enclave.project: <entry.project>` and `enclave.config: <entry.config>`.
   - **Entry exists with same project + config** → leave alone (no-op).
   - **Entry exists with different project + config** → leave alone (this is a deliberate user override; the reconciler must never overwrite). Optionally surface this in `rt doppler status` as "overridden."
5. Write the updated file atomically (write to `.doppler.yaml.tmp`, `rename` over the original).

Properties:

- **Idempotent** — running the reconciler repeatedly converges to the same state.
- **Override-safe** — only adds; never modifies existing entries.
- **Token-free** — never writes per-path tokens. Doppler walks up to find one.
- **Atomic** — readers always see a complete file (no half-written state).

## Concurrency safety

`~/.doppler/.doppler.yaml` is a shared mutable file used by both Doppler CLI and the reconciler.

The implementation uses **atomic-rename-only** for write safety: `writeDopplerConfig` writes to `.doppler.yaml.tmp` and `renameSync`s over the destination. Rename is atomic on the same filesystem, so readers (Doppler CLI, the reconciler itself on the next tick) never see a partial write. We deliberately do **not** take a `flock` for the following reasons:

- Doppler CLI itself never holds a lock on the file; adding one in rt would only protect rt-vs-rt races, not rt-vs-Doppler races.
- The narrow remaining race — user runs `doppler setup -p X -c staging` while a reconciler tick is mid-flight — can in theory lose the user's write. In practice the window is single-digit milliseconds (the reconciler's read-modify-write is microseconds of work, only the YAML stringify + atomic rename takes any time).
- If the lost-write case ever does happen, the user can detect it via `rt doppler status` showing `ok` instead of `override`, and re-run `doppler setup`. No silent corruption, no inconsistent state.

For users with multiple machines sharing `~/.doppler/.doppler.yaml` (e.g. via a synced home directory), races are still rare and recoverable. If real-world usage shows the race biting users, adding `flock` is an easy follow-up — but doing it preemptively without evidence would be premature.

## CLI surface

```
rt doppler init      # capture existing entries from ~/.doppler/.doppler.yaml into ~/.rt/<repo>/doppler-template.yaml
rt doppler sync      # run the reconciler once for the current repo (and on demand)
rt doppler status    # show: which template entries are present, missing, or overridden in ~/.doppler/.doppler.yaml
rt doppler edit      # open the template in $EDITOR for manual changes
```

### `rt doppler init`

One-shot, captures the current state into a template:

1. Resolve the active repo and its worktree roots.
2. For each app/package path that has an `enclave.project` entry under the **primary** worktree (or whichever worktree the user is in), capture `{ path, project, config }`.
3. Write `~/.rt/<repo>/doppler-template.yaml`.
4. Print: "Captured N entries. Run `rt doppler sync` to apply across all worktrees."

The user runs this once per repo, after they've already done their normal `make initDoppler` at least once. From then on, the template is the source of truth.

### `rt doppler sync`

Manual trigger of the reconciler for the current repo. Identical logic to the daemon's tick.

### `rt doppler status`

Three columns: `path`, `template`, `actual`. Each row shows what the template wants vs. what's in `~/.doppler/.doppler.yaml`. Highlights:
- Missing (template wants it, file doesn't have it).
- Overridden (file has different project/config — user override).
- Stale (file has it for a worktree that no longer exists; informational, not a problem).

### `rt doppler edit`

Just `$EDITOR ~/.rt/<repo>/doppler-template.yaml`. After editing, prints "Run `rt doppler sync` to apply" (the daemon will also catch it on its next tick).

## Auto-fix integration

The auto-fix engine, when provisioning an ephemeral worktree, calls the reconciler before spawning the agent. The reconciler treats the new worktree path the same as any other — writes the per-app entries — and the agent inherits a fully-configured Doppler environment with zero extra steps.

After the auto-fix completes and the worktree is removed, the entries can be left in `~/.doppler/.doppler.yaml` (harmless) or pruned (`rt doppler sync --prune-stale`). The default is to leave them — the file is small, and ephemeral-worktree paths are predictable enough that they'd be re-used on the next fix attempt anyway.

## Failure mode analysis

- **Template file missing** — repo opts out. Reconciler skips it. No error, no notification.
- **Template file malformed YAML** — reconciler logs a parse error and skips that repo for that tick. Daemon log captures the line/column. User runs `rt doppler edit` to fix.
- **`~/.doppler/.doppler.yaml` is missing entirely** — reconciler creates it from scratch (with the appropriate top-level YAML structure) and writes the entries.
- **`~/.doppler/.doppler.yaml` has an entry with a different `project` than the template** — left alone (user override). `rt doppler status` flags it.
- **No auth token reachable via path-walk** — Doppler errors at runtime ("no token configured"). The reconciler can't fix this; user runs `doppler login` once. After that, all subsequent worktrees just work.
- **Worktree path doesn't exist on disk yet (was removed)** — reconciler still writes the entry (the path is a string match for Doppler; it doesn't validate the dir exists). Stale entries are harmless. `rt doppler sync --prune-stale` cleans them.
- **Daemon not running** — reconciliation pauses. New worktrees don't auto-sync until the daemon starts again, OR the user runs `rt doppler sync` manually. Bulletproof in the sense that it's always recoverable; not "instant" without the daemon.

## Persistence and observability

- `~/.rt/<repo>/doppler-template.yaml` — the template (user-editable).
- `~/.doppler/.doppler.yaml` — the cache (managed by rt, but writable by Doppler CLI for user overrides).
- Daemon log: each reconciliation tick logs `doppler:sync repo=<X> wrote=<N> overridden=<M> stale=<P>` so the user can see activity without invoking `rt doppler status`.

## Implementation surface (preview for plan)

- `lib/doppler-template.ts` (new) — read/write `~/.rt/<repo>/doppler-template.yaml`. Parse + serialize YAML.
- `lib/doppler-config.ts` (new) — read/write `~/.doppler/.doppler.yaml`. Atomic write with flock.
- `lib/daemon/doppler-sync.ts` (new) — the reconciler. Called per-tick by the daemon's main loop, and on-demand by `rt doppler sync`.
- `lib/daemon/handlers/doppler.ts` (new) — IPC handlers for `doppler:sync`, `doppler:status`.
- `commands/doppler.ts` (new) — `init`, `sync`, `status`, `edit` subcommands.
- `lib/daemon.ts` — wire the reconciler into the existing cache-refresh tick.

## Open questions

- **YAML formatting / preserving comments** — `~/.doppler/.doppler.yaml` could conceivably have user comments. A round-trip-safe YAML library (e.g. `yaml` package with comment preservation) is preferable. If we lose comments we should call that out in the init flow.
- **Default `config` value** — currently every entry in this repo uses `dev`. Could default to `dev` if omitted from a template entry, simplifying the file. v2 polish.
