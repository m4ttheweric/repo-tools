# RT-49: rt.repoRoots — settings-seeded repo discovery, repos.json demoted to disposable cache

**Ticket:** RT-49. **Date:** 2026-08-20, rev 6 (addresses reviews r1-r5). **Depends on:** RT-47 settings resolver (shipped).

## Problem

Repo discovery has two mechanisms today, both implicit:

1. `repos.json` (`~/.mattstack/rt/repos.json`, name → main-worktree path) self-populates as a side effect of `getRepoIdentity()` (`lib/repo.ts:75` → `updateRepoIndex`, `lib/repo-index.ts:42`). A repo is only indexed after rt has been run inside it once.
2. `scanUnregisteredRepos()` (`lib/repo-index.ts:129`) infers scan roots as the parent directories of already-indexed repos, and surfaces sibling git repos one level deep as dimmed "unregistered" picker rows.

Consequences: a fresh machine shows nothing until the first manual visit; the scan roots are never stated anywhere (pure inference); `repos.json` looks like config (it sits next to real config) when it is actually derived state; and the worktree-pool convention (a plain parent folder like `assured-dev/` whose children are worktree slots) is invisible to the root-level scan because the pool folder itself has no `.git`.

## Decision (Matt, 2026-08-20)

- New settings key **`rt.repoRoots`** seeds discovery explicitly.
- **`repos.json` becomes a pure disposable cache**: regenerable, safe to delete, never part of a restore story. Fresh machine = set the key (later: the installer seeds it), and everything appears on the first `rt cd`.

## Design

### The settings key

Registered in `lib/settings/registry.ts` (fields per `SettingDef`):

| field | value |
|---|---|
| key | `rt.repoRoots` |
| type | `"array"` |
| scopes | `["machine"]` (paths are machine-specific by nature; a synced scope would be a lie on the next machine) |
| merge | `replace` |
| default | `[]` |
| migrated | `true` (required — `rt settings set` refuses non-migrated keys, and the rollout below uses `set`) |
| description | Directories rt scans for git repos (rt cd, run-outside-a-repo pickers). Entries may start with `~/` or use `${home}`. One level deep, plus worktree-pool parent folders one level deeper. |

Not `teamLocked`, not `secret`, not repo-scoped. Element handling: the resolver's `checkType` validates only "is an array", not element types — the **scanner** filters elements with `typeof e === "string"`, emitting one stderr warning per skipped non-string element.

### Reading the key (expansion + fail-open)

- The scanner reads the key through `getSetting` with expansion on, so `${home}` works.
- Additionally the scanner itself expands a **leading** `~` (`~` alone or `~/...` → `homedir()`); mid-string `~` is not expanded. Both spellings are documented in the key description. This expansion lives in the scanner (or a small helper beside it), NOT as a general resolver pass — a resolver-wide tilde feature is explicitly out of scope.
- An entry that still fails `existsSync` after expansion is skipped **with a one-line stderr warning naming the entry** (never silently dropped — honesty rule).
- **Fail-open:** the settings read is wrapped in try/catch. If the resolver throws (e.g. someone authors `${repoRoot}` in an entry — `expandString` throws on unexpandable closed-set variables, `lib/settings/resolve.ts:258`), the scanner warns once and degrades to inference-only roots (exactly today's behavior). `rt settings get rt.repoRoots` remains the loud diagnostic path. `getKnownRepos` sits under every picker; a bad authored value must never brick `rt cd`.

### Discovery semantics (`getKnownRepos`, `lib/repo-index.ts`)

**Root set** = union of:
1. expanded, existing `rt.repoRoots` entries, and
2. the current inference (parents of indexed repos) — kept so unset-key behavior is exactly today's behavior.

**Normalization before the union:** each root is `path.resolve`d, trailing separators stripped, then `realpathSync`'d — so a configured `"~/Documents/GitHub/"` and an inferred `/Users/matt/Documents/GitHub`, or a symlink alias of it, collapse to one root and cannot double-scan. When a root is BOTH configured and inferred (the common `~/Documents/GitHub` case), **configured semantics win** — i.e. the root-is-a-repo check applies to it. **The dedupe sets get the same treatment**: every path entering `knownPaths` (registered repos' worktree paths from `git worktree list`, whose spellings git never normalizes, and each accepted candidate's path) is `realpathSync`'d before insertion/lookup, so a symlinked path component (macOS `/tmp` → `/private/tmp` being the canonical test-tempdir case) cannot make the same directory double-emit under two spellings. **Guard:** every `realpathSync` call is wrapped — on ENOENT/EACCES (TOCTOU, permissions) it falls back to the `path.resolve`d spelling instead of throwing; `getKnownRepos` must never crash on a vanished or unreadable path. **Scope of normalization:** realpath'd spellings exist for set-membership ONLY. Already-known repos keep their original spellings everywhere user-visible (`KnownRepo.worktrees[].path`, repos.json — `updateRepoIndex` untouched per the non-goals; `rt cd` targets and hints do not change). Candidates carry BOTH spellings: emitted `path` = `join(<resolved root spelling>, name)` (so `repoOption`'s `homedir()` → `~` display keeps working), while the realpath'd form is used only as the dedupe-set key.

