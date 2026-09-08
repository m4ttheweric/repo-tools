# Converging Claude's plugin cache with the team clone

2026-09-07 (revised 2026-09-08). MAT-410. The team clone pulls new pack versions
and the installed Claude plugin stays stale, so pack releases silently never
reach the people using them. Every claim about the `claude` CLI below was proved
by running it (2.1.263) against a fixture directory marketplace in an isolated
HOME; the probe results are in "Evidence".

## Problem

`~/.mattstack/teams/<slug>` is registered with Claude Code as a `directory`
marketplace, and the pack is installed from it as `<plugin>@<marketplace>`.
Installing copies the pack into
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`. The MAT-405 snapshot
daemon now fast-forwards that clone every few minutes, but nothing re-reads it
into the cache. Observed on the owner's own machine when MAT-410 was filed:
clone at pack 0.5.20, installed plugin 0.5.18.

Three further facts, all verified in the code:

**`rt setup status` cannot show it.** The `pack.<pack>` row is built from
`readPackRequirements`, which finds packs by locating a `requirements.jsonc`
under the clone. ClaimView's pack ships none, so there is no `pack.claimview`
row at all, and the rows that do exist report `installed` with no version.

**The enable state underneath it is already wrong.** `plugins.install` enforces
the installed-never-enabled ruling by skipping the `claude plugin enable` call
for team-authored plugins. But `claude plugin install` enables the plugin by
itself: install alone into a clean HOME yields `enabledPlugins: {<id>: true}`.
The only test covering this asserts that the `enable` argv is absent, so it stays
green while the outcome is wrong.

**`rt setup apply` re-enables a pack the member deliberately turned off.**
`pluginsInstallRun` runs `claude plugin install` unconditionally, including for
plugins already present, and install on an installed-but-stale plugin flips
enablement back to `true`.

## Evidence

claude 2.1.263, isolated HOME, fixture directory marketplace with a one-skill
pack:

| Probe | Result |
| --- | --- |
| `claude plugin install <id>` into a clean HOME | version installed, `enabledPlugins[<id>] = true` |
| `claude plugin disable <id>`, bump the source version, `claude plugin update <id> -y` | version moves, `enabledPlugins[<id>]` stays `false` |
| `claude plugin update` with no prior `claude plugin marketplace update` | picks up the new version; a directory source needs no refresh step |
| `claude plugin install` on an installed-but-stale plugin | version moves **and** enablement flips back to `true` |
| `claude plugin update` when already current | exit 0, "already at the latest version" |
| `claude plugin update` for a plugin that is not installed | exit 1, stderr `Plugin "<name>" not found` |
| `claude plugin list --json --available` after a source bump | `available: []`, so it cannot detect the newer version |
| `claude plugin disable <id>` on an enabled pack | exit 0 |
| `claude plugin disable <id>` on an already-disabled pack | exit 1, stderr `is already disabled` |
| `claude plugin disable <id>` on a pack that is not installed | exit 1, same `is already disabled` line |
| `claude plugin uninstall <id>` on an installed pack | exit 0, `Successfully uninstalled`; the pack's `enabledPlugins` entry is removed too, so a rollback leaves no trace |
| `claude plugin uninstall <id>` on an already-absent pack | exit 1, stderr `Plugin "<id>" not found in installed plugins` |
| `claude plugin uninstall <id>` on a plugin that never existed | exit 1, same `not found in installed plugins` line |

That uninstall phrasing matches `isAlreadyGone` (`uninstall.ts:210`) through its
`not found` alternative, so the rollback reuses that matcher rather than adding
one. The two editor-specific alternatives in that regex are inert here.

**Measured against the real pack**, not the fixture: `claimview@assured` from
`~/.mattstack/teams/claimview` (1.1 MB, 106 files across `skills/`,
`attachments/`, `pack/`, `scripts/`), installed into a throwaway
`CLAUDE_CONFIG_DIR` so the live install was untouched:

| Command | Elapsed |
| --- | --- |
| `claude plugin marketplace add <clone>` | 0.47 s |
| `claude plugin install claimview@assured` | 0.86 s |
| `claude plugin disable claimview@assured` | 0.40 s |
| `claude plugin uninstall claimview@assured` | 0.41 s |

A directory-source install is a local copy, so it scales with pack size rather
than with the network, and the largest real pack lands in under a second. The
30 s settlement timeout below is derived from that number: roughly 35x the
measured worst case, which absorbs a much larger pack or a loaded machine while
still leaving the budget arithmetic intact.

Three consequences drive the design. The converge verb is `update`, never
`install`, because only `update` preserves the disabled state. The served version
must be read from the clone on disk, because the CLI will not report it. And
`update`'s own not-found failure is a reliable proof that a plugin is absent,
which gates every `disable`.

## Alignment with the owner/member split

Ruling of 2026-09-07: only the owner writes team settings, members are pull-only,
and member daemons never push the team repo. This design sits entirely on the
member-safe side. Its trigger is the pull edge, the half of the snapshot engine
that stays alive when the push half is refused, and its only write is to
`~/.claude` on the local machine. It writes no team scope, pushes nothing, and
needs no forge write.

## Design

### Trigger: the pull that moved HEAD, from the timer and boot only

`doPull` classifies its outcomes, and exactly two mean HEAD moved:
`fast-forwarded` and `rebased`. `conflict` aborts the rebase and restores the
prior HEAD; `up-to-date` and `skipped` never move it.

`SnapshotSpec.pull` gains one optional field:

```ts
pull?: {
  intervalSec: number;
  /** Fired after a pull that moved HEAD, outside the git lock. */
  onPulled?: (outcome: "fast-forwarded" | "rebased") => Promise<void>;
};
```

`pullNow` awaits it after `withGitLock` releases: outside the lock, because the
hook shells out to `claude` and holding the git lock that long would block the
commit cycle; awaited rather than fire-and-forget, so a test that awaits
`pullNow()` observes the converge deterministically instead of racing it.

**The push path does not fire it.** `doPushInner` calls `pullNow()` before every
push (`home-snapshot.ts:866`) to avoid diverging, not to react to content. That
pull is inside `pushInFlight`, so a converge there would delay every push by the
length of a plugin install, and any converge stall would wedge the push path on
owner machines. `pullNow` therefore takes `{ converge?: boolean }`, defaulting to
true, and `doPushInner` passes `converge: false`. Nothing is lost: the timer pull
converges the same clone within one interval.

The converging callers are the interval timer, the boot pull `init()` already
fires (so a clone that moved while the daemon was down converges at start), and
the explicit `team:pull` daemon verb.

**One converge can be skipped by coalescing, and that is acceptable.** `pullNow`
returns the in-flight promise when a pull is already running, so a timer tick
landing during a push-path pull gets that pull's result and runs no converge of
its own. The clone is still current; only the cache waits, and the next interval
converges it.

The home spec has no `pull` field at all, so the home repo is untouched, and the
engine stays pack-agnostic.

### Bounding the hook, so a hung `claude` cannot kill the pull loop

`execWithTimeout` awaits its collected output unconditionally when no `timeoutMs`
is given (`probes.ts:118-122`), so a `claude` that never exits hangs forever.
`schedulePull` re-arms only in the `.finally` of `pullNow`
(`home-snapshot.ts:679-682`), so a hung hook would stop that clone's pull loop
for the life of the daemon, silently.

- **Per-exec:** every `claude` call the converge makes passes
  `timeoutMs: PACK_EXEC_TIMEOUT_MS` (60_000, the value `plugins.install` already
  uses). A timeout surfaces as exit code 124, the repo's convention, and is
  recorded as `failed` for that pack. It is never recorded as success, and never
  as "not installed".
- **Per-converge:** a whole-run budget of `CONVERGE_BUDGET_MS` (120_000). When it
  is exhausted, the remaining packs are recorded as `skipped` with reason
  `converge budget exhausted` and the run returns. The next pull retries them.
- **A settlement is atomic with respect to the budget.** The budget is checked
  before a settlement begins and never between its steps, so the run can never
  abort after `install` with nothing left for `disable` or the `uninstall`
  fallback... which would leave exactly the installed-and-enabled third state the
  invariant forbids. A settlement that does not fit in the remaining budget is
  skipped whole, with the distinct reason `settlement did not fit the remaining
  budget`: nothing is installed, the pack stays absent, its row says `missing`,
  and the next pull retries it. The two skip reasons stay distinguishable because
  they call for different reads... one says the converge ran out of time overall,
  the other that this pack alone could not be settled safely.

**The arithmetic, since the invariant and the client ceiling must both hold.**
A settlement is at most three execs, so its execs take a shorter timeout than the
rest of the converge:

```
SETTLE_EXEC_TIMEOUT_MS  30_000   (install, disable, uninstall)
SETTLEMENT_MAX_MS       90_000   = 3 x 30_000, the worst-case settlement
CONVERGE_BUDGET_MS     120_000   >= SETTLEMENT_MAX_MS, so one always fits
PACK_EXEC_TIMEOUT_MS    60_000   (the listing and update, which need no rollback)

