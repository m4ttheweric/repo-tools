# rt cd repo-list cache (poll + ctrl-r)

Design spec. Status: ratified in conversation 2026-08-29, unimplemented.

## Goal

Make the `rt cd` picker paint effectively instantly by serving its repo list
from a daemon-maintained cache, instead of running the ~295ms `getKnownRepos`
scan on the critical path every invocation.

Prior work already landed (both on `main`):

- Scan speedup: single-worktree repos read `.git/HEAD` instead of spawning
  `git worktree list` (`getKnownRepos` 988ms -> ~295ms).
- Ink split: cd renders via native fzf through `lib/fzf-select.ts`; the picker
  import dropped 63ms -> 1ms.

Remaining pre-paint cost is `getRepoIdentity` (~94ms, cwd-specific, out of
scope) + `getKnownRepos` (~295ms, THIS spec) + boot.

## Non-goals

- No watchman / FSEvents dependency. `lib/nav-watch.ts` already documents that
  directory-level FSEvents was unreliable enough on Darwin to hand-roll an
  mtime poll; a per-repo `.git` watch also misses newly cloned repos entirely
  (no `.git` to watch yet). Rejected.
- Not caching `getRepoIdentity` (the "where am I" resolve). Separate follow-up.
- Not true fzf `start:reload` SWR (async-spawn refactor + `--listen`). The poll
  keeps the cache fresh proactively, so the reload-swap machinery is unneeded;
  ctrl-r is the manual override.

## Shape

1. **Daemon poll** (`safeInterval`, 5 min): builds the repo list with an async
   builder and writes it to a cache file atomically.
2. **cd read path**: cd/pickers use the cached `KnownRepo[]` for the picker,
   falling back to the live scan when the cache is absent or does not contain
   the current repo.
3. **ctrl-r refresh** in the cd fzf picker: `reload` from a live emitter,
   which also rewrites the cache.
4. **Ghost guard**: `existsSync` the selected path before printing it.

## Components

### 1. `getKnownReposAsync()` — async twin of `getKnownRepos`

`getKnownRepos` is sync (`execSync`), which is forbidden on the daemon thread
(sync-exec wedges the event loop; see the daemon's async-`runCapture` rule).
Add an async mirror in `lib/repo-index.ts`:

- Reuse the sync-fast parts as-is: `loadRepoIndexEntries` (sqlite kv, fast),
  `partitionByRealpath`, the `singleWorktree` fs fast-path (which already
  removes the git spawn for the ~62/73 single-worktree repos), the
  `scanUnregisteredRepos` directory walk (`readdirSync`, fast).
- Async-ify only the two git-spawning spots:
  - Multi-worktree repos: `await listWorktreesAsync(mainPath)` instead of
    `execSync("git worktree list --porcelain")` (~11 repos).
  - `branchOf` candidates: async HEAD/`rev-parse` (the fs `.git/HEAD` read
    already covers plain repos; only linked-worktree candidates need a spawn).
- Output MUST equal `getKnownRepos` for the same on-disk state (shared parity
  test). Same rows, same order, same branches, same `missing`/`registered`
  flags.

### 2. Cache module — `lib/repo-cache.ts`

- Path: `cdCachePath()` -> `~/.mattstack/rt/cd-cache.json` (new `rt-paths.ts`
  helper; app-level file directly under `rtDir()`, like `repos.json`). NOTE:
  state lives under `~/.mattstack/rt`, not the legacy `~/.rt`.
- Format: `{ version: 1; builtAt: number; repos: KnownRepo[] }`. Cache the full
  `KnownRepo[]`, not rendered picker rows — cd's branching (currentRepo
  detection, worktree counts, missing/package handling) needs the structured
  list, and picker rows are terminal-width-dependent (rebuild via
  `repoOptions()` at render, ~1ms, so the cache stays width-safe).
- `writeRepoCache(repos)`: atomic (temp file + `renameSync`) so concurrent cd
  readers never see a partial file. Best-effort; a write failure logs `warn`
  and leaves the previous cache in place.
- `readRepoCache(): { builtAt: number; repos: KnownRepo[] } | null`: returns
  null on missing / unparseable / wrong-version (cd then live-scans). Never
  throws.

### 3. Daemon poll task

- In the daemon init path, register a `safeInterval` (reuse `scheduleSweep` for
  a boot-delay fire + repeating interval) that calls `getKnownReposAsync()` and
  `writeRepoCache()`.
- Interval: 5 min. Backed by a settings key (`rt.cdCacheRefreshMin`, default 5,
  clamped 1..60) following the `janitorIntervalMin` precedent in
  `home-snapshot.ts`, so it is tunable without a rebuild.
- Log a domain event at `debug` per refresh (row count, duration). No
  outcome logging (the daemon seam owns that).
- Daemon down => no refresh => cache goes stale but is still painted; ctrl-r +
  the ghost guard cover the gap.

