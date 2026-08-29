# Phase 4: The destructive engine earns its paranoia

Design record for the worktree-engine hardening lane of the daemon stability
roadmap (Linear RT-81). The worktree engine is the one subsystem that creates,
freshens, kills processes in, and disposes git worktrees on a user's machine.
The audit found its guards protect rt's own recorded state but not the process
table, the filesystem, or a dropped database write. This spec covers the items
still open after roadmap waves 1 and 2 landed the mechanical halves, plus two
Linear tickets folded into the phase: RT-52 (.worktrees location) and RT-51
(recoverable disposal).

Audit source: `docs/daemon-stability-audit-2026-08.md`, "Roadmap > Phase 4",
with each finding's scenario, fix, and fixer notes in Appendix A. Findings in
scope: S017, S018 (4.1); S019, S064 (4.2); S025, R040, S063 (4.3); S078, S079,
RT-51 (4.4); S068, S056, S077, RT-52 (4.5).

## State on entry (re-verified against the base branch)

Waves 1 and 2 already landed: async lsof/ps through `runCapture`
(worktree-process-kill.ts), the per-repo create lock, kick queueing,
`isBusyError` matching `SQLITE_BUSY_*`, the reconcile epoch guard, and the
narrow S078/S079 guards (unconditional `ensureInfoExclude`, an epoch floor of
2020-01-01 ms, and a crash-sweep refusal of a `cfg.root` that is an ancestor of
the repo). Everything below is what a fresh read confirmed is still open.

## Ratified decisions

Five policy forks were put to the maintainer and locked before design:

1. **Pool root (RT-52):** move the default pool root out of the main clone to
   `<RT_DIR>/worktrees/<serialized-repo-identity>/`, where `RT_DIR` is
   `~/.mattstack/rt` (RT-46 removed `~/.rt`) and the directory name is the
   serialized wire identity per `docs/repo-identity.md`. Lazy migration: new
   trees use the new root, existing trees age out where they sit, the
   `worktrees.root` override is honored. Resolve paths through realpath so
   symlinked homes match lsof output.
2. **Recoverable disposal (RT-51):** keep retain + strip + 14-day reap, now
   under the new per-repo root, and add a durable per-entry manifest plus
   `rt worktree restore <name>`.
3. **Adopt (S056):** a foreign hand-made worktree is left `kind=unmanaged`; a
   new `--claim` flag opts a tree into ephemeral ownership.
4. **On-deck consent (S077):** flip the *unowned* `rt.worktreeApp` default to
   `enabled:false`, add a machine-scope onDeck ceiling and a free-disk
   precheck; surface the dormant state; file the team-scope `ready`-shell
   review as a follow-up.
5. **Endpoint liveness storage (S068):** a self-healing nullable `start_time`
   column on `endpoint_claims` added by a `PRAGMA table_info` guard outside the
   version gate (no SCHEMA_VERSION bump), with process start-time as the signal.

No SCHEMA_VERSION bump is taken anywhere in this phase. `TreeRecord` is a kv
JSON blob, so new fields on it are free; the one real DDL is the self-healing
`start_time` column. `lib/daemon.ts` is not expected to change; if a seam edit
proves necessary during implementation, it is raised first.

---

## Foundation: RT-52, the pool root moves out of the clone

The default root today is `join(repoPath, ".worktrees")` (config.ts
`sanitizeRoot`). Because the pool lives inside the main clone, a process whose
cwd is in a sibling ephemeral tree matches the main clone's cwd prefix (root
cause of S017), and disposal's `.trash` shows up as `?? .worktrees/` in the
user's git status (root cause of S078). It also violates rt's repo-stealth
principle: rt state belongs under `~/.mattstack`, never inside a target repo.

### The new root

- Add a `worktreesDir()` helper to `lib/rt-paths.ts` (the single source of
  truth for the layout) returning `join(rtDir(), "worktrees")`, a new
  top-level sibling of `repos/`, `logs/`, `tmp/`. Add
  `worktreePoolRoot(identity)` returning `join(worktreesDir(), identity)`.