a settlement starts only while remaining budget >= SETTLEMENT_MAX_MS
worst-case round trip = FETCH_TIMEOUT_MS 30_000 + CONVERGE_BUDGET_MS 120_000
                      = 150_000 <= PULL_TIMEOUT_MS 180_000   (30s headroom)
```

At 60s per exec a single settlement could reach 180s and breach both the budget
and the client ceiling, which is why the settlement's calls are capped at 30s
rather than sharing `PACK_EXEC_TIMEOUT_MS`. The consequence is that a converge
spending most of its budget on slow updates may defer settlements to the next
pull, which is the intended trade: deferring is safe, aborting mid-settlement is
not.

Together these cap the hook's contribution to `pullNow`, so `schedulePull` always
re-arms. The hook's own `catch` guarantees a throwing converge cannot turn a
successful pull into a failure.

**The budget has a ceiling that is not arbitrary.** `rt team pull` gives the
`team:pull` verb a 180_000 ms client timeout (`commands/team.ts:164`), and that
round trip already spends up to `FETCH_TIMEOUT_MS` 30_000 on the fetch
(`home-snapshot.ts:166`). 30s plus the 120s budget leaves 30s of headroom. The
budget must never be raised past that without raising `PULL_TIMEOUT_MS` first.

### Converge: `lib/setup/pack-cache.ts`

A new module beside `base-plugins.ts`, and for the same reason: the daemon
supervisor, the setup step and the status validator all need it, and none of them
may import a setup step.

```ts
export interface ServedPack { id: string; name: string; servedVersion: string | null }
export interface InstalledPack { id: string; version: string | null; enabled: boolean }
/** `error` is non-null only for a marketplace.json that exists and did not parse. */
export interface ServedPacks { packs: ServedPack[]; error: string | null }

