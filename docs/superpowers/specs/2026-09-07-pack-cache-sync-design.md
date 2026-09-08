# Converging Claude's plugin cache with the team clone

2026-09-07 (revised 2026-09-08 after adversarial review). MAT-410. The team
clone pulls new pack versions and the installed Claude plugin stays stale, so
pack releases silently never reach the people using them. Every claim about the
`claude` CLI below was proved by running it (2.1.263) against a fixture
directory marketplace in an isolated HOME; the probe results are in "Evidence".

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
The only test covering this asserts that the `enable` argv is absent, so it
stays green while the outcome is wrong.

**`rt setup apply` re-enables a pack the member deliberately turned off.**
`pluginsInstallRun` runs `claude plugin install` unconditionally, including for
plugins already present, and install on an installed-but-stale plugin flips
enablement back to `true`. So today the ruling is violated at join time and the
member's own later choice is overwritten on the next apply.

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
| `claude plugin disable <id>` on an enabled pack | exit 0, `Successfully disabled` |
| `claude plugin disable <id>` on an already-disabled pack | exit **1**, stderr `Plugin "<id>" is already disabled` |
| `claude plugin disable <id>` on a pack that is not installed | exit **1**, stderr `Plugin "<id>" is already disabled` (identical to the line above) |

Three consequences drive the whole design. The converge verb is `update`, never
`install`, because only `update` preserves the disabled state. The served
version must be read from the clone on disk, because the CLI will not report it.
And `update`'s own not-found failure is a reliable, cheap proof that a plugin is
absent, which the design uses as the gate on every `disable`, alongside a
read-only listing that decides whether to attempt an update at all.

## Alignment with the owner/member split

Ruling of 2026-09-07: only the owner writes team settings, members are
pull-only, and member daemons never push the team repo. This design sits
entirely on the member-safe side. Its trigger is the pull edge, the half of the
snapshot engine that stays alive when the push half is refused, and its only
write is to `~/.claude` on the local machine. It writes no team scope, pushes
nothing, and needs no forge write.

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

`pullNow` awaits it after `withGitLock` releases:

- outside the lock, because the hook shells out to `claude` and holding the git
  lock that long would block the commit cycle;
- awaited rather than fire-and-forget, so a test that awaits `pullNow()`
  observes the converge deterministically instead of racing it.

**The push path does not fire it.** `doPushInner` calls `pullNow()` before every
push (`home-snapshot.ts:866`) to avoid diverging, not to react to content. That
pull is inside `pushInFlight`, so a converge there would delay every push by the
length of a plugin install, and any converge stall would wedge the push path on
owner machines. `pullNow` therefore takes `{ converge?: boolean }`, defaulting
to true, and `doPushInner` passes `converge: false`. Nothing is lost: the timer
pull converges the same clone within one interval.

The converging callers are the interval timer, the boot pull `init()` already
fires (so a clone that moved while the daemon was down converges at start), and
the explicit `team:pull` daemon verb.

The home spec has no `pull` field at all, so the home repo is untouched, and the
engine stays pack-agnostic: it knows only that something wants to hear about a
pull.

### Bounding the hook, so a hung `claude` cannot kill the pull loop

This is the sharpest failure mode in the design and it is specified explicitly.
`execWithTimeout` awaits its collected output unconditionally when no
`timeoutMs` is given (`probes.ts:118-122`), so a `claude` that never exits hangs
forever. `schedulePull` re-arms only in the `.finally` of `pullNow`
(`home-snapshot.ts:679-682`), so a hung hook would stop that clone's pull loop
for the life of the daemon, silently.

Two bounds, both required:

- **Per-exec:** every `claude` call the converge makes passes
  `timeoutMs: PACK_EXEC_TIMEOUT_MS` (60_000, the value and the reasoning
  `plugins.install` already uses). A timeout surfaces as exit code 124, the
  repo's existing convention, and is recorded as a `failed` entry for that pack
  with detail `timed out after 60s`. It is never recorded as success, and never
  as "not installed".
- **Per-converge:** a whole-run budget of `CONVERGE_BUDGET_MS` (120_000).
  When it is exhausted, the remaining packs are recorded as `skipped` with
  `converge budget exhausted` and the run returns. The next pull retries them.
- **The pending-disable retry preamble draws from that same budget**, capped at
  `PENDING_PREAMBLE_BUDGET_MS` (60_000, half of it). Several stranded ids each
  burning a 60s timeout would otherwise starve the converge they precede, or
  push the run past the client ceiling below. Ids not reached before the cap are
  left untouched for the next converge; they are not recorded as failures,
  because nothing was attempted.