- `sanitizeRoot` returns the per-repo pool root instead of `<repo>/.worktrees`
  when nothing is configured. The directory name is
  `serializeIdentity(await deriveRepoIdentity(repoPath))`, imported in-repo from
  `lib/settings/identity.ts` (never `@mattstack/rt-client`, which does not
  resolve here). The serialized wire form is slash-free by construction and a
  legal single path segment.
- **Async wrinkle:** identity derivation is async, but `sanitizeRoot` /
  `loadWorktreeRepoConfig` are sync today. The default-root derivation moves to
  the async call sites that actually create trees (create, replenish) rather
  than the sync config loader, or is seeded from a per-repo identity cache at
  the async seam. The plan resolves the exact shape; the constraint is that no
  sync path is forced to `await`.

### Realpath discipline

Every cwd-prefix comparison and every root the reaper is handed is resolved
through realpath before comparison, because lsof reports realpath'd cwds and
`~/.mattstack` (or `/var`) may be symlinked. A `safeRealpath` that degrades to
the literal path for a removed directory (the same helper identity derivation
uses) is applied to both sides.

### Lazy migration

Existing registry rows already store absolute `path` values, so no mass
`git worktree move` is needed. New creates use the new root; existing on-deck
and claimed trees are tracked, freshened, disposed, and reaped from their
current absolute paths until they age out naturally.

Two duties must cover both locations during the transition:

- The crash-leftover sweep (`reapRepoTrash`) already sweeps
  `<repo>/.worktrees` and (guarded) `cfg.root`. It gains the new per-repo pool
  root as a third swept location so legacy `.trash-*` under the clone is still
  reaped as it ages out.
- `retainedTrashRoot` moves from the hardcoded `<repo>/.worktrees/.trash` to
  `<cfg.root>/.trash`. For the default (out-of-repo) root this places retention
  under `<RT_DIR>/worktrees/<identity>/.trash`; restore never has to search the
  clone.

### info/exclude

`ensureInfoExclude(repoPath, ".worktrees/")` is only meaningful when a tree is
created inside the clone. It stays a no-op-safe call for the default
out-of-repo root and is retained for the override case where a user points
`worktrees.root` back inside the repo.

---

## Cluster 4.1: process-kill correctness

### S017 attribution guard (defense-in-depth)

`killWorktreeProcesses(worktreePath)` takes one path and kills every process
whose realpath'd cwd is inside it. With the default root moved out of the clone
(RT-52) the nesting that produced S017 no longer occurs for the default, but a
user who overrides `worktrees.root` back inside the clone must still be
protected. The guard:

- `killWorktreeProcesses` additionally accepts the set of *other* registered
  tree paths for the repo. Each candidate cwd is attributed to exactly one tree
  by longest matching registry-path prefix; a cwd owned by a different
  registered tree (or under `cfg.root` when the target is the main clone) is
  excluded from the target's kill set.
- The main-clone path is never itself a kill target that sweeps nested trees:
  `autoReturnMain` passes the sibling registry paths so its kill is scoped to
  processes actually rooted at the main clone and not at a nested tree.

Test: a fixture with a main-clone cwd plus a nested `.../worktrees/<other>/...`
cwd asserts the nested pid is excluded when the target is the main clone and
included when the target is that ephemeral tree. This exercises
`killWorktreeProcesses` end to end, which no current test does (only the pure
`selectKillTargets` filter is covered).

### S018 caller protection and the blocklist

Two independent fixes for the two call sites.

- **Interactive dispose:** thread the caller's pid through the IPC payload.
  `commands/worktree.ts` adds `callerPid: process.pid` to the dispose payload;
  the handler plumbs it into `DisposeDeps` and from there into
  `killWorktreeProcesses`' `protectedPids` (with descendants), so the daemon no
  longer SIGTERMs the very `rt` CLI that asked for the dispose before the reply
  is written.