export function readServedPacks(p: Probes, slug: string): ServedPacks

export interface ConvergeResult {
  updated: { id: string; to: string | null }[];
  installed: string[];
  /** Installed, then disable failed, so the install was undone. */
  rolledBack: { id: string; detail: string }[];
  current: string[];
  skipped: { id: string; reason: string }[];
  failed: { id: string; detail: string }[];
}
export async function convergePackCache(p: Probes, slug: string, log: Logger): Promise<ConvergeResult>
```

`convergePackCache` walks the same `claudeConfigDirs(p, [])` list and passes the
same `CLAUDE_CONFIG_DIR` env as `plugins.install`, so the two agree about which
Claude installs they manage.

**The per-pack sequence.** A read-only listing decides whether to act at all;
`update`'s own not-found failure proves absence before anything is installed.

```
listing = claude plugin list --json          (read-only, once per config dir)
  failed or unparsable -> every pack recorded `failed`, NO write of any kind

per pack:
  listed, both versions known and equal  -> current      (no exec at all)
  listed, either version unknown         -> skipped      ("version unknown")
  otherwise                              -> update <id> -y
        exit 0                  -> updated. Enable state untouched.
        exit != 0, "not found"  -> absent: install, then settle enablement
        exit != 0, otherwise    -> failed, recorded with stderr
