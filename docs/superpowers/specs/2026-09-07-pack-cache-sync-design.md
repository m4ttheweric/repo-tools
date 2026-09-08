# Converging Claude's plugin cache with the team clone

2026-09-07. MAT-410. The team clone pulls new pack versions and the installed
Claude plugin stays stale, so pack releases silently never reach the people
using them. Every claim about the `claude` CLI below was proved by running it
(2.1.263) against a fixture directory marketplace in an isolated HOME; the
probe transcript is summarized under "Evidence".

## Problem

`~/.mattstack/teams/<slug>` is registered with Claude Code as a `directory`
marketplace, and the pack is installed from it as `<plugin>@<marketplace>`.
Installing copies the pack into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`.
The MAT-405 snapshot daemon now fast-forwards that clone every few minutes, but
nothing re-reads it into the cache. Observed on the owner's own machine when
MAT-410 was filed: clone at pack 0.5.20, installed plugin 0.5.18.

Two facts make this worse than a missed update.

**`rt setup status` cannot show it.** The `pack.<pack>` row is built from
`readPackRequirements`, which discovers packs by finding a `requirements.jsonc`
under the clone. ClaimView's pack ships none, so there is no `pack.claimview`
row at all, and the row that does exist for other packs reports only
`installed` with no version. Nothing on any screen can say "installed 0.5.18,
team serves 0.5.20".

**The enable state underneath it is already wrong.** `plugins.install` enforces
the installed-never-enabled ruling for team-authored plugins by skipping the
`claude plugin enable` call. But `claude plugin install` enables the plugin by
itself: install alone into a clean HOME yields `enabledPlugins: {<id>: true}`.
So a joined team's pack is enabled today, contrary to the ruling, and the only
test covering it asserts that the `enable` argv is absent, which stays green
while the outcome is wrong. This matters here because the converge mechanism
preserves whatever enable state it finds, so it would faithfully preserve the
wrong one.

## Evidence

Run against claude 2.1.263, isolated HOME, fixture directory marketplace with a
one-skill pack:

| Probe | Result |
| --- | --- |
| `claude plugin install <id>` into a clean HOME | version installed, `enabledPlugins[<id>] = true` |
| `claude plugin disable <id>`, then bump the source version, then `claude plugin update <id> -y` | version moves, `enabledPlugins[<id>]` stays `false` |
| `claude plugin update` with no prior `claude plugin marketplace update` | picks up the new version; the directory marketplace needs no refresh step |
| `claude plugin install` on an installed-but-stale plugin | version moves **and** enablement flips back to `true` |
| `claude plugin update` when already current | exit 0, "already at the latest version" |
| `claude plugin update` for a plugin that is not installed | exit 1, "Plugin not found" |
| `claude plugin list --json --available` after a source bump | `available: []`, so it cannot be used to detect the newer version |

Two consequences follow directly. The converge verb must be `update`, never
`install`, because only `update` preserves the disabled state. And the served
version must be read from the clone on disk, because the CLI will not report it.

## Alignment with the owner/member split

Ruling of 2026-09-07: only the owner writes team settings, members are
pull-only, and member daemons never push the team repo. This design sits
entirely on the member-safe side. Its trigger is the pull edge, which is the
half of the snapshot engine that stays alive when the push half is refused, and
its only write is to `~/.claude` on the local machine. It does not write team
scope, does not push, and does not need forge write.

## Design

### Trigger: the pull that moved HEAD

`doPull` already classifies its outcomes, and exactly two of them mean HEAD
moved: `fast-forwarded` and `rebased`. `conflict` aborts the rebase and
restores the prior HEAD, `up-to-date` and `skipped` never move it.

`SnapshotSpec.pull` gains one optional field:

```ts
pull?: {
  intervalSec: number;
  /** Fired after a pull that moved HEAD, outside the git lock. */
  onPulled?: (outcome: "fast-forwarded" | "rebased") => Promise<void>;
};
```

`pullNow` awaits it after `withGitLock` releases, not inside `doPull`:

- outside the lock, because the hook shells out to `claude` and holding the git
  lock for the length of a plugin install would block the commit cycle;
- awaited rather than fire-and-forget, so a test that awaits `pullNow()`
  deterministically observes the converge instead of racing it.

A throwing hook is caught and logged at `warn`. A failed converge must never
turn a successful pull into a failure.

The home spec has no `pull` field at all, so the home repo is untouched by
this change, and the engine stays pack-agnostic: it knows only that something
wants to hear about a pull.

The boot pull that `init()` already fires means a clone that moved while the
daemon was down converges at daemon start, with no extra code.

### Converge: `lib/setup/pack-cache.ts`

A new module, placed beside `base-plugins.ts` and for the same reason: the
daemon supervisor and the status validator both need it, and neither may import
a setup step.

```ts
export interface ServedPack { id: string; name: string; servedVersion: string | null }
export interface InstalledPack { id: string; version: string | null; enabled: boolean }

