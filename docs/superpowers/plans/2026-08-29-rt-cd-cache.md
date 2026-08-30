# Plan: rt cd repo-list cache (poll + ctrl-r)

Spec: `docs/superpowers/specs/2026-08-29-rt-cd-cache-design.md` (the binding
authority; read it for rationale). This plan is the execution argument.

## Context

`rt cd` runs `getKnownRepos` (~295ms) on the critical path before the fzf
picker paints. This plan serves the picker from a daemon-maintained cache so it
paints instantly, keeps the cache fresh with a 5-minute daemon poll, and adds a
`ctrl-r` manual refresh. Prior speedups (scan fs-read, ink split) already
landed on `main`.

## Global Constraints (bind every task)

- No em dashes or en dashes anywhere (code, comments, messages). Use `...`,
  parens, or rephrase.
- Clean-code comments: a comment states a non-obvious constraint or invariant
  only. No narration, no change-justification, no task/review references.
- **Never sync-exec (`execSync`/`spawnSync`) on the daemon thread.** Daemon-path
  code uses async git (`listWorktreesAsync` and friends).
- rt state lives under `~/.mattstack/rt` via `lib/rt-paths.ts` helpers, never
  the legacy `~/.rt` literal.
- `getKnownReposAsync` output MUST deep-equal `getKnownRepos` for the same
  on-disk state (same rows, order, branches, `missing`/`registered` flags).
- Any leaf picker gates `process.stdin.isTTY && !json && !process.env.RT_BATCH`
  and leaves the non-TTY path unchanged.
- `lib/fzf-select.ts` stays in the `no-eager-tui` daemon-graph banned set
  (already on `main`); no new static edge drags ink into a command or the
  daemon.
- Tests run under bun with the existing HOME-isolation preload; add fixtures,
  never touch real `~/.mattstack`.
- Interval is a hardcoded const (`REFRESH_MS = 5 * 60_000`), NOT a settings
  key (ruling: a key lives in the published rt-client registry, out of
  proportion for a poll interval).

## Interfaces (pinned)

- `listWorktreesAsync(repoPath: string): Promise<WorktreeEntry[] | null>` in
  `lib/worktree/git-async.ts`; `WorktreeEntry = { path: string; branch: string
  | null }`, already `existsSync`-filtered. It does not report `bare` entries
  the way the sync porcelain parse does; the async builder must still match
  `getKnownRepos`' bare/existsSync filtering (parity check).
- `singleWorktree(dir)` and `headBranch(gitDir)` already exist in
  `lib/repo-index.ts` (the fs fast-path) and are the model for the async
  builder's single-worktree case.
- Daemon periodic tasks are wired in `lib/daemon.ts` "section 6: background
  subsystems" via `scheduleSweep(...)` pushed onto `sweepHandles`.

---

## Task 1: `getKnownReposAsync` async builder

**File:** `lib/repo-index.ts` (+ test in `lib/__tests__/repo-index-async.test.ts`)

Add `export async function getKnownReposAsync(opts?: { includeMissing?:
boolean }): Promise<KnownRepo[]>` — an async mirror of `getKnownRepos`.

- Keep the sync-fast parts as-is: `loadRepoIndexEntries`,
  `partitionByRealpath`, the `singleWorktree` fs fast-path,
  `scanUnregisteredRepos`'s directory walk. These are sqlite/readdir/realpath,
  fast and safe off the main thread; do not needlessly async-ify them.
- Async-ify ONLY the git spawns:
  - Multi-worktree registered repos (where `singleWorktree` returns null): use
    `await listWorktreesAsync(mainPath)` instead of the `execSync("git worktree
    list --porcelain")` block. Map its `WorktreeEntry[]` to the same
    `KnownRepo["worktrees"]` shape, applying the same `!isBare && existsSync`
    filtering `getKnownRepos` applies. On `null` (git failed), fall back to the
    same `[{ path: mainPath, branch: "", isBare: false }]` the sync version
    uses in its catch.
  - Unregistered candidate branch labels (`branchOf`): reuse the fs `.git/HEAD`
    read for plain repos; for a linked-worktree candidate (`.git` is a file),
    use an async branch read (an async `rev-parse`/`listWorktreesAsync`-derived
    branch), never `execSync`. Preserve the `BRANCH_LABEL_CAP` skip behavior.