```

The listing is what makes "a pull that changes no pack version issues no
`update`" achievable: without it, nothing knows the installed version. It is
read-only, so it gates writes without ever authorizing one.

**"Version unknown" and "absent" are different states and must not be
conflated.** A pack the listing carries with a null version is installed, and is
skipped. A pack with no entry at all is not installed, and takes the
update-then-install branch. Collapsing the two would drop the ruling that a pack
added after a member joined installs on the next converging pull, because every
such pack arrives with no listing entry.

**Cost of the absence probe:** on a fresh machine every pack is absent, so each
costs one deliberately-failing `update` per config dir before its `install`. That
is a handful of fast, immediately-returning calls on the one run where nothing is
installed yet.

### Settling enablement: install, then disable, else roll back

A team-authored pack must never be left installed and enabled, because
`claude plugin install` enables what it installs and the ruling says a joined
team does not get to grant itself execution. Rather than remember a failed
`disable` and retry it later, a failed `disable` **undoes the install**:

```
install <id>
  exit 0                              -> proceed to disable
  exit != 0, isAlready                -> pre-existing: record current, leave
                                         enablement alone. STOP.
  exit 124 (timed out)                -> AMBIGUOUS: uninstall <id>, then record
                                         failed (failed-rollback if that fails).
                                         Never disable.
  exit != 0, otherwise                -> failed. STOP: no disable, no uninstall.

disable <id>
  exit 0                              -> done: installed and disabled
  exit 1, "already disabled"          -> done: the goal state already holds
  anything else (incl. unknown subcommand, timeout)
                                      -> uninstall <id>      (roll back)
        uninstall ok, or already gone -> rolledBack, recorded
        uninstall also fails          -> failed, logged at warn