Together these cap the hook's contribution to `pullNow` at a known bound, so
`schedulePull` always re-arms. The hook's own `catch` additionally guarantees a
throwing converge cannot turn a successful pull into a failure.

**The budget has a ceiling that is not arbitrary.** `rt team pull` gives the
`team:pull` verb a 180_000 ms client timeout (`commands/team.ts:164`), and that
round trip already spends up to `FETCH_TIMEOUT_MS` 30_000 on the fetch
(`home-snapshot.ts:166`). 30s plus the 120s budget leaves 30s of headroom. The
budget must never be raised past that without raising `PULL_TIMEOUT_MS` first,
or a manual `rt team pull` starts timing out on the client while the daemon is
still working.

**One converge can be skipped by coalescing, and that is acceptable.** `pullNow`
returns the in-flight promise when a pull is already running, so a timer tick
that lands during a push-path pull (which passes `converge: false`) gets that
pull's result and runs no converge of its own. The clone is still current; only
the cache waits. The next interval converges it, so the gap self-corrects
without any extra machinery.

### Converge: `lib/setup/pack-cache.ts`

A new module beside `base-plugins.ts`, and for the same reason: the daemon
supervisor, the setup step and the status validator all need it, and none of
them may import a setup step.

```ts
export interface ServedPack { id: string; name: string; servedVersion: string | null }
export interface InstalledPack { id: string; version: string | null; enabled: boolean }
/** `error` is non-null only for a marketplace.json that exists and did not parse. */
export interface ServedPacks { packs: ServedPack[]; error: string | null }

/** marketplace.json plus each plugin source's plugin.json, read from the clone. */
export function readServedPacks(p: Probes, slug: string): ServedPacks

export interface ConvergeResult {
  updated: { id: string; to: string | null }[];
  installed: string[];
  current: string[];
  skipped: { id: string; reason: string }[];
  failed: { id: string; detail: string }[];
}
/** `store` reads and writes the daemon's `pending-disable` kv key; the CLI passes
 *  a SetupState-backed one. Both implementations also expose a read-only view of
 *  the other store, which is what makes read-both / write-own possible. */
export interface PendingDisableStore {
  /** Ids this side owns, plus the confirmations it has written. */
  read(): { ids: string[]; confirmed: string[] };
  /** The other side's, best-effort; an absent store reads as empty. */
  readForeign(): { ids: string[]; confirmed: string[] };
  write(next: { ids: string[]; confirmed: string[] }): void;
}
export async function convergePackCache(p: Probes, slug: string, store: PendingDisableStore, log: Logger): Promise<ConvergeResult>
```

`convergePackCache` walks the same `claudeConfigDirs(p, [])` list and passes the
same `CLAUDE_CONFIG_DIR` env as `plugins.install`, so the two agree about which
Claude installs they manage.

**The per-pack sequence, which is also the ruling's single enforcement point.**
It has two layers: a read-only listing that decides *whether to act at all*, and
`update`'s own not-found failure as the proof of absence before anything is
disabled.

```
listing = claude plugin list --json          (read-only, once per config dir)
  failed or unparsable -> every pack recorded `failed`, NO write of any kind

per pack:
  listed, both versions known and equal  -> current      (no exec at all)
  listed, either version unknown         -> skipped      ("version unknown")
  otherwise                              -> update <id> -y
        exit 0                  -> updated. Enable state untouched.
        exit != 0, "not found"  -> it does not exist:
                                     install <id>
                                     disable <id>        (team-authored)
        exit != 0, otherwise    -> failed, recorded with stderr
```

The listing is what makes "a pull that changes no pack version issues no
`update`" achievable: without it, nothing knows the installed version, and the
sequence could only open with an unconditional update. It is read-only, so it
gates writes without ever authorizing one.

The absence proof stays where it was, and it is deliberately not replaced by the
listing. `disable` runs only on the branch where `update` itself reported the
pack missing and `install` then created it. Uncertainty of every kind (an
unreadable listing, a timeout, any other non-zero) exits through `skipped` or
`failed`, so no code path reaches a `disable` on a pack that might already have
existed. Keeping both layers means the never-stomp guarantee does not depend on
the listing being accurate, only on `update` being honest about not-found.