**Root-is-a-repo (configured entries ONLY):** a **configured** root that itself contains `.git` is treated as a single unregistered candidate — named `basename(root)`, passing through the same `knownPaths`/`knownNames` dedupe as every candidate, so a configured root that is already an indexed repo emits nothing — and its children are NOT scanned (the likeliest misconfiguration — pointing at a repo instead of its parent — must not surface submodules/fixtures as garbage rows). This rule explicitly does NOT apply to **inferred** roots (parents of indexed repos): those keep today's semantics verbatim — otherwise a repo living directly under `$HOME` plus a dotfiles `.git` in `$HOME` would emit `$HOME` itself as a garbage row and kill sibling scanning, violating the "unset key = exactly today's behavior" guarantee.

**Per root**, scan child directories (skip dotdirs; skip symlinked entries — `entry.isDirectory()` is false for symlinks under `withFileTypes` — at BOTH the child and the pool-grandchild level, today's behavior carried forward as a decision):

- child has `.git` (dir or file) → unregistered candidate named by its dir name (today's behavior). **The existing name-based skip (`knownNames.has(entry.name)`, `lib/repo-index.ts:147`) applies ONLY to this plain-candidate case** — it must run AFTER the `.git` probe decides the candidate kind, not before (today it gates the entry first, which is the restructure this ticket makes).
- child has NO `.git`, but at least one of the child's own children has `.git` → **worktree-pool folder** — **this rule applies under CONFIGURED roots ONLY, exactly like root-is-a-repo**: inferred roots keep today's semantics verbatim (plain children only, no pool detection), so with the key unset a pool slot reachable via an inferred root still emits under its flat `<slot>` name exactly as today — the "unset key = today's behavior" guarantee includes NAMES, not just membership. Under a configured root, each grandchild with `.git` is a candidate named **`<pool>/<slot>`** (e.g. `assured-dev/on-deck-1`). One extra level, only under `.git`-less children, only when at least one grandchild qualifies — no general recursion. **The pool folder's own name is NEVER checked against `knownNames`** — under Matt's convention the pool folder is named after the repo (`assured-dev/`), so a name-first skip would silence the pool rule in exactly the motivating case. Pool grandchildren dedupe by realpath'd path (which already excludes slots that are linked worktrees of an indexed repo) and by their composite name.

**Root ordering (determinism):** roots are processed configured-first (in the key's array order), then inferred (sorted). A directory reachable both as a configured root's pool grandchild and as an inferred root's plain child (pool folders ARE inferred roots — `dirname(worktrees[0].path)`, `lib/repo-index.ts:134`) is emitted exactly once, under the first-processed root's naming — configured-first makes the `<pool>/<slot>` composite the deterministic winner.

**Candidate dedupe is by path, then name.** As each candidate is accepted, its path and name are added to the `knownPaths`/`knownNames` sets, so a later root (or the same directory reached via two spellings) cannot re-emit it. Pool grandchildren that are linked worktrees of an indexed repo are already excluded via `knownPaths` (registered repos enumerate their worktrees via `git worktree list`, `lib/repo-index.ts:115`). The `<pool>/<slot>` composite name cannot collide with a plain repo name (it contains `/`), and two pools' same-named slots produce distinct composites; identical composites from aliased paths are caught by the path dedupe. Picker selection stays name-based (`commands/cd.ts:206`), so name uniqueness is the invariant this section exists to protect.

**Branch-label cap (performance guard):** candidates are collected across ALL roots first; if the total (children + pool grandchildren + root-is-a-repo candidates) exceeds 50, the per-candidate `git rev-parse` branch lookup is skipped for **all** candidates (all-or-nothing, uniform rows, no partial labeling). Under the cap, behavior is today's: one `git rev-parse` per candidate. This is the only git spawn the scan performs.

Candidate handling is otherwise unchanged: `registered: false`, dimmed row, real registration happens through `getRepoIdentity` when the user actually enters the repo.

**The composite name and dataDir — a real write hazard, fixed:** `KnownRepo.dataDir` is built as `repoDataDir(repoName)` (`lib/repo-index.ts:163` → `lib/rt-paths.ts:60`), and candidate dataDirs CAN be written: `commands/run.ts:782` assigns `selectedRepo.dataDir` from the unfiltered picker, and the preset/variation save paths (`run.ts:307` → `lib/run-presets.ts:94`; `run.ts:523` → `lib/variations.ts:84`) `mkdirSync` it. A raw `<pool>/<slot>` composite would therefore create junk NESTED INSIDE the registered pool repo's own data dir (`repos/assured-dev/on-deck-1/presets/`). Fix: for pool candidates, `dataDir = repoDataDir(name.replaceAll("/", "__"))` — a single path segment (`repos/assured-dev__on-deck-1/`), so any write lands in an isolated dir of its own, which is exactly the pre-existing contract for plain unregistered candidates (their dir-name dataDirs are equally writable today). The display/picker name keeps the readable `<pool>/<slot>` form; only the dataDir derivation sanitizes. A literal `__` collision in real dir names is theoretically possible and accepted. Readers that probe candidate dataDirs (`run.ts:201,391,479,975`) simply miss for never-written candidates, as today. Real registration still derives the repo name from the remote (`lib/repo.ts:71-73`), never from the composite.

### repos.json as disposable cache

- No format change (a JSON name→path map, `readJson`/`writeJson` as today).
- New honesty guarantee, documented in the module header: deleting the file loses nothing durable — entries regenerate through use, and the picker still surfaces everything under `rt.repoRoots` meanwhile.
- `getKnownRepos` already tolerates a missing file (`readJson` default `{}`, `lib/repo-index.ts:39`) — a test locks that in.
- Explicitly NOT in scope: an `rt repos rescan` verb, watching roots, or persisting scan results into the index (scan stays live-only; the index only ever records repos rt has actually been run in).

### Rollout

- Seed Matt's machine store through the CLI (exercising the write path): `rt settings set rt.repoRoots '["~/Documents/GitHub"]' machine` — valid because the scanner tilde-expands (above); `'["${home}/Documents/GitHub"]'` is equally valid.
- MAT-383/MAT-360 installer note (ticket comment, not code): the onboarding wizard should ask for/confirm the repos directory and seed this key.

## Non-goals

- No change to `updateRepoIndex` write timing or `getRepoIdentity` side effects.
- No change to picker UX beyond new rows appearing.
- No daemon involvement — discovery stays a CLI-side, on-demand scan (`getSetting` is sync and daemon-free, so it is callable from the sync `getKnownRepos`).
- No general tilde expansion in the resolver (scanner-local only).
- Symlinked children under a root remain invisible (status quo, restated above as a decision).

## Tests

Unit tests with temp dirs (bunfig HOME isolation per existing convention; PATH-faked `git` per the existing convention where spawn counting is asserted):

1. Key registry: resolves to default `[]`; a machine-store value resolves with provenance `machine`; a team-store copy of the key is ignored/refused by the resolver (machine-only scopes).
2. Tilde round-trip: seed `"~/..."` via the real write path, scan finds a git repo under it (locks finding-1's expansion decision end to end). `${home}` variant too.
3. Scan finds a plain git repo one level under a configured root.
4. Pool grandchildren: parent without `.git`, children with `.git` files → candidates named `<pool>/<slot>`, labeled unregistered.
5. Name collisions: two pools with same-named slots yield two distinguishable rows (distinct composites).
6. Root-is-a-repo: a configured root containing `.git` yields exactly one candidate (the root) and none of its children; a configured root that IS an already-indexed repo yields nothing (dedupe applies).
7. Duplicate roots: configured root equal to an inferred parent, plus a trailing-slash spelling of it → no duplicate rows.
8. Noise immunity: non-git dirs, dotdirs, files, empty pool-shaped dirs (no git grandchildren) produce nothing.
9. Dedupe: an indexed repo under a configured root is not duplicated; a pool grandchild that is a linked worktree of an indexed repo is not duplicated.
10. Cap: >50 total candidates (mix including a root-is-a-repo candidate) → all candidate branch hints blank, and the PATH-fake git counter shows no spawns BEYOND the per-indexed-repo `git worktree list` calls (`lib/repo-index.ts:75`) — construct with an empty index for an exact zero if simpler; ≤50 → hints populated.
11. Fail-open: an entry containing `${repoRoot}` → scanner warns, inference-only roots still returned, no throw. A non-string element and a nonexistent path each warn and are skipped, rest of the scan unaffected. A path whose `realpathSync` throws (EACCES/ENOENT after the exists check — TOCTOU) falls back to the resolved spelling, no throw.
12. Determinism: a pool folder that is both a configured root's child and an inferred root (its slots are worktrees of an indexed repo, plus one independent clone slot) → the independent slot emits exactly once, named `<pool>/<slot>`, regardless of map iteration order; the pool folder named after the indexed repo still pool-scans (the name-skip restructure).
13. Disposable cache: deleting repos.json → `getKnownRepos` still returns everything under the configured root (unregistered), nothing crashes; unset key + empty index = empty result, no crash.
14. Symlink-alias dedupe + spelling: a configured root reached via a symlinked path component (the `/tmp` → `/private/tmp` tempdir case) does not double-emit repos already known via their realpath spelling, AND the emitted candidate `path` begins with the configured (resolved, non-realpath'd) spelling — asserting the both-spellings rule, not just membership.
15. Inferred-root immunity: with NO configured roots, an indexed repo directly under a parent that itself contains `.git` scans exactly as today (parent is not emitted as a candidate, siblings still scanned), AND a pool slot reachable via an inferred root emits under its flat `<slot>` name (no composite, no pool detection) — both configured-only rules stay configured-only.
16. dataDir isolation: a pool candidate's `dataDir` is the sanitized single segment (`repos/<pool>__<slot>/`), never a path inside `repoDataDir("<pool>")`; a preset-save-style `mkdirSync(dataDir)` against it creates nothing under the pool repo's data dir.
17. Two-level symlink skip: a symlinked child under a root AND a symlinked grandchild inside a pool folder are both invisible to the scan.