```

**Install needs its own exhaustive branch, and a failed install must never reach
`disable`.** Per the Evidence table, `disable` on a pack that is not installed
exits 1 with `is already disabled`, which the branch above classifies as done. So
a fall-through from a failed install would record that pack as installed and
settled when nothing was installed at all.

**A clean failure is terminal; a timeout is not, because it is ambiguous by
construction.** `execWithTimeout` sends SIGTERM and then SIGKILL, so an install
killed after it wrote `installed_plugins.json` and the `enabledPlugins` entry but
before exiting leaves the pack installed and enabled: the forbidden third state,
reached without any command reporting success. Exit 124 therefore attempts an
`uninstall` before recording `failed`. That is safe in both directions, because
`isAlreadyGone` absorbs the case where nothing was written after all, and it
still never reaches `disable`. It also fits: install plus uninstall is two 30 s
calls inside the 90 s a settlement reserves.

**An `isAlready` install is a pre-existing pack, and rt leaves it alone.** That
branch is reached only when the listing showed the pack absent and `update` said
not-found, so the pack appeared underneath this run. The rollback's safety
argument ("this run installed it moments ago") does not hold there, and rt's rule
is that it disables only what it installed. The pack is recorded `current` with
its enablement untouched. The practical consequence is that a pack enabled on a
machine before this change stays enabled, which is correct: it is
indistinguishable from a deliberate enable, and stomping it is the thing this
design forbids.

The invariant is therefore structural rather than bookkept: **after any run a
team pack is installed-and-disabled, or not installed. There is no third state**,
so nothing needs to be persisted, reconciled across processes, or retired later.

The rollback is clean rather than destructive: this same run installed the pack
moments earlier, so undoing it restores the machine to exactly its pre-run state.
It reuses the `claude plugin uninstall` exec that `uninstall.ts:256` already runs
(`:245` is that function's `readSetupState`), and tolerates an already-gone pack
through the existing `isAlreadyGone` (`uninstall.ts:210`).

**What `SetupState.plugins` records.** `plugins.install` appends every computed
plugin unconditionally today (`plugins.ts:193`), which would record a rolled-back
pack as installed. It records only the packs that ended the run installed, so a
rolled-back pack is absent from it and `rt setup uninstall` is not asked to
remove something that is not there.

The converge does not write `SetupState` at all, keeping that file single-writer.
A pack the daemon installed first is therefore not listed there, so
`rt setup uninstall` will not remove it until the next `rt setup apply` records
it... which that run does, since it recomputes and records every pack it settles.
The gap closes on the next apply rather than persisting.

A rolled-back pack surfaces through the honest `missing` row that already exists,
and the next converging pull retries install-then-disable by construction, with
no retry machinery of its own.

An old `claude` build with no `disable` subcommand therefore never installs a
team pack at all: it rolls each one back and the row says `missing`. That is the
intended reading of the ruling. Not installing is the safe failure; installing
something enabled that rt promised would not be is not.

**Accepted tradeoff, stated plainly:** if the `uninstall` also fails, the pack is
left installed and enabled, recorded `failed` and logged at `warn`, and nothing
retries it automatically. A member can clear it with `claude plugin disable`.

And the durable surface does not carry that fact. Without persisted state, an
installed-and-enabled pack is indistinguishable from one the member enabled
deliberately, so `rt setup status` renders it `ready ... installed and enabled`,
not as a failure. The failure lives only in that converge's result and its `warn`
line in the daemon log. So the honest description of the cost is: a double
failure of two independent commands leaves a pack enabled that rt promised not to
enable, visible in the log at the time and nowhere afterwards. Making it visible
later is exactly the persisted-state machinery this design deleted, and buying it
back for a double-failure case is the trade being declined.

### Reading what the team serves

`readServedPacks` reads `<clone>/.claude-plugin/marketplace.json` and, for each
entry, the `plugin.json` at its `source`:

| Input | Result |
| --- | --- |
| file absent | `{ packs: [], error: null }`. A clone rt does not own yet is not an error, matching `readTeamMarketplace` today. |
| file unparsable | `{ packs: [], error: "<path> did not parse" }`, rendered as an `error` row. The team authored it; its packs must not vanish silently. |
| entry `source` is a string | resolved relative to the clone root; its `plugin.json` `version` is the served version. |
| entry `source` is object-form (github, url) | pack listed, `servedVersion: null`. |
| `plugin.json` missing or unparsable | pack listed, `servedVersion: null`. |

**Null-version comparison is defined:** a pack whose served or installed version
is null is never treated as stale and never triggers an update. Unknown is not a
mismatch. It renders as `version unknown` and the converge records it `skipped`.

### The parser, shared not duplicated

`validators/tools.ts` already parses `claude plugin list --json` with a
deliberate strictness contract: any element missing a string `id` rejects the
whole payload, while a missing `enabled` normalizes to `false`. That parser moves
into `pack-cache.ts` and gains `version`; `validators/tools.ts` imports it. The
contract and its tests are preserved exactly; the change is additive.

Both the converge and the status row read this listing, for different ends.
Neither may write on a listing it could not read: the converge records `failed`,
the row renders an honest `error`.

### Wiring

`teamSnapshotSpec` takes `onPulled` in its opts and passes it through.
`startTeamSnapshots` supplies it and already holds everything needed: `probes`
(from `createRealProbes()`), the slug, and the per-clone child logger.

**A known environment divergence, named rather than hidden.** `claudeConfigDirs`
reads `CLAUDE_CONFIG_DIR` from the process env. The daemon's env is launchd's,
not the user's shell, so a user who sets that variable in their profile has the
CLI managing one config dir and the daemon converging another. The converge logs
which config dir it acted on, and the status row reports the dir the CLI sees, so
the two can be compared instead of quietly disagreeing. Reconciling them is out
of scope here.

### Surfacing: the pack rows

`toolRows` gains the team slug through its `opts` argument; `composePlan` has
`team.slug` in hand at the call site (`plan.ts:145`, used at `plan.ts:157`).

`packRow` is rebuilt around the union of two sources, keyed by pack name so each
pack yields exactly one row: packs discovered by `readPackRequirements` (whose
`.error` row is preserved unchanged), and packs the team marketplace serves,
which is how ClaimView gets a row at all.

| Condition | Status | Detail |
| --- | --- | --- |
| marketplace.json unparsable | `error` | `<path> did not parse` |
| not installed | `missing` | installed by Install (plugins.install) |
| installed, versions match, not enabled | `ready` | `<v> installed, not enabled ... claude plugin enable <id>`, plus the restart caveat |
| installed, versions match, enabled | `ready` | `<v> installed and enabled`, plus the restart caveat |
| installed, versions differ | `needs-you` | `installed <a>, team serves <b>` |
| either version unknown | `ready` | `<v> installed, served version unknown` |

**The restart caveat sits on the converged row, not the stale one.** On a stale
row the cache itself still holds the old version, so a restart changes nothing
and the caveat would mislead. It belongs where the cache has already moved and
only the running process is behind: `a Claude session started before this version
landed uses the old cache until it restarts`.

A disabled team pack is `ready`, not `needs-you`: under the ruling that is the
correct state, and the row's job is to name the one command that turns it on. A
stale row is `needs-you` with the existing `rt setup pack` action, because the
daemon converges automatically, so a row still stale when a human reads it means
the automatic path did not work.

### The install path

`plugins.install` stops calling `claude plugin install` unconditionally and calls
the same `pack-cache.ts` per-pack sequence instead, so the enable rule, the
update-not-install rule and the rollback live in exactly one place. For trusted
plugins the `enable` call follows as it does today; for team-authored plugins it
stays skipped and the disable-or-roll-back settlement applies.

This is what stops `rt setup apply` re-enabling a pack the member deliberately
turned off: an already-installed plugin now takes the `update` path, which
preserves enablement, and never the `install` path, which does not.

**The step's failure contract is unchanged.** `pluginsInstallRun` today returns
`{ state: "failed", detail, remedy: RETRY_REMEDY }` and stops on the first
non-zero, non-`isAlready` result (`plugins.ts:174-176`). A failed `update` and a
failed `install` both keep exactly that. A rollback is not a step failure: the
pack is honestly absent and the row says so, which is the same outcome as a pack
that was never installed. Only a failed rollback is recorded as a step failure,
because that is the one case leaving state rt promised not to leave.

Inside the daemon converge nothing fails a pull: entries are recorded in the
result and logged at `warn`, and the next converging pull retries.

### Logging

The converge logs one domain event per team clone per converging pull, naming
what moved, what rolled back, and which config dir it acted on, at `info`;
nothing when there was nothing to do. Failures, timeouts and rollbacks log at
`warn` with `{ err }`.

The hook's own `catch` is the logging seam for this path, and the spec says so
because the usual one does not apply: `handleCommand` covers daemon commands, and
a timer-driven pull is not one.

### No new setting

`rt.teamSnapshot.enabled` already disables the whole engine including its pulls,
so a kill switch for the converge exists.

## Testing

**Unit, always run.** The converge and step tests run against a temp HOME with a
fake `exec` that models the proved claude semantics by writing a real
`settings.json` and `installed_plugins.json` (install writes `enabled: true`,
disable writes `false`, update leaves enablement alone and moves the version,
uninstall removes the entry). Assertions read those files, so the outcome is
literal. The existing argv-absence test in `steps-c.test.ts` is replaced, because
an argv assertion cannot fail when the outcome is wrong, which is how the current
defect stayed green.

Cases that must be covered because the design turns on them:

- a converge with no version change issues no `update`;
- an unreadable or unparsable listing performs no write of any kind;
- a stale pack updates and keeps its disabled state;
- a served-but-absent pack installs and ends **disabled**;
- the rollback path, in all three of its outcomes: disable ok leaves the pack
  installed and disabled; disable fails and uninstall succeeds leaves the pack
  **not installed** and the row `missing`; disable fails and uninstall fails
  records `failed` and warns;
- a claude build with no `disable` subcommand rolls back rather than leaving a
  pack enabled;
- an `update` failure that is not "not found" never reaches `install`;
- a failed `install` records `failed` and never reaches `disable`, so it cannot
  be recorded as installed by way of "already disabled";
- a rolled-back pack is absent from `SetupState.plugins`;
- a per-exec timeout records `failed` and never `not installed`;
- a settlement that does not fit the remaining budget is skipped whole, leaving
  the pack absent rather than installed and enabled;
- the budget cap returns and lets the pull loop re-arm;
- a push-path pull fires no converge.

**Contract e2e, opt-in.** `RT_CLAUDE_PLUGIN_E2E=1` runs the real `claude` binary
against a fixture directory marketplace in an isolated HOME and asserts the
behaviors the design rests on: install enables, disable then update preserves
disabled, update moves the version from a directory source, update on an
uninstalled plugin exits non-zero with "not found", disable on an
already-disabled pack exits 1 with "already disabled", uninstall on an installed
pack exits 0 and clears its `enabledPlugins` entry, and uninstall on an absent
pack exits 1 with phrasing `isAlreadyGone` still matches. The rollback verb is
covered here precisely because it is the one command whose failure would leave
the invariant broken. This is the test that fails loudly if claude's behavior
changes. It follows the house pattern for a
test needing a real external dependency (`sdm-browser-login.test.ts`): env-gated
and named, never silently skipped on a missing binary.

Honest limitation: no CI workflow installs `claude`, so CI cannot catch a claude
behavior change. The VM pass is where that assertion becomes a release gate, and
MAT-402's planned `team-pack` fixture and `assert-team.sh` blocks are the vehicle.
That work stays in MAT-402's lane.

## Acceptance

- A member whose team clone fast-forwards onto a new pack version ends with the
  new version in `~/.claude/plugins/cache`, with no command typed.
- The pack's enable state is the same before and after that converge.
- A pack added to the team after a member joined installs on the next converging
  pull and ends **not** enabled.
- A joiner who completes setup ends with the team pack installed and not enabled,
  asserted on the resulting settings files rather than on argv.
- A member who enables the pack, then runs `rt setup apply`, still has it enabled
  afterwards.
- After any run, no team pack is left installed and enabled by rt: it is either
  installed and disabled, or not installed at all.
- `rt setup status` shows a row per team-served pack carrying its installed
  version, names the served version when they differ, and states the restart
  caveat on the row where the cache has already moved.
- A pull that moves HEAD without changing any pack version runs no
  `claude plugin update`.
- A converge whose `claude plugin list --json` could not be read writes nothing.
- A `claude` that never exits cannot stop a clone's pull loop: the converge
  returns within its budget and `schedulePull` re-arms.

## Out of scope

The enable verb and the Done-screen line from R1 (this ships the row and the
command text, not a one-shot verb), the VM fixture and its assertions (MAT-402),
reconciling the daemon's `CLAUDE_CONFIG_DIR` with the shell's, automatic recovery
from a failed rollback, and any change to how packs are published.