A "not found" match is anchored to that phrasing in stderr, the way `isAlready`
is anchored today, so an unrelated failure cannot be read as absence.

**Cost of the second layer, stated plainly:** on a fresh machine every pack is
absent, so each one costs one deliberately-failing `update` per config dir
before its `install`. That is a handful of fast, immediately-returning calls on
the one run where nothing is installed yet, and it buys a never-stomp guarantee
that survives a wrong listing.

### When a disable fails, it self-heals

A `disable` that fails or times out after a successful `install` would leave the
pack installed **and enabled**, forever: every later converge takes the `update`
path, which by design leaves enablement alone. That is precisely the ruling
violation this spec exists to prevent, so it may not be left to a log line.

An id is recorded when this run installed the pack and its `disable` did not
confirm, and every converge and every `plugins.install` begins by retrying every
id in the union of both stores (see "read both, write own" below), minus the
ones a confirmation has retired.

**The retry has bounded exits, which the probes above determine.** `disable`
exits 1 both when the pack is already disabled and when it is not installed at
all, with the same stderr line, so an unconditional retry would fail forever.
Since both of those mean the goal state (not enabled) already holds, both clear
the id:

| Outcome | Action |
| --- | --- |
| `disable` exit 0 | clear |
| exit 1, stderr matches "already disabled" | clear (the goal state holds, whether the pack is off or gone) |
| unknown subcommand | clear, terminal, logged once. A claude build without `disable` can never satisfy the retry, and `plugins.ts:187` already tolerates exactly this for `enable`. |
| the listing shows the pack absent, or present with `enabled: false` | clear without calling `disable` at all |
| any other non-zero | keep, retry next converge |

No id can outlive the condition it describes, so the list cannot strand.

**Where it lives, and why that is two records rather than one.** Round 2 put
this in `setup-state.json` to avoid two records of one fact. That was wrong for
a different reason: `updateSetupState` is a lock-free read-modify-write
(`state.ts:41-53`), so a daemon converge and a `rt setup apply` running together
would silently lose one writer's entries, and a lost entry is a pack left
enabled.

So the rule is **read both, write own**. Each writer records only what it
installed, and never writes the other's store, but both *retry* from both:

- `plugins.install` records into `SetupState.pendingDisable`.
- the daemon converge records into its existing per-clone kv namespace
  (`team-snapshot:<slug>`, sqlite-backed and therefore atomic) under **its own
  key, `pending-disable`**, never `HOME_SNAPSHOT_KEY`.
- **both** read the union of the two at the start of a run and retry every id in
  it.

Read-both is what heals the primary case. A joiner's first install runs through
`plugins.install`, so a failed disable there lands in `SetupState`; if the
converge only ever read its own kv, nothing would heal it until a human happened
to re-run setup, which may never happen. The converge therefore retries CLI-owned
ids too, and simply does not write that store.

**A healed foreign id must be retired explicitly, or read-both becomes a stomp
loop.** The listing rule alone does not close this. The converge disables a
CLI-owned pack but cannot remove the id from `SetupState`, so the id stays in the
union; if the member then deliberately enables that pack, the listing shows
`enabled: true`, the "already disabled" clear branch does not fire, and the next
converge disables it again... every interval, until the member happens to run
`rt setup apply`. That is rt overriding a deliberate enable on a loop, under a
row that wrongly says it could not disable anything.

So a successful disable of a *foreign* id writes a confirmation into the
disabling side's own store, `confirmed:<id>@<time>`, and the three rules below
retire it:

- the retry union is `(own ids + foreign ids)` minus every id confirmed in
  either store, so a confirmed id is never retried again by anyone;
- the owning side drops its own id as soon as it observes a confirmation for it
  in the foreign store;
- the confirming side drops its marker once the owning store no longer lists
  that id, so markers cannot accumulate.

That handshake terminates in two runs: the converge disables and confirms, the
next `plugins.install` drops the id, the next converge drops the marker. After
it, the pack is absent from the union permanently, the row clears, and a
deliberate enable is never touched again... which is what makes the promise
above ("enabling after that row clears is never overridden") actually true.

An id a side owns *itself* needs no confirmation: it drops the id directly.

No lock is needed anywhere: writes stay single-owner, and reads are advisory.