### 4. cd read path

- `pickers.ts` / `cd.ts` obtain the list via a new helper
  `getKnownReposCached({ includeMissing })`:
  - Read the cache. Hit => return `repos`. Miss => `getKnownRepos()` (live).
  - After `getRepoIdentity()` resolves the current repo, if `identity` is set
    but no cached row matches `identity.repoName`, fall back to the live
    `getKnownRepos()` for that invocation (correctness: you must always see the
    repo you are standing in, even if the cache predates it).
- No hard age cap on read: a stale-but-present cache still paints instantly
  (the whole point); the poll bounds staleness to <=5 min when the daemon is
  up, and ctrl-r is the manual refresh. (Decision below.)

### 5. ctrl-r refresh + emitter

- fzf reload execs a command whose stdout replaces the list, so add an
  agent-facing emitter: `rt cd --emit-rows` (non-TTY / `RT_BATCH`; prints the
  same tab-delimited `value\t<styled label>\t<hint>` rows the picker feeds
  fzf). It runs a LIVE `getKnownRepos` and rewrites the cache as a side effect,
  so ctrl-r refreshes both the on-screen list and the cache.
- Extract the row-builder from `filterableSelect` into a shared
  `buildFzfRows(options)` in `lib/fzf-select.ts`; both the picker and the
  emitter use it so the formats cannot drift.
- In the cd picker only, add `--bind 'ctrl-r:reload(rt cd --emit-rows)'` and
  append `ctrl-r: refresh` to the fzf header. Do not touch the shared
  `filterableSelect` header/binds for other callers (pass cd-specific extras
  through, or use a cd-local picker variant).

### 6. Ghost guard

- Before cd prints `selectedPath`, `existsSync` it. If gone, print
  `missingRepoRefusal`-style guidance and exit non-zero rather than cd-ing into
  a dead path. Closes the window where a cached repo moved/was deleted since the
  last refresh.

## Edge cases

- First-ever run / no cache -> live scan (today's behavior, no regression).
- Corrupt / wrong-version cache -> live scan; `warn`; leave file for the next
  poll to overwrite.
- Current repo absent from cache -> live scan this invocation (see 4).
- Daemon down -> stale cache still paints; ctrl-r + guard cover it.
- Concurrent cd reads during a daemon write -> atomic temp+rename prevents
  partial reads.
- The cache is a plain file, never state.db -> no schema/migration surface.

## Decisions (ratified)

- Interval: 5 min (settings-tunable).
- ctrl-r manual refresh: yes.
- Cache the structured `KnownRepo[]`, rebuild rows at render (width-safe).
- No hard read-side age cap (stale paint is acceptable by design).
- No watchman; no `getRepoIdentity` caching (out of scope).

## Open questions (resolved)

- `rt cd --emit-rows` is **hidden / agent-only**: no help/picker surface, gated
  on non-TTY / `RT_BATCH`. It exists solely to back ctrl-r.
- Boot-delay before the first poll fire: reuse `scheduleSweep`'s boot-delay at
  **~10s**, so it does not compete with daemon startup work.

## Test plan (test-first)

- `getKnownReposAsync` parity: same rows/branches/flags as `getKnownRepos` for
  a real-git fixture (single-worktree, multi-worktree, unregistered candidate,
  missing row).
- `repo-cache`: read returns null on missing/corrupt/wrong-version; round-trips
  a valid payload; write is atomic (no partial file observable).
- cd read path: uses cache when present; live-fallback when absent; live
  fallback when current repo missing from cache.
- emitter: `rt cd --emit-rows` under non-TTY prints parseable rows matching the
  picker format and rewrites the cache; gated (no picker on non-TTY).
- ghost guard: selecting a path that no longer exists -> refusal, non-zero.
- daemon poll: writes the cache; uses the async builder (no `execSync` on the
  daemon thread).
- `no-eager-tui`: the emitter/cache path must not statically drag ink; keep
  `fzf-select.ts` in the daemon-graph banned set.

## Task breakdown

1. `getKnownReposAsync` + parity test (`lib/repo-index.ts`).
2. `lib/repo-cache.ts` + `cdCachePath()` in `rt-paths.ts` + tests.
3. Daemon poll task (`safeInterval`/`scheduleSweep`) wired into daemon init;
   `rt.cdCacheRefreshMin` setting.
4. cd read path: `getKnownReposCached` + current-repo-missing fallback in
   `cd.ts`/`pickers.ts`.
5. `buildFzfRows` extraction + `rt cd --emit-rows` emitter.
6. ctrl-r bind + header hint in the cd picker.
7. `existsSync` ghost guard on selection.
8. Wire-up/integration pass + measure cached pre-paint (expect ~96ms + boot,
   down from ~390ms + boot).

Roughly 8 contained tasks; several are independent (1, 2, 5 have no deps).