/** marketplace.json plus each plugin source's plugin.json, read from the clone. */
export function readServedPacks(p: Probes, slug: string): ServedPack[]

/** One `claude plugin list --json` per config dir, parsed. */
export async function readInstalledPacks(p: Probes, configDir: string): Promise<InstalledPack[] | null>

export interface ConvergeResult {
  updated: { id: string; from: string | null; to: string | null }[];
  current: string[];
  skipped: { id: string; reason: string }[];
  failed: { id: string; detail: string }[];
}
export async function convergePackCache(p: Probes, slug: string, log: Logger): Promise<ConvergeResult>
```

`convergePackCache` walks the same `claudeConfigDirs(p, [])` list and passes the
same `CLAUDE_CONFIG_DIR` env as `plugins.install`, so the two agree about which
Claude installs they are managing. Per pack:

- **not installed**: skipped. First install belongs to `plugins.install`, and
  the daemon must not install a pack the member never had.
- **installed version equals served version**: current, with no update call.
  A converging pull costs one `claude plugin list --json` per config dir to
  learn the installed versions, and nothing more unless a version actually
  moved.
- **versions differ**: `claude plugin update <id> -y`. Exit 0 is an update,
  non-zero is a failure recorded with its stderr.

`-y` is passed because the daemon has no TTY and the flag is required there.
No `claude plugin marketplace add` and no `claude plugin marketplace update`:
the marketplace is already registered (`plugins.install` did it) and the
directory source needs no refresh, both proved above.

If `resolveTool(p, "claude")` finds nothing, the converge returns a single
skipped entry naming that. A machine without Claude Code is not a daemon error.

### The parser, shared not duplicated

`validators/tools.ts` already parses `claude plugin list --json`, with a
deliberate strictness contract: any element missing a string `id` rejects the
whole payload, and a missing `enabled` normalizes to `false` rather than
rejecting. That parser moves into `pack-cache.ts` and gains `version`, and
`validators/tools.ts` imports it. The strictness contract and its tests are
preserved exactly; the change is additive.

### Wiring

`teamSnapshotSpec` takes an `onPulled` in its opts and passes it through.
`startTeamSnapshots` supplies it, and it already holds everything needed:
`probes` (from `createRealProbes()`), the slug, and the per-clone child logger.

### Surfacing: the pack rows

`packRow` is rebuilt around the union of two sources, keyed by pack name so
each pack yields exactly one row:

- packs discovered by `readPackRequirements` (which may carry `.error`, and
  whose error row is preserved unchanged), and
- packs the team marketplace serves, which is how ClaimView gets a row at all.

Row states, given the never-enabled ruling:

| Condition | Status | Detail |
| --- | --- | --- |
| not installed | `missing` | installed by Install (plugins.install) |
| installed, version matches, not enabled | `ready` | `<v> installed, not enabled ... claude plugin enable <id>` |
| installed, version matches, enabled | `ready` | `<v> installed and enabled` |
| installed, version differs | `needs-you` | `installed <a>, team serves <b>; a running Claude session uses the old cache until it restarts` |
| malformed requirements | `error` | unchanged |

A disabled team pack is `ready`, not `needs-you`: under the ruling that is the
correct state, and the row's job is to name the one command that turns it on
(R1's "a visible statement of the one command that enables the pack"). The
stale row is `needs-you` with the existing `rt setup pack` action, because the
daemon converges automatically, so a row that is still stale when a human reads
it means the automatic path did not work and a person does need to act.

The restart caveat is stated on the stale row rather than everywhere, because
that is the row where it changes what the reader should expect: the version
they see is the version the next session gets, not this one.

### The install-path fix

In `plugins.install`, one `claude plugin list --json` per config dir before the
install loop yields the set that was already installed. Then, for a
team-authored plugin:

```
install
if teamAuthored:
    if not wasInstalledBefore: claude plugin disable <id>
    continue          # the enable call stays skipped, as today