**How each side reaches the other's store.** The CLI reads the daemon's kv
through `getStateDb("daemon")`, and must do so lazily and best-effort, for the
reason `home-snapshot.ts:374-381` documents: state.db must not be opened before
`startDaemon()` has opened it daemon-flavored, and on a machine where the daemon
has never run there is no db at all. An unreadable or absent db yields an empty
foreign list, never an error and never a created db. The daemon reads
`SetupState` through the existing `readSetupState(probes)`, which already returns
`EMPTY_STATE` for a missing file. The status row uses these same two accessors,
so all three call sites agree about what "either store" means.

**The dedicated key is not a detail.** `persistState` writes the whole
`HOME_SNAPSHOT_KEY` (`"state"`) row wholesale on every cycle
(`home-snapshot.ts:318`), so a pending list folded into that row would be
silently wiped on the next snapshot, and a wiped list is indistinguishable from
a healed disable... the pack would stay enabled with nothing left to say so.
`home-snapshot.ts:325` already carries this warning verbatim for the push
record, which took its own key for exactly this reason; `pending-disable`
follows that precedent rather than rediscovering it.

`SetupState` gains `pendingDisable: string[]` as a required field with an
`EMPTY_STATE` default, not an optional one. `readSetupState` spreads
`EMPTY_STATE` under the parsed value specifically so an older file backfills a
new field (`state.ts:32-35` names `forcedLinks` as that precedent), so old files
stay valid with no `v` bump. It must also be added to the dedupe block in
`updateSetupState`, which enumerates its arrays explicitly (`state.ts:43-48`);
omitting it there would append duplicates on every run, without bound.

**The window is real, and stated rather than papered over.** Between a failed
`disable` and the retry that clears it, the pack is installed and enabled, which
is indistinguishable from a pack the member enabled deliberately. rt's intent for
that pack is "not enabled", so a member who chooses to enable it inside that
window will see it turned off once, at the next converge. The window is
typically bounded by one pull interval, though an id on the any-other-non-zero
branch persists until a retry succeeds, and it is visible rather than silent
throughout: a pending id renders
its pack as `needs-you` in `rt setup status` (see the row table), detail
`rt could not disable this pack; retrying`. Enabling after that row clears is
never overridden.

`install` on a fresh pack is what delivers the 2026-09-07 ruling that a pack
added to the team after a member joined installs through the converge, disabled,
with the member opting in via Enable. It is the same three lines that serve the
join-time case.

If `resolveTool(p, "claude")` finds nothing, the converge returns a single
skipped entry naming that: a machine without Claude Code is not a daemon error.

No `claude plugin marketplace add` and no `claude plugin marketplace update`:
the marketplace is already registered by `plugins.install`, and a directory
source needs no refresh, both proved above.

### Reading what the team serves

`readServedPacks` reads `<clone>/.claude-plugin/marketplace.json` and, for each
entry, the `plugin.json` at its `source`. The failure cases are defined rather
than left to silence, because silent dropping is the exact failure this spec
exists to fix:

| Input | Result |
| --- | --- |
| file absent | `{ packs: [], error: null }`. A clone rt does not own yet is not an error, matching `readTeamMarketplace` today. |
| file unparsable | `{ packs: [], error: "<path> did not parse" }`. The team authored it; its packs must not vanish silently. The status row renders this as an `error` row. |
| entry `source` is a string | resolved relative to the clone root; its `plugin.json` `version` is the served version. |
| entry `source` is object-form (github, url) | pack listed, `servedVersion: null`. The version is not on disk to read. |
| `plugin.json` missing or unparsable | pack listed, `servedVersion: null`. |

**Null-version comparison is defined:** a pack whose served or installed version
is null is never treated as stale and never triggers an update. Unknown is not a
mismatch. It renders as `version unknown` on its row, and the converge records
it as `skipped` with that reason. This keeps an object-form source from
provoking an update loop it can never satisfy.

**"Version unknown" and "absent" are different states and must not be
conflated.** A pack the listing carries with a null version is installed, and is
skipped. A pack with no entry in the listing at all is not installed, and takes
the update-then-install branch. Collapsing the two would drop the ruling that a
pack added after a member joined installs on the next converging pull, because
every such pack arrives with no listing entry.

### The parser, shared not duplicated

`validators/tools.ts` already parses `claude plugin list --json` with a
deliberate strictness contract: any element missing a string `id` rejects the
whole payload, while a missing `enabled` normalizes to `false` rather than
rejecting. That parser moves into `pack-cache.ts` and gains `version`;
`validators/tools.ts` imports it. The contract and its tests are preserved
exactly; the change is additive.