- Factor shared pure logic (entry partitioning, single-worktree synthesis, row
  assembly) so the sync and async builders cannot drift, OR keep them as
  deliberate mirrors with a parity test as the guard. Prefer factoring the
  non-git logic into a shared helper both call.

**Tests (test-first):** `getKnownReposAsync` deep-equals `getKnownRepos` for a
fixture covering: a single-worktree real repo, a real repo with an added linked
worktree, an unregistered `markerRepo` candidate, and a missing/lost row
(`includeMissing: true`). Use the existing `realRepo`/`markerRepo` fixture
helpers' style.

**Done:** parity test green; `getKnownReposAsync` exported; no `execSync` in the
async path.

---

## Task 2: cache module + rt-paths helper

**Files:** `lib/rt-paths.ts`, new `lib/repo-cache.ts`, test
`lib/__tests__/repo-cache.test.ts`

- `rt-paths.ts`: add `export function cdCachePath(): string { return
  join(rtDir(), "cd-cache.json"); }`.
- `lib/repo-cache.ts`:
  - `export function writeRepoCache(repos: KnownRepo[]): void` — writes
    `{ version: 1, builtAt: Date.now(), repos }` atomically: write to
    `cdCachePath() + ".tmp"` then `renameSync` over the real path. Wrap in
    try/catch; on failure do not throw (best-effort; a stale cache is safe).
  - `export function readRepoCache(): { builtAt: number; repos: KnownRepo[] } |
    null` — returns null on missing file, JSON parse error, or
    `version !== 1`. Never throws.
  - Import `KnownRepo` as a type from `lib/repo-index.ts`. Keep this module
    ink-free and daemon-safe (pure fs + JSON; no git, no picker imports).

**Tests (test-first):** round-trips a valid payload; returns null on missing,
on corrupt JSON, and on a wrong `version`; the write leaves no readable partial
file (temp+rename). Use HOME isolation.

**Done:** module + helper exported; tests green. Independent of Task 1.

---

## Task 3: daemon 5-minute poll

**File:** `lib/daemon.ts` (+ a small `lib/daemon/cd-cache-refresh.ts` if it
keeps daemon.ts clean), test as feasible.

- Add a `scheduleSweep`-based periodic task in `lib/daemon.ts` "section 6:
  background subsystems", pushed onto `sweepHandles` like the existing sweeps:
  boot-delay ~10s, interval `REFRESH_MS = 5 * 60_000`.
- Each tick: `const repos = await getKnownReposAsync({ includeMissing: true });
  writeRepoCache(repos);`. Match `getKnownRepos({ includeMissing: true })` (the
  same opts `rt cd` uses) so the cache matches what the picker builds.
- Log a domain event at `debug` per tick via the daemon child logger
  (`(await getDaemonLogger()).childLogger("cd-cache")` or `ctx.log` per the
  daemon convention): `{ rows, durationMs }`. Do not log outcomes (the daemon
  seam owns that).
- The tick body must never throw out of the timer (`safeInterval`/
  `scheduleSweep` already wrap it, but keep the body defensive).

**Depends on:** Task 1 (`getKnownReposAsync`), Task 2 (`writeRepoCache`).

**Done:** daemon writes `cd-cache.json` on boot (+10s) and every 5 min; uses the
async builder (no `execSync` on the daemon thread); debug log per tick.

---

## Task 4: cd read path + ghost guard

**Files:** `lib/repo-index.ts` (or a cd helper), `commands/cd.ts`,
`lib/pickers.ts`, test `lib/__tests__/cd-cache-read.test.ts`

- Add `export function getKnownReposCached(opts?: { includeMissing?: boolean }):
  KnownRepo[]` — `readRepoCache()`; on hit return `repos`; on miss return
  `getKnownRepos(opts)`. (Sync: the CLI read path is fine sync.)
- `commands/cd.ts`: replace the `getKnownRepos({ includeMissing: true })` call
  with `getKnownReposCached({ includeMissing: true })`. After `getRepoIdentity()`
  resolves `identity`, if `identity` is set but no row in the cached list
  matches `identity.repoName`, fall back to a live `getKnownRepos({ includeMissing:
  true })` for this invocation (correctness: always show the repo you are
  standing in, even if the cache predates it).
- `lib/pickers.ts`: the picker helpers that call `getKnownRepos` for the cd flow
  should accept the already-resolved `repos` from the caller (they mostly do —
  verify no picker re-runs the live scan on the cd path).
