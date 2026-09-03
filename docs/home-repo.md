# The home repo (`rt home`)

`~/.mattstack/user` is a personal git repo that rt provisions and the daemon
keeps committed for you. While the daemon is running it watches that repo and
auto-commits (and pushes) everything in it except paths inside a claimed zone,
so you never run `git add` / `git commit` there yourself for ordinary changes.

```bash
rt home init                                     # provision this machine's ~/.mattstack tree (+ materialize)
rt home init --no-materialize                    # provision only, skip the last (materialize) phase
rt home init --profile <key> [--new-profile]     # adopt (or start) a machine profile without the picker
rt home init --dry-run                           # show what init would do
rt home init --url <clone-url>                   # clone the user repo from a specific remote
rt home snapshot                                 # run the auto-commit cycle right now (reason: manual)
rt home snapshot --status                        # daemon state: enabled, last run/commit, push state, claimed zones
rt home claim <zone> [--owner] [--note] [--force]  # tell the daemon to stop auto-committing a path
rt home release <zone>                             # let the daemon resume auto-committing a path
rt home key export                                 # print the age private key once, for your password manager
rt home key import [--stdin] [--force]             # bring an external age key into the keychain
```

## What `rt home init` does

`rt home init` does three things in order, every time it runs. It is
idempotent, so it is safe on a fresh machine or an already-provisioned one:

1. **Provision** the `user/` repo and this machine's `user/local/<key>/`
   profile, picking one interactively on a fresh, keyless machine, or via
   `--profile` / `--new-profile`.
2. **Ensure the age key exists** and that `.sops.yaml` matches it.
3. **Materialize**, as its last phase: regenerate everything re-derivable from
   settings.

Materialize covers rt's own PATH shims (`rt intercept install`) and daemon
registration (`rt daemon install`, only when not already installed), then each
locally-installed tool's own setup verb. `deck setup` runs when `deck` is on
`PATH` and NOT already healthy, because `deck setup` re-bootstraps deck under
launchd, restarting the live proxy and blipping every `*.localhost` app; an
already-healthy deck is reported as skipped instead of re-run.

A tracked repo (`rt.repoTracking`) that is not present on disk is reported by
name, never cloned. Some tools have interactive setup (tokens, OAuth); for
those, materialize only prints the command to run by hand and never runs it. A
missing tool is silently skipped, not a failure. Only an rt-owned step failing
exits `rt home init` non-zero. Pass `--no-materialize` to skip the phase
entirely.

Separately, if `claude.marketplaces` / `claude.plugins` resolve to a value,
`rt home init` prints a pointer to the mattstack installer, which owns
replaying them. Init never does that itself.

## Zones

A **zone** is a path relative to `~/.mattstack/user`, and is either a
**directory** (claims everything under it) or a **single file** (claims exactly
that path and nothing else).

Via `rt home claim`, either `prefs/` or just `prefs` works for a directory. It
stats the real path and decides for you, no trailing slash required.
Hand-editing `snapshot-owners.jsonc` directly is stricter: the trailing slash
IS the marker there, so write `"prefs/"` for a directory and
`"scripts/deploy.sh"` (no slash) for a file. A bare `"prefs"` with no slash is
read back as a file zone named literally `prefs`, not a directory. `release`
works either way without needing to guess.

Claim a zone when you are mid-edit on something and do not want the daemon
committing a half-finished state out from under you. `--owner` defaults to
`<you>@<machine-key>`, and `--note` is a free-text reason anyone reading the
owners file can see. Claiming a zone someone else already owns refuses (naming
them) unless you pass `--force`.

Claiming and releasing write `user/snapshot-owners.jsonc` directly, with no
daemon round trip. The daemon then snapshots that file itself, like any other
change.

## The janitor rule

A claimed zone left dirty past a threshold is still committed, under its own
`snapshot (janitor): ...` message, so an abandoned claim cannot block the zone
from ever being backed up.

## Configuration

The daemon's behavior is configured by the `rt.homeSnapshot` settings key
(machine-scoped):

```jsonc
{
  "enabled": true,             // false disables watching and auto-commits entirely
  "debounceSec": 20,           // quiet period after a change before committing
  "pushDelaySec": 60,          // coalescing delay before pushing a commit
  "janitorThresholdHours": 6,  // a claimed zone dirty this long gets janitor-committed
  "janitorIntervalMin": 30     // how often the janitor sweep runs
}
```

Flipping `enabled` to `false` is a kill switch: the daemon stops committing AND
cancels any already-scheduled push (including a pending retry) on its very next
cycle. Nothing new reaches `origin` while it is off, though a commit already
pushed stays pushed. Re-enabling picks a pending push back up on the next run.

## Team clones

Every git clone under `~/.mattstack/teams/<slug>/` with an `origin` gets its
own instance of the same engine, supervised by the daemon (a clone created by
`rt team create` or `rt team join` is picked up within the debounce window; a
clone with no remote is skipped until `rt team publish --remote` gives it one).
The team instance differs from the home one in three ways:

- **Scope.** It stages only `mattstack/**`, `.sops.yaml` and
  `.claude-plugin/**`. A team clone that is also a working repo keeps its
  `src/` and `docs/` hand-committed.
- **Pull.** Before every push, at daemon boot and every `pullIntervalSec`, it
  fetches `origin` with rt's stored forge token (env, never argv) and either
  fast-forwards or rebases its own commits onto the remote. A rebase that stops
  on a conflict is aborted, the clone stops pushing and pulling, and the
  `team.sync` checklist row names it: rebase and `rt team publish` by hand, or
  reset to origin, and the next tick resumes. A rebase that never started (an
  index lock, unstaged edits outside the scope) is skipped and retried.
- **Identity.** Commits need a committer git can resolve. Install's
  `git.identity` step writes the global `user.name`/`user.email` from the forge
  profile when none is configured; the engine itself only asks git
  (`git var GIT_COMMITTER_IDENT`) and goes inert with a warning when even that
  fails.

`rt team pull [--team <slug>]` runs one fetch + rebase cycle now and prints the
engine's result; `rt team status` shows `lastPull`, `lastPushAt`,
`lastPullSkipped` and `conflicted` per team. The `rt.teamSnapshot` key
(machine scope) carries the same fields as `rt.homeSnapshot` plus
`pullIntervalSec` (default 300, floor 30).

## One gotcha: manual snapshots reuse an in-flight run

`rt home snapshot` reuses an already-in-flight run instead of queuing its own.
If it lands while the watcher is mid-cycle, it returns THAT run's result, which
can report `reason: "watch"` and skip janitor zones (gated to
`"janitor"` / `"manual"`) even though you asked for a manual run. Run it again
for a fresh manual cycle.