Both the converge and the status row read this listing, for different ends: the
converge to gate its updates, the row to report installed version and enable
state. Neither may write on a listing it could not read... the converge records
`failed`, the row renders an honest `error`.

### Wiring

`teamSnapshotSpec` takes `onPulled` in its opts and passes it through.
`startTeamSnapshots` supplies it and already holds everything needed: `probes`
(from `createRealProbes()`), the slug, and the per-clone child logger.

**A known environment divergence, named rather than hidden.** `claudeConfigDirs`
reads `CLAUDE_CONFIG_DIR` from the process env. The daemon's env is launchd's,
not the user's shell, so a user who sets that variable in their shell profile
has the CLI managing one config dir and the daemon converging another. The
converge therefore logs which config dir it acted on, and the status row reports
the dir the CLI sees, so the two can be compared instead of quietly disagreeing.
Making them agree is out of scope here (it is a setting, not a fix in this lane).

### Surfacing: the pack rows

`toolRows` gains the team slug through its `opts` argument; `composePlan` has
`team.slug` in hand at the call site (`plan.ts:145`, used at `plan.ts:157`).

`packRow` is rebuilt around the union of two sources, keyed by pack name so each
pack yields exactly one row:

- packs discovered by `readPackRequirements` (whose `.error` row is preserved
  unchanged), and
- packs the team marketplace serves, which is how ClaimView gets a row at all.

| Condition | Status | Detail |
| --- | --- | --- |
| marketplace.json unparsable | `error` | `<path> did not parse` |
| not installed | `missing` | installed by Install (plugins.install) |
| installed, versions match, not enabled | `ready` | `<v> installed, not enabled ... claude plugin enable <id>`, plus the restart caveat |
| installed, versions match, enabled | `ready` | `<v> installed and enabled`, plus the restart caveat |
| installed, versions differ | `needs-you` | `installed <a>, team serves <b>` |
| either version unknown | `ready` | `<v> installed, served version unknown` |
| id is in the retry union (in either store, not confirmed in either) **and** the listing does not already show the pack disabled | `needs-you` | `rt could not disable this pack; retrying` |

The pending row takes precedence over the `ready` rows above it. Without it a
pending pack would render as `installed and enabled`, which is the opposite of
both rt's intent and what is about to happen to it.

Both qualifications in that condition are required, and each matches a test. The
confirmation check keeps a healed-but-not-yet-retired id from showing a retry
that will never run; the listing check keeps a stale id from claiming rt could
not disable a pack that is sitting there disabled.

**The restart caveat sits on the converged row, not the stale one.** On a stale
row the cache itself still holds the old version, so a restart changes nothing
and the caveat would be actively misleading. It belongs where the cache has
already moved and only the running process is behind: `a Claude session started
before this version landed uses the old cache until it restarts`.