- **Ghost guard:** before `cd.ts` prints `selectedPath`, `existsSync(selectedPath)`;
  if it is gone, print a `missingRepoRefusal`-style line and exit non-zero
  rather than emitting a dead path on stdout (which the shell would `cd` into).

**Depends on:** Task 2 (`readRepoCache`).

**Tests (test-first):** `getKnownReposCached` returns cached rows when a cache
exists, live rows when absent; cd's current-repo-missing path triggers the live
fallback; selecting a now-missing path yields the refusal (unit-test the guard
helper).

**Done:** cd reads the cache with correct fallbacks; ghost guard in place; tests
green.

---

## Task 5: `buildFzfRows` extraction + hidden `--emit-rows`

**Files:** `lib/fzf-select.ts`, `commands/cd.ts`, test
`lib/__tests__/cd-emit-rows.test.ts`

- In `lib/fzf-select.ts`, extract the row-builder currently inline in
  `filterableSelect` into `export function buildFzfRows(options:
  SelectOption[]): string` and call it from `filterableSelect`. Output must be
  byte-identical to today's (same `value\t<styled label>\t<hint>` format,
  same ANSI/padding) so fzf's `--delimiter`/`--with-nth`/`--nth` parsing is
  unchanged.
- In `commands/cd.ts` `worktreePicker`, parse `--emit-rows` at the top
  alongside `--repo`/`--package` (do NOT add it to `command-tree-def.ts` — it
  stays hidden from help and pickers). When present:
  - Guard: only act on the non-interactive path (`!process.stdin.isTTY ||
    process.env.RT_BATCH`); otherwise fall through to normal behavior. It is an
    agent/reload-backing flag.
  - Build the same rows the cd picker would: `buildFzfRows(repoOptions(
    getKnownRepos({ includeMissing: true })))`, print to stdout, and
    `writeRepoCache(repos)` as a side effect (so ctrl-r refreshes the cache
    too). Exit 0. Do not launch a picker.

**Depends on:** Task 2 (`writeRepoCache`).

**Tests (test-first):** `buildFzfRows` output equals the pre-refactor format
for a sample option set; `rt cd --emit-rows` on the non-TTY path prints
parseable rows (tab-delimited, first field = repo value) and writes the cache;
it is absent from the command tree / help.

**Done:** `buildFzfRows` shared; hidden `--emit-rows` prints rows + refreshes
cache; tests green.

---

## Task 6: ctrl-r refresh bind + header

**Files:** `lib/fzf-select.ts`, `lib/pickers.ts`

- Thread a cd-only refresh through `filterableSelect` without changing behavior
  for other callers: add optional params, e.g. `reloadCommand?: string` (adds
  `--bind=ctrl-r:reload(<cmd>)`) and a header suffix appended only when set
  (e.g. `  ctrl-r: refresh`). When the params are absent, `filterableSelect`
  behaves exactly as today (same binds, same header, same output/exit).
- In `lib/pickers.ts`, the cd pickers (`pickWorktreeWithSwitch`,
  `pickFromAllRepos`, and the repo picker used by cd) pass
  `reloadCommand: "rt cd --emit-rows"`. fzf runs the reload via `sh -c`, so it
  resolves `rt` from PATH (the installed binary; dev-mode's shell-function
  wrapper is not visible to `sh -c` — acceptable, note in a comment).
- Keep the reload wired only on cd's pickers, not `filterableMultiselect` or
  other `filterableSelect` callers.

**Depends on:** Task 5 (`--emit-rows` must exist), Task 4 (cd picker path).

**Tests:** the shared `filterableSelect` param addition keeps existing fzf
tests green (no bind/header change when `reloadCommand` is absent); assert the
bind string is included when the param is set (unit-test the arg assembly if it
is extractable, else a light check).

**Done:** cd picker shows `ctrl-r: refresh` and reloads from the live emitter;
other pickers unchanged.

---

## Verification (controller, after all tasks)

- Full suites: `bun test lib/__tests__/repo-index*.test.ts
  lib/__tests__/no-eager-tui.test.ts lib/__tests__/fzf.test.ts
  lib/__tests__/navigate.test.ts lib/__tests__/repo-cache.test.ts` plus the new
  test files.
- `bun run picker:check` (leaf-picker conformance) and confirm `--emit-rows`
  did not register a required positional.
- Measure cached pre-paint (expect ~96ms + boot vs ~390ms + boot).
