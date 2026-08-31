# Preset launch via the runner board

## Goal

`rt run` presets launch as a seeded `rt runner` board: each preset entry becomes a tracked board entry (live state, tail, stop/restart/focus, guarded quit), in a dedicated `rt-runner-<id>` workspace. This replaces the raw-pane `launchInHerdr` path for presets. The non-herdr fallback (`launchFallback`) is unchanged.

## Background (current behavior)

- A preset (`lib/run-presets.ts`): `Preset { name: string; entries: PresetEntry[] }`; `PresetEntry { packageRelPath: string; packageLabel: string; script: string; variationName?: string; command?: string }`. Often several entries.
- `launchPreset(preset, worktreePath)` (`commands/run.ts`) maps entries to `LaunchItem { label, command, cwd }` and, when `isInsideHerdr()`, calls `launchInHerdr(items)` (spawns raw herdr panes in the current workspace, no board); otherwise `launchFallback(items)`.
- The runner (`lib/runner/runner.ts`) launches commands as tracked herdr panes on a board. Its `add()` does: `newEntry(++seq, name, command, cwd, pkg, repo)` -> `entries.push(entry)` -> `launch(entry)` (`createWorkspace` first time, then `createTab`, then `engine.run(paneId, cwd, command)`). `RunnerDeps = { engine, openSession, resolve, now, sleep, workspaceLabel }`. `rt runner` gates on `interactive()` and `herdrAvailable()`.

## Design

The preset entries are already `(command, cwd)` pairs, which is exactly what the runner launches. So route a preset through the runner by SEEDING it with pre-resolved entries (no picker).

1. **Seed the Runner.** Add `seed?: SeedEntry[]` to `RunnerDeps`, where `SeedEntry = { name: string; command: string; cwd: string; pkg: string; repo: string }`. Extract the entry-create-and-launch tail of `add()` into a shared helper `private async launchResolved(seed: SeedEntry): Promise<void>` (does `newEntry(++this.seq, seed.name, seed.command, seed.cwd, seed.pkg, seed.repo)`, pushes it, `await this.launch(entry)`). `add()` calls `launchResolved` after `resolve()`; the seed loop calls it directly. In `run()`, after `openBoard()` and before the intent loop, if `deps.seed?.length`, launch each seed entry in order, then `push()` the model. An empty/absent seed is the current behavior (empty board).

2. **buildRunnerDeps** (`commands/runner.ts`) accepts an optional `seed: SeedEntry[]` and includes it in the returned deps. Export `SeedEntry`. Provide a helper the preset caller uses: `runSeededBoard(seed: SeedEntry[], ctx: CommandContext): Promise<void>` which runs the same gate (`interactive()` + `herdrAvailable()`), builds the deps with the seed, and runs a `Runner`. (Factor the shared gate/build/run out of `runnerCommand` so both it and `runSeededBoard` use it.)

3. **launchPreset** (`commands/run.ts`): build `SeedEntry[]` from `preset.entries`:
   - `name` = the script (e.g. `e.script`)
   - `command` = `e.command ?? \`${detectPackageManager(join(worktreePath, e.packageRelPath))} run ${e.script}\``
   - `cwd` = `join(worktreePath, e.packageRelPath)`
   - `pkg` = the package label (as used in the existing `LaunchItem.label`)
   - `repo` = `basename(worktreePath)`
   Then: when `herdrAvailable()` resolves true, call `runSeededBoard(seed, ctx)` (dropping `launchInHerdr`); else `launchFallback(items)` as today. Keep the `preset <name>` breadcrumb.

## Behavior

- `rt run` -> pick a saved preset -> a new `rt-runner-<id>` workspace opens with the preset's commands launching as board rows; full board UX applies. Quitting the board tears down that workspace.
- herdr unavailable (or not the interactive/herdr path) -> the existing `launchFallback` runs, unchanged.

## Contracts preserved

- The seed launch reuses the runner's own launch path. No herdr logic lives outside `lib/runner/engine.ts`; the command never calls the daemon.
- `run()` still resolves only after the session ends AND teardown ran, and never calls `process.exit`.
- The runner's two locked contracts hold: the board emits `quit` via `tea.Sequence` so `closed` is the final wire line; `deriveState` holds a `stopping` entry until its `__rt_exit` sentinel.
- Tests drive injected fakes (fake engine, fake session, controllable now/sleep). NEVER a real herdr socket or a real `rt-ui` spawn.

## Non-goals

- No change to preset save/load (`lib/run-presets.ts`) or to the interactive `rt run` repo/package/script resolution.
- Not adding presets to the runner's in-board `a` (add) flow.
- The board's Go rendering is unchanged.

## Global constraints

- Bun 1.3.x + TypeScript. Never use em dashes or en dashes; never write "load bearing"; comments state constraints, not narration. Commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Gates: `bunx tsc --noEmit`, `bun test lib/runner commands`, `bun run picker:check`, `bun run docs:check`.
- Branch `feat/preset-runner-launch`, stacked off `rt-runner-board` (this feature depends on the runner in PR #140). Rebase onto `main` after #140 merges.

## Open decisions (resolved)

- Route preset launch through the seeded runner, replacing `launchInHerdr` for presets; non-herdr keeps `launchFallback` (Matt, 2026-08-31).
- Build via a short subagent-driven SDD (Matt, 2026-08-31).