A disabled team pack is `ready`, not `needs-you`: under the ruling that is the
correct state, and the row's job is to name the one command that turns it on
(R1's "a visible statement of the one command that enables the pack"). A stale
row is `needs-you` with the existing `rt setup pack` action, because the daemon
converges automatically, so a row still stale when a human reads it means the
automatic path did not work and a person does need to act.

### The install path

`plugins.install` stops calling `claude plugin install` unconditionally and
calls the same `pack-cache.ts` per-pack sequence instead, so the enable rule and
the update-not-install rule live in exactly one place. For trusted plugins the
`enable` call follows as it does today; for team-authored plugins it stays
skipped, and the `disable` fires only on the proved-absent branch.

This is what stops `rt setup apply` re-enabling a pack the member deliberately
turned off: an already-installed plugin now takes the `update` path, which
preserves enablement, and never the `install` path, which does not.

**The step's failure contract is unchanged.** `pluginsInstallRun` today returns
`{ state: "failed", detail, remedy: RETRY_REMEDY }` and stops on the first
non-zero, non-`isAlready` result (`plugins.ts:174-176`). A failed `update` and a
failed `install` both keep exactly that: same state, same `RETRY_REMEDY`, same
immediate return. Only the argv changes, never the contract.

A failed `disable` is the one exception, and it stays an exception: logged,
named in the step detail, and recorded in `pendingDisable` for retry, but it
does not fail the step. That matches the existing best-effort posture for
`enable`... an otherwise successful install should not fail over enable-state
bookkeeping, and the retry list means the state is corrected rather than merely
reported.

Inside the daemon converge the posture is different again: nothing fails a
pull. Every `failed` entry is recorded in the result and logged at `warn`, and
the next converging pull retries it.

### Logging

The converge logs one domain event per team clone per converging pull, naming
what moved and which config dir it acted on, at `info`; nothing when there was
nothing to do. Failures and timeouts log at `warn` with `{ err }`.

The hook's own `catch` is the logging seam for this path, and the spec says so
because the usual one does not apply: `handleCommand` covers daemon commands,
and a timer-driven pull is not one. Nothing below that catch may swallow an
error silently.

### No new setting

`rt.teamSnapshot.enabled` already disables the whole engine including its pulls,
so a kill switch for the converge exists. A second key would add a registry
entry and a second way to express one intent.

## Testing

**Unit, always run.** The converge and step tests run against a temp HOME with a
fake `exec` that models the proved claude semantics by writing a real
`settings.json` and `installed_plugins.json` (install writes `enabled: true`,
disable writes `false`, update leaves enablement alone and moves the version).
Assertions read those files. The outcome is therefore literal, not a stand-in:
the existing argv-absence test in `steps-c.test.ts` is replaced, because an argv
assertion cannot fail when the outcome is wrong, which is precisely how the
current defect stayed green.

Cases that must be covered because the design turns on them: a converge with no
version change issues no `update`; an unreadable or unparsable listing performs
no write of any kind; a stale pack updates and keeps its disabled state; a
served-but-absent pack installs and ends disabled; an `update` failure that is
not "not found" never reaches `install` or `disable`; a per-exec timeout records
`failed` and never `not installed`; a failed `disable` is recorded and the next
converge retries it to success; an "already disabled" stderr clears the id
rather than retrying forever; an unknown-subcommand `disable` clears the id as
terminal; a listing showing the pack already disabled clears it with no
`disable` call; repeated failures never grow the stored array (the dedupe case);
a failed disable recorded by `plugins.install` is retried and cleared by the
daemon converge, which never writes `SetupState`; the confirmation handshake
retires that foreign id in two runs and the markers do not accumulate; a member
who enables a healed pack is **not** disabled again on the next converge (the
stomp-loop regression test); a pending id
whose pack the listing shows already disabled renders no `needs-you` row; the
pending list survives a snapshot cycle (the dedicated kv key, not the wholesale-
overwritten state row); the retry preamble stops at its cap and leaves the rest
untouched; a pack the member enabled after a
successful disable is never re-disabled; the budget cap returns and lets the pull
loop re-arm; and a push-path pull fires no converge.

**Contract e2e, opt-in.** `RT_CLAUDE_PLUGIN_E2E=1` runs the real `claude` binary
against a fixture directory marketplace in an isolated HOME and asserts the
behaviors the design rests on: install enables, disable then update preserves
disabled, update moves the version from a directory source, and update on an
uninstalled plugin exits non-zero with "not found". This is the test that fails
loudly if claude's behavior changes. It follows the house pattern for a test
needing a real external dependency (`sdm-browser-login.test.ts`): env-gated and
named, never silently skipped on a missing binary.

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
- A joiner who completes setup ends with the team pack installed and not
  enabled, asserted on the resulting settings files rather than on argv.
- A member who enables the pack, then runs `rt setup apply`, still has it enabled
  afterwards.
- `rt setup status` shows a row per team-served pack carrying its installed
  version, names the served version when they differ, and states the restart
  caveat on the row where the cache has already moved.
- A pull that moves HEAD without changing any pack version runs no
  `claude plugin update`.
- A converge whose `claude plugin list --json` could not be read writes nothing.
- A pack whose `disable` failed is disabled by a later converge without any
  command typed, **including a joiner's first install**, whose failure is
  recorded by `plugins.install` and healed by the daemon. A pack the member
  enabled deliberately (after that pack's pending row cleared) is not.
- No pending id survives the condition it describes: an uninstalled pack, an
  already-disabled pack and a claude build without the subcommand each clear it,
  so the retry list cannot grow without bound.
- While a pack is pending, `rt setup status` says so rather than reporting it as
  installed and enabled.
- A `claude` that never exits cannot stop a clone's pull loop: the converge
  returns within its budget and `schedulePull` re-arms.

## Out of scope

The enable verb and the Done-screen line from R1 (this ships the row and the
command text, not a one-shot verb), the VM fixture and its assertions (MAT-402),
reconciling the daemon's `CLAUDE_CONFIG_DIR` with the shell's, and any change to
how packs are published.