- **Unattended reactor path:** there is no caller to protect, so the selector
  stops being a pure blocklist. The spared-binary set is widened beyond
  `SHELL_BINS` to include multiplexers (`tmux`, `screen`), remote shells
  (`ssh`, `mosh`), and terminal editors/pagers (`vim`, `nvim`, `emacs`, `less`,
  `man`). The full list of non-package-script targets is logged at `warn`
  before SIGTERM so an unexpected kill is diagnosable.

Test: `killWorktreeProcesses` protects a caller pid passed end to end (the
current suite only exercises `selectKillTargets` with a hand-supplied pid).

---

## Cluster 4.2: stash discipline in freshen

### S019 never pop a stash this pass did not push

- `stashChangesAsync` returns the git exit code / result instead of void, so
  callers can branch on whether the push actually happened. The
  `!!GitHub_Desktop<label>` marker stamping stays.
- `freshenOne` sets `stashName` only from a resolved `findDesktopStashAsync`
  marker **and** only when the push exit code was 0. The positional
  `stash@{0}` fallback is removed entirely. If the push failed, `freshenOne`
  calls `fail()` and returns without proceeding to the ff or the pop, leaving
  the user's working tree and any pre-existing stash untouched. A cleanliness
  re-check after the push (mirroring `autoReturnMain`) confirms the tree
  cleared before the ff.

Tests: (a) push fails with a pre-existing non-Desktop `stash@{0}` present,
assert no pop issued and the pre-existing stash survives; (b) push succeeds,
assert the pop targets the resolved Desktop name; (c) a grep-guard that the
positional fallback is gone.

### S064 do not stash the user's live main checkout

- The "is it still clean" decision moves to immediately before the merge,
  inside the lock, using the same `classifyDirtyAsync` blockers check candidacy
  used. For a `kind:"main"` tree, if blockers are non-zero the pass aborts
  (`fail()`, no stash, no merge, no ready steps) rather than stashing the user's
  live edits. The discard-only tidy reset stays.
- A failed `stash pop` is a hard failure of the freshen attempt: `fail()`, skip
  ready steps, and `emit(...)` a user-visible event (not just `log.warn`) so
  the tray/CLI/chat can tell the user their edits were stashed and did not
  reapply, naming the stash to restore.
- Idle-main freshen and its ready steps are gated behind the same
  `rt.worktreeApp.enabled` consent established in Q4 (S077), so a machine that
  never opted into pool management never touches the user's main checkout.

---

## Cluster 4.3: registry writes are critical

### S025 critical-write path for registry and claims

- `saveRegistry` (registry.ts) and `saveClaims` (endpoint/store.ts) route
  through `runCriticalWrite` instead of the warn-and-drop `persistOrWarn`, and
  return a success boolean. This needs a critical write entry point at the kv
  and endpoint-claims layer (`setKvValue` currently wraps in `persistOrWarn`;
  add a critical variant rather than changing the shared one).
- The epoch is bumped only after a confirmed-successful write, never after a
  swallowed one, so a dropped write cannot fabricate a false conflict for
  concurrent reconcile passes.
- Destructive callers abort on `false`: the create final flip (create.ts does
  not return `{ok:true}` on a failed persist... it retries or leaves the row
  `creating`, never releases into an unlocked `creating` state); the provision
  claim write (handlers/worktree.ts aborts and rolls back rather than
  proceeding to checkout); the dispose registry filter.
- Reconcile's idempotent step-(c) save self-heals from git ground truth next
  pass, so it keeps a deferrable path: `saveRegistry` returns the boolean and
  the idempotent caller may ignore it while the non-idempotent create-flip and
  provision-claim callers must not.

Test: inject `SQLITE_BUSY` on the flip / claim write via the reconciler's
`onAfterLoad` seam and a busy-injecting db stub; assert the completed tree is
not scrapped and the claimed tree is not re-handed.

### R040 dispose re-reads under the lock

`disposeTree` takes a `TreeRecord` snapshot captured before the lock. Inside
`withTreeLock`, it re-reads `findByPath(loadRegistry(repoName), rec.path)` and
refuses with a `changed` outcome unless `kind`, `state`, `branch`, and `owner`
still match the snapshot, so a tree the reactor disposed and replenish
re-created at the same path between collection and lock is not killed on stale
grounds. Applied to both call sites (the dispose loop and the adopt loop in
handlers/worktree.ts).

