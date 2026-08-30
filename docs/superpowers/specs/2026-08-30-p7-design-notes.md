# Phase 7 design notes (RT-87, RT-89, RT-91 core, RT-88 rider)

Three design-judgment tickets plus one mechanical rider, all in the daemon
reconciler / cache-refresh seam. Each note states the options, the
recommendation, and (once the shepherd's question channel answers) the ruling
that was implemented.

## D1 - RT-87: distinguish a transient mount blip from an absent pool root in the miss-sweep

**Problem.** `reconcilePass` (`lib/daemon/reconciler/reconcile.ts`) sweeps
registry rows that git no longer lists: step (a) counts a "miss" per pass and
prunes the row after `MISSING_PRUNE_PASSES` (3). Today that sweep runs
unconditionally. A pool root on a network/removable mount (`root:
"/Volumes/Work/wt"`) that unmounts for 15+ minutes therefore accrues misses on
every live tree and prunes their registrations, taking claim/owner/state with
them (S063). The existing `rootsReadable` flag only gates `git worktree prune`,
not the sweep. The constraint that makes this subtle: `reconcile.test.ts:42`
registers a ghost under an absent `.worktrees` (the pool dir genuinely removed,
its parent repo dir present) and must still prune after 3 passes, so the sweep
cannot simply be skipped whenever a root is unreadable.

**Discriminator.** A removed pool dir and a vanished mount both give
`existsSync(root) === false`. They differ one level up: a removed pool dir
leaves its PARENT present (`.worktrees` gone, the repo clone present); a
vanished mount takes the mountpoint with it (`/Volumes/Work` auto-removed on
unmount). So a tree's miss is a HELD pass (no miss increment, no prune) when its
pool root is unreadable AND the pool root's own parent is also unreadable;
otherwise the miss counts normally. The ghost sweeps by construction (parent
present); a mount blip holds indefinitely while unreachable.

**Options.**
- **A (recommended): a held pass distinct from per-tree misses.** Add a
  predicate `root unreadable && parent-of-root unreadable` to step (a); a held
  tree skips its miss increment this pass. No new persistent state, no
  platform probe, keeps `reconcile.test.ts:42` green by construction. Candidate
  direction 3 from the ticket.
- **B: pool-root health marker file.** rt writes a sentinel in each root it
  owns; absence-with-parent-present means "root gone, sweep", unreadable-parent
  means "hold". More explicit but adds a file to write, seed, and migrate.
- **C: statfs / mount-table probe.** Query the OS mount table to decide whether
  the path is on a mounted filesystem. Most precise, but platform-specific and
  overkill for a failure mode already visible via `existsSync`.

**Ruling: A.** A blip takes out the whole subtree so the parent vanishes with
it, while a deleted pool dir keeps its parent, which preserves the ghost-prune
test by construction. Hold indefinitely (never prune live claim state for an
unplugged volume) and add a warn-level log line on each held pass naming the
root, so a permanently-lost mount is visible rather than silent.

## D2 - RT-89: review team-scope `ready` shell before execution

**Problem.** `ready` steps resolve through the settings ladder
(`lib/worktree/config.ts`), and a TEAM store rung can own the whole `ready`
array (arrays replace atomically at one winning scope). Those steps are shell
run unattended on every teammate's machine at worktree create/freshen/replenish
via `runReadySteps` (`zsh -lc`). A team member (or a compromised team store) can
therefore push arbitrary code that runs on every laptop. RT-89 wants the user to
review team-authored `ready` shell before it executes. The steps run in the
daemon, which is always non-interactive, so approval cannot be an inline prompt
there; it must be recorded out of band and merely CHECKED by the daemon.

**Options.**
- **A (recommended): one-time approval pinned per command-list hash, stored in
  user scope.** The gate applies only when the winning scope of the `ready`
  array is `team`/`team.repo`. The daemon runs team-authored steps only if the
  hash of the resolved ladder matches a recorded user-scope approval; on a
  mismatch it skips those steps and logs/emits a user-visible "team ready steps
  held pending approval, run `rt ...`" event (fail-closed). An interactive
  `rt worktree ready-approve <repo>` command shows the ladder and records the
  hash. When the team changes the ladder the hash changes and it re-gates
  automatically. Non-interactive callers (daemon, RT_BATCH, agents) never
  prompt: they check the recorded hash and refuse with a clear error. TOFU model
  (direnv `allow` / VS Code workspace trust).
- **B: allowlist setting.** User maintains an allowlist of permitted
  commands/patterns; a team step off the list is refused. More granular, higher
  maintenance, awkward for multi-word/parameterised steps.
- **C: refuse-by-default with `--trust-team-ready`.** Team steps never run
  unless a blanket flag/setting trusts them wholesale. Simplest, but a blanket
  trust does not re-gate when the team changes the shell (the exact risk).

New key follows `docs/settings-architecture.md` (registry entry, user scope,
repo-keyed). User-authored, machine-authored, and rt's own implicit-install
step are never gated.

**Ruling: A** (TOFU per ladder hash, user scope), plus two riders: (1) make the
held state discoverable beyond the event ... `rt worktree status`/`list` show
"team ready held pending approval" so a silently-skipped ladder is not a
mystery; (2) the `ready-approve` verb follows the repo's picker conventions ...
a TTY-gated prompt showing the full ladder text, and non-TTY/RT_BATCH exits with
the usage error and the hash it would approve.

## D3 - RT-91 core: thread an AbortSignal through the cache-refresh cycle

**Problem.** `makeCoalescer` (`lib/daemon/cache-refresh.ts`) clears the
`inFlight` latch at `REFRESH_CYCLE_DEADLINE_MS` (4 min) so the next tick is not
latched out, but `refreshCacheImpl` receives no cancellation: the stalled cycle
keeps walking repos, running git and GraphQL, until it settles on its own. Wave
1 only bounded the orphan COUNT (`maxOrphanCycles`); it did not stop a single
orphan from doing more work. RT-91 wants a cycle that hits the deadline to stop.

**Constraint.** The specific wedge (a half-open GitLab socket) lives inside
`refreshAllMRs` in `lib/enrich.ts`, which the sibling job `job/p7-residue` owns.
This job must not touch `lib/enrich.ts`, so it cannot abort that socket mid-call.
What it CAN cancel: cycle progression (stop advancing to further repos / the
post-loop doppler + broadcast work) and in-flight git subprocesses it owns.

**Options.**
- **A (recommended): coarse cancellation at cycle seams + git subprocess
  abort.** `makeCoalescer` creates an `AbortController` per cycle and aborts it
  at the deadline; `run` gains a `signal` parameter (callers may ignore it, so
  pollers.ts is unaffected). `refreshCacheImpl` checks `signal.aborted` at the
  repo-loop boundary and before the post-loop work, returning early; the signal
  threads into `runGit`/`listWorktreesAsync` (`lib/worktree/git-async.ts`, not
  fenced) so an in-flight git child is killed. Leaves the GitLab-socket wedge to
  the enrich.ts owner; the orphan cap still bounds those.
- **B: coarse cancellation only.** Check `signal.aborted` at loop seams; do not
  touch git-async. Smaller, but a wedged git child in the current repo runs to
  its own timeout.
- **C: deep threading into enrich.ts + git-async.** Truest cancellation (aborts
  the real socket wedge) but requires editing `lib/enrich.ts`, which
  `job/p7-residue` owns. Out of this job's fence; deferred to that owner.

**Ruling: A** (cycle-seam cancellation plus git-subprocess abort). Rider: keep
the seam threadable ... `refreshCacheImpl` carries the signal so a post-merge
follow-up can pass the same signal into `refreshAllMRs` without reworking the
seam. The integration brief notes that follow-up.

## D4 - RT-88 rider: per-scan reconciler deadline + wire `makeCoalescer` onRefused

Mechanical (no design question). Two deliverables:

1. **Per-scan reconciler deadline.** `worktree-reconciler.ts`'s `runOnce` has no
   deadline: a wedged pass (a multi-minute `pnpm install` that hangs) pins
   `inFlight` forever, so `withReconcilerHeld` (`repos:locate`) blocks for the
   pass's whole duration and follow-up kicks never fire (S094). Bound the
   `inFlight` latch with a deadline: release it after `RECONCILER_PASS_DEADLINE_MS`
   even if the pass has not settled (the wedged pass finishes in the background;
   the registry epoch guard + per-tree locks keep its late writes safe), fire a
   queued kick on release, and cap concurrent orphaned passes so a new one is
   refused (logged) rather than piling up.
2. **Wire `makeCoalescer` onRefused.** The two `makeCoalescer` call sites in
   `lib/daemon/pollers.ts` (port scan, process scan) omit `onRefused`, so a scan
   refused at the orphan cap is silent. Pass an `onRefused` logger to both,
   matching what `cache-refresh.ts` already does.