```

Disable only on first install. A user who later enables the pack deliberately
keeps it enabled through every subsequent `rt setup apply`, and the converge
preserves it too. A failed disable is logged and named in the step detail, but
does not fail the step: an otherwise successful install should not fail over
enable-state bookkeeping, and the posture matches the existing best-effort
`enable`.

### Logging

The converge logs one domain event per team clone per converging pull, naming
what moved, at `info`; nothing when there was nothing to do. Failures log at
`warn` with `{ err }`. No request/response logging and no try/catch wrapper: the
daemon's `handleCommand` seam and the crash handlers already cover the rest,
per the logging architecture.

### No new setting

`rt.teamSnapshot.enabled` already disables the whole engine including its
pulls, so a kill switch for the converge exists. A second key would add a
registry entry and a second way to express the same intent.

## Testing

**Unit, always run.** The step and converge tests drive a fake `exec` that
models the real claude semantics proved above (install sets enabled true,
disable sets false, update preserves) and assert the resulting enable state and
version, not the argv sequence. The existing argv-absence test in
`steps-c.test.ts` is replaced by this outcome assertion: an argv assertion
cannot fail when the outcome is wrong, which is exactly how the current defect
stayed green.

**Contract e2e, opt-in.** `RT_CLAUDE_PLUGIN_E2E=1` runs the real `claude`
binary against a fixture directory marketplace in an isolated HOME and asserts
the four behaviors the design rests on: install enables, disable then update
preserves disabled, update moves the version from a directory source, and
update on an uninstalled plugin exits non-zero. This is the test that fails
loudly if claude's behavior changes. It follows the house pattern for a test
needing a real external dependency (`sdm-browser-login.test.ts`): env-gated and
named, never silently skipped on a missing binary.

Honest limitation: no CI workflow installs `claude`, so CI cannot catch a
claude behavior change. The VM pass is where that assertion becomes a release
gate, and MAT-402's planned `team-pack` fixture and `assert-team.sh` blocks are
the vehicle for it. That work stays in MAT-402's lane.

## Acceptance

- A member whose team clone fast-forwards onto a new pack version ends with the
  new version in `~/.claude/plugins/cache`, with no command typed.
- The pack's enable state is the same before and after that converge.
- A joiner who completes setup ends with the team pack installed and **not**
  enabled, asserted on the resulting settings rather than on the argv.
- `rt setup status` shows a row per team-served pack carrying its installed
  version, and names both served version and the restart caveat when they differ.
- A pull that moves HEAD without changing any pack version runs no
  `claude plugin update`.

## Out of scope

The enable verb and the Done-screen line from R1 (this ships the row and the
command text, not a one-shot verb), the VM fixture and its assertions
(MAT-402), first-install of a pack added to the team after a member joined
(the converge deliberately updates only what is installed), and any change to
how packs are published.