### S063 a missing path is a hold, not a prune

- `git worktree prune` is not run unconditionally every pass. It is skipped for
  a repo whose pool root is currently unreadable, and the reconcile absence
  check distinguishes "git ground truth says gone" from "stat failed this
  pass" (the `listWorktreesAsync` result is already `existsSync`-filtered, so
  the registry-side fix is required regardless).
- A registry row whose path is absent for a pass is marked with a hold
  (`missingSince` / a miss counter on `TreeRecord`, a free JSON field) rather
  than deleted, and is only pruned after N consecutive missing passes. When the
  path returns, the hold clears.
- `scrapTree`'s collision-cleanup path gains a guard: it refuses to `rm -rf` a
  directory it did not create unless it is confirmed to be a git worktree with
  no unexpected extra content, closing the data-loss vector once the registry
  desyncs.

Test: a worktree path returns `existsSync === false` for one pass; assert the
registry row survives N-1 misses and the row is only dropped after the
threshold.

---

## Cluster 4.4: trash, reap, and recoverable disposal

### S078 / S079

Already closed by the narrow guards that landed in wave 1 (unconditional
`ensureInfoExclude`, the 2020 epoch floor, the ancestor-of-repo sweep refusal).
RT-52 relocates the retention root out of the clone, which removes the
`?? .worktrees/` pollution for the default case entirely. No further change is
required beyond keeping the guards intact as the root moves.

### RT-51 recoverable disposal

Two real losses in one week destroyed gitignored, human-authored files
(`.local-dev/` specs and plans) because the dispose guard only protects
unmerged git commits. The retain + strip + 14-day reap already softens the
reap; what is missing is a durable record and a recovery verb.

**Manifest.** At dispose time, a small `manifest.json` is written *inside* the
retained entry (so it survives even if `state.db` is quarantined), recording:
original path, tree name, branch, head SHA, disposal reason, disposedAt, and
keptUntil. An optional kv index mirrors these for fast `restore --list` without
a directory scan; the manifest is authoritative and the index is a convenience.

**`rt worktree restore <name>`** (and `restore --list`):

- Rehydrates the retained tree into the Phase-4 root (RT-52), re-registers the
  registry row, and re-runs the ready steps for the stripped-out reinstallable
  dirs (`node_modules`, `dist`, `.turbo`, `dist-*`).
- The branch is recreated from the manifest's recorded head SHA if it no longer
  exists; if the branch now exists elsewhere, restore refuses and reports
  rather than clobbering it.
- The reaper honors `keptUntil` from the manifest; a successful restore clears
  the entry's retention so it is not reaped out from under the user.
- The verb follows the omit-args-to-picker convention: the required positional
  declares `omitBehavior` in `lib/command-tree-def.ts`, the picker gates on
  `process.stdin.isTTY && !json && !process.env.RT_BATCH`, and the module is
  registered in `lib/module-registry.ts`. `bun run picker:check` and
  `docs:gen`/`docs:check` are part of verification. Registry mutation goes
  through a new `worktree:restore` daemon handler (inherits `handleCommand`), so
  the daemon's in-memory registry and reconciler stay consistent, exactly like
  adopt and dispose.

---

## Cluster 4.5: claims and adoption

### S068 endpoint claim liveness

- A nullable `start_time` column is added to `endpoint_claims` by a
  `PRAGMA table_info` guard that runs from the shared db open path (the
  `addSectionsColumnIfMissing` precedent), so both the daemon and CLI writers
  see it, with no SCHEMA_VERSION bump.
- The signal is the process start-time (captured at claim time via a small
  `ps`/sysctl probe), which catches pid reuse with and without a reboot.
  `isLiveClaim` treats a claim as live when the port is listening, or the pid
  is alive and the recorded start-time matches. A recycled pid (start-time
  mismatch) reads as dead.
- **Legacy rows:** a NULL `start_time` (written before this change) is
  unverifiable, so the claim is trusted only if the pid is alive AND the row is
  younger than a named TTL constant... belt and braces so a pre-change stale
  claim cannot pin a port forever.
- `rt endpoint release <worktree>` ships as the manual escape hatch (the daemon
  `endpoint:release` handler already exists; this adds the CLI verb that sends
  it), with `omitBehavior` declared and the `isTTY && !json && !RT_BATCH`
  picker gate.

### S056 adopt

- `reconcileRepoRegistry` already stamps an unknown git worktree as
  `kind:"unmanaged"`. The adopt handler stops promoting a foreign, hand-made
  tree to `kind:ephemeral, state:claimed, disposal:merge`; it leaves it
  `unmanaged` so the reactor never freshens, kills, or disposes it.
- A new `--claim` flag (threaded through `parseAdoptArgs`, the payload, and the
  handler) is the explicit opt-in that takes ownership: a claimed tree becomes
  `ephemeral` with `disposal:merge`. The flag's help text is spelled out
  plainly (the repo forbids magic syntax).
- Adopt output names each tree's resulting kind so the user sees what rt will
  and will not touch; `--json` carries the same field; `docs:gen`/`docs:check`
  cover the new flag. The existing handler test that asserts the old ephemeral
  promotion flips to assert `unmanaged`.

### S077 on-deck consent

- The *unowned* `rt.worktreeApp` default flips to `enabled:false`
  (`APP_CONFIG_DEFAULTS`), using the existing `probeAppConfigStore` ownership
  latch so machines that already enabled pools explicitly are unaffected. A
  machine that never opted in does not build a team-declared pool.
- `replenishAndShrink` gains a machine-scope onDeck ceiling that clamps
  `cfg.onDeck`, and a free-disk precheck before each `createTree`. The disk
  threshold is a named constant with a one-line rationale.
- Dormant surfacing: when a team store declares a pool the machine has not
  opted into, `rt daemon status` and `rt worktree list` say the pool is dormant
  and print the exact `rt settings` command that enables it, so a new member is
  told rather than surprised.
- The team-scope `ready`-shell arbitrary-execution concern (a supply-chain
  shaped risk: shell from a shared settings file run on every member's machine)
  is filed as a follow-up ticket in the report Notes. The dormant-until-opt-in
  gate already stops those steps from running unprompted, so it is not folded
  into this phase.

---

## Testing strategy

Every behavior change lands with a test, TDD where the seam allows:

- Kill attribution and caller protection: `killWorktreeProcesses`-level tests
  (nested-tree exclusion, caller-pid protection end to end).
- Stash: the three S019 cases plus the S064 abort-not-stash and
  failed-pop-emits-event cases.
- Registry writes: busy-injection at the flip/claim seam asserting no scrap /
  no re-hand; the R040 stale-snapshot refusal; the S063 N-pass hold.
- RT-51: manifest round-trip, restore rehydration, branch-exists-elsewhere
  refusal, keptUntil honored and cleared.
- S068: start-time match/mismatch liveness, NULL-row TTL fallback, the release
  verb picker conformance.
- S056/S077: adopt leaves a foreign tree non-disposable; a team-only onDeck
  declaration on an unowned machine stays dormant and surfaces the enable hint.

Full verification gate (from the job brief):

- `bun test lib commands packages scripts` green
- `bunx tsc --noEmit` zero errors
- `bun run picker:check` green (command tree changes)
- `bun run docs:gen` then `bun run docs:check` green, regenerated reference
  committed (command surface changes)
- `scripts/repo-purity.sh` green
- `bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/daemon.test.ts`
  green plus worktree-verb e2e coverage
- `packages/rt-client` `bun run build` if it was touched

## Out of scope and follow-ups

- Team-scope `ready`-shell local review before execution (S077 rider): its own
  ticket.
- Phase 5 module-boundary restructuring of the reconciler is explicitly not
  done here; `lib/daemon.ts` edits stay minimal and are raised before landing.
- S015/S016 sync-lsof mechanics already moved by wave 1.
