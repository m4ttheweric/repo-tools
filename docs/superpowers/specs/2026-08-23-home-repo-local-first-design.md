# Home repo: local first, remote optional — design

`rt home init` always ends with a working home repo on this machine. Whether
that repo has a remote is the operator's choice, offered by the Mac app's setup
and changeable later. Local-only is a permanent, fully supported state — and it
is reported honestly, because a repo that has never left the machine is not
backed up.

## Why

`commands/home.ts:84` hardcodes `DEFAULT_USER_REPO_URL =
"https://github.com/m4ttheweric/mattstack-home"` — rt's author's personal repo —
as the fallback when no URL is supplied. Anyone else installing mattstack.app
without setting `RT_HOME_URL` reaches for it: today they dead-end on auth,
because it is private; if it were ever public they would receive someone else's
settings.

CI surfaced this on 2026-08-23 (release run 32664342028) when the clean-room
step reached `home.init` and failed with `Run gh auth login, then Retry`. The
warning line that names the problem — *"no RT_HOME_URL set — targeting rt's
built-in default repo, not one owned by this operator"* — had been printing
correctly all along. Nothing acted on it.

Matt's rulings, 2026-08-23:

> "it should be a first class part of the mac app setup."

> "always set up a repo on the user's machine so we don't break the program. but
> give the user the option on where to build it."

> "local-only should be fully supported but a mattstack settings state that gives
> a warning … so the user understands their settings are not backed up anywhere."

The decomposition that falls out: **the home repo existing** is load-bearing —
settings stores, the snapshot daemon, and `rt verify` all assume
`~/.mattstack/user` is a repo. **The remote is a convenience.** Welding them
together is what made a missing URL fatal.

## 1. `rt home init` always ends with a repo

### Resolution lives in one place

Today the order the spec wants is not implementable: `rt home init` reads only
`--url` (`parseUrlArg`, `commands/home.ts:193-201`), and `RT_HOME_URL` is read
solely by `lib/setup/steps/home.ts:61`, which converts it into `--url`. So env
arrives *as* rung 1 and an intent value could never outrank it.

**`rt home init` owns resolution.** It resolves, in order:

1. `--url <url>`
2. the setup intent's `homeRepo` (§4)
3. `RT_HOME_URL` in the environment
4. **none of the above → `git init` a local-only repo**

`lib/setup/steps/home.ts` **stops synthesizing `--url` from `RT_HOME_URL`** and
lets `home init` read the intent and env itself. In practice the step then passes
`--url` never. Splitting resolution across both is what inverts the order.

Two things go with that deletion: the step's warning line at `:64` ("no
RT_HOME_URL set — targeting rt's built-in default repo") becomes false once
`DEFAULT_USER_REPO_URL` is gone, and the only other `ctx.p.env.RT_HOME_URL`
reference disappears with the §5 gate — after which `p.env` may be unused in that
file.

**Seam the intent read.** `readIntent` takes `Pick<Probes, "readFile" | "home">`,
which `commands/home.ts` does not currently have. `HomeInitSeams` already has the
pattern; the plan must say how the intent read is injected, so the resolver stays
unit-testable without writing a real `~/.mattstack/rt/setup-intent.json`.

`DEFAULT_USER_REPO_URL` is **deleted**, not replaced. rt never invents a home
repo for someone.

### What local-only produces

The same tree the clone path does: `user/` as a git repo with `main` checked
out, `.gitignore`, `snapshot-owners.jsonc`, the machine-key file, the profile
directory, and the `skills.jsonc` symlink — plus an initial commit and no
remote. `lib/team/create.ts:168-190` is a working `git init -b main` → scaffold →
commit reference to follow.

`ensureStateDirs` and `ensureHomeAgeKey` run outside the clone-gated steps, so
local-only inherits `.sops.yaml` and the age key unchanged.

**Ordering to settle during implementation:** `ensureHomeAgeKey` writes
`user/.sops.yaml` *after* `executeInitPlan`, with a "commit it yourself"
message. The clone path has no initial commit to mirror, so the plan must say
whether local-only's initial commit lands before that write (leaving `.sops.yaml`
uncommitted, consistent with today) or after it. Pick one and state it; do not
leave it to the implementer.

**A repo that exists is never re-initialised.** The existing short-circuit on an
already-present clone stays; local-only is only the behaviour for a first run
with no URL.

## 2. The snapshot daemon: "no remote" is a state, not a failure

Today `lib/daemon/home-snapshot.ts` runs `git push -q origin HEAD` (`:458`)
unconditionally and broadcasts `home:push-failed` (`:485`) when it fails. There
is no remote detection anywhere in the module, so a local-only repo would fire a
failure event every cycle — the difference between a supported state and a
tolerated one.

The daemon checks for a configured remote before arming the push. With none:

- it commits on the same debounce, unchanged
- it **skips the push** — no push timer, no retry timer, no `home:push-failed`
- it logs the skip once at `debug`, not on every cycle

Everything commit-side is untouched: the janitor, claimed zones (`:639-671`), and
the kill switch (`:452-457`, `:510-516`) are all pre-push and behave identically.
This is deliberately not a new mode — it is one branch before the push.

### Attaching a remote later must actually push

`doRun` arms a push only via `if (committed || pushPending) schedulePush()`
(`:672`). So after a user attaches a remote, the commits accumulated while
local-only would sit unpushed until the next file change happens to produce a
commit — a janitor tick alone would not push them.

**The rule: arm a push when a remote exists and HEAD is ahead of
`refs/remotes/origin/<branch>`, not only when this cycle committed.**

**A missing `refs/remotes/origin/<branch>` counts as everything-unpushed and
arms the push.** That is the state of a freshly attached remote — the exact user
who just followed the remedy above — and `rev-list refs/remotes/origin/<branch>..HEAD`
is *fatal* when the ref does not exist, not empty. Only once the ref exists is
the comparison meaningful. Treating the fatal as "nothing to push" would leave
the local-only backlog sitting unpushed until some later file change happened to
commit, reinstating the gap this rule closes.

That covers the attach-a-remote case
without the alternative's cost — setting `pushPending = true` while remote-less
would make `status()` and the tray show a permanently pending push that nothing
is going to perform.

### There is no verb for attaching a remote, and this spec does not add one

`rt home init --url <x>` is a **no-op against an existing repo**: `buildInitPlan`
skips `cloneUserRepo` when `userRepoPresent`, and `config.url` is then unused. So
today the only way to attach a remote is by hand:

```
git -C ~/.mattstack/user remote add origin <url>
```

That is what the warning row's remedy names (§3). A `rt home remote set <url>`
verb is the obvious follow-up and is **explicitly out of scope here** — this spec
must not claim an affordance that does not exist. The Mac app's setup screen is
the other route: re-running setup lets an operator who deferred choose a remote.

## 3. Honesty: a local-only repo must never read as backed up

This is the real risk of always-create, and the part most likely to be got
wrong: **the user gets a working repo and reasonably assumes it is safe.**

### A new probe row

There is no home-repo row today — `lib/setup/validators/rt-health.ts` (note the
path; not `lib/setup/rt-health.ts`) has only `access.team-repo`, which is a
different repo. This spec **creates** a row: id `home.backup`, `required: false`,
with the usual title/why.

`required: false` matters twice over: a required row would make deferring a
blocker by the back door, and `commands/verify.ts:70-75` renders a non-required
non-`ready` row as `warn`/`severity: "warning"`, excluded from the failure tally
and from `process.exit(1)` (`:151`, `:161`).

### The status must be `needs-you`, not merely "non-ready"

`RowStatus` is `ready|missing|invalid|needs-you|checking|skipped|error`
(`lib/setup/contract.ts:3`). Only the first four render as `warn`. **`skipped`
and `checking` render as `skip` with `severity: "info"`** — a dim dash and no
warning at all. "Local-only" is a plausible-sounding reading of `skipped`, and
choosing it would silently defeat this entire section. The row reports
**`needs-you`** for every non-green state below.

### Green means a push succeeded, never that a remote exists

A remote that is set but has never been pushed to — wrong URL, missing auth,
failing every cycle — is still *"your settings are not backed up anywhere"*. A
probe reporting `ready` on `remote exists` would call that safe. It is the same
mistake as asserting a bundled binary's signature and size instead of running it:
the shape is right and the path is dead.

**Evidence of a completed push is git's own remote-tracking state**, not the
daemon's word:

- `refs/remotes/origin/<branch>` exists, and
- `git rev-list refs/remotes/origin/<branch>..HEAD` is empty (nothing local is
  unpushed), where `<branch>` comes from `git symbolic-ref --short HEAD`

**Never use `@{u}`.** The daemon pushes `git push -q origin HEAD` with no `-u`
(`home-snapshot.ts:458`), so a repo that was `git init`-ed and later had a remote
added has the remote ref but no `branch.<name>.remote`/`.merge` — `@{u}` exits
128 with *"no upstream configured"*. Verified on a scratch repo: the ref
resolves, `rev-list refs/remotes/origin/main..HEAD` returns 0, and the `@{u}`
form fails outright.

The trap is that `@{u}` **works on a cloned repo**, because `git clone`
configures upstream. It would pass on the author's machine and on every existing
install, and fail only on the local-only-then-attached path — the population this
spec creates. That is the same "the code looked fine because the failing path was
never exercised" shape this document's own closing note warns about.

Configuring upstream instead (making the daemon's first push `git push -u origin
HEAD`) is a separate, independent change. It is **not** assumed here: a probe
depending on it would still be wrong for every repo pushed before it landed.

That ref is updated *by* a successful push, so it is outcome evidence. Reading it
rather than a daemon record also covers three cases a record would miss: a
hand-run `git push`, a machine where the snapshot daemon is disabled or was never
installed, and existing users — who would otherwise read "nothing pushed yet"
until their next push.

| condition | status | row says |
|---|---|---|
| no remote | `needs-you` | **local only.** Your settings are versioned on this machine but are not backed up anywhere. Remedy names the `git remote add` command from §2. |
| remote set, no `refs/remotes/origin/<branch>` | `needs-you` | remote configured, nothing pushed yet |
| remote set, commits unpushed | `needs-you` | names how many commits are unpushed, and the last push failure if one is recorded |
| remote set, ref exists, nothing ahead of it | `ready` | naming when the last push succeeded, if known |

Not "not configured" (it is configured, deliberately), and not an error (nothing
is wrong).

**The daemon's recorded outcome supplements the ref check; it never gates
green.** It supplies the *why* for a failing push — the state a user is least
likely to notice and most likely to be hurt by. Record it under its **own kv
key**, not the existing state row: `persistState` (`:201-209`) writes
`{ firstSeenDirty }` wholesale on **every** commit cycle, so a `lastPush` field
added to `HOME_SNAPSHOT_KEY` would be clobbered within seconds and the probe
would report "never pushed" forever. A separate key in the same
`HOME_SNAPSHOT_NS` namespace avoids that without touching the janitor's
first-seen-dirty clock.

**The probe reads `state.db` directly, never the daemon over IPC.** `rt verify`
runs in CI and mid-install when the daemon is not up; an IPC failure would render
as `error` rather than the intended warning. A missing key reads as "no recorded
push", which is correct on a fresh install and is why the ref check is primary.

### The `snapshot.push` step tells the same truth

`lib/setup/steps/tools.ts:165-211`, titled *"Push your first snapshot"*, returns
`done: "committed <sha>"` off the daemon's commit — it never observes a push. On
a local-only install the operator finishes setup looking at a green *"Push your
first snapshot"*, which is exactly the false safety this section exists to
prevent. It lives in this repo, so it is in scope: with no remote its detail says
the snapshot was committed locally and not pushed. Its `done` state is
unchanged — the step did what it could — but its wording stops implying the
snapshot left the machine.

### Shipping surfaces

`rt verify` and the tray. The tray needs **no Swift work**: its status window
renders `rt setup status --json` rows generically
(`SetupCoordinator.swift:49`), so a new row appears on its own.

The settings page from `2026-08-23-settings-console-page-design.md` is specced
but not built and is queued behind the console's binary-compile work, so it
cannot be where this warning lives first. When it exists, a home-repo panel is
the natural home — and it will not be key-shaped, since "this repo has no remote"
is derived git state rather than a registry key.

## 4. How the URL reaches rt

`SetupIntent` (`lib/setup/intent.ts`) gains a top-level `homeRepo?: string`. It
is orthogonal to `mode` — a `create` and a `join` both need one, and `restore`
keeps its own under `restore.homeRepo`. Parsing is an unvalidated `JSON.parse`
cast, so no `v` bump is required.

The Mac app's setup collects it and writes the intent, the same way
`TeamChoiceModel` already calls `rt setup intent restore`. **Deferring is a
first-class answer**: choosing nothing yields a local-only repo and a warning,
never a blocked install. Whether the app also offers to create a remote repo on
the operator's behalf is the installer lane's design question, not this spec's —
it needs `gh` auth and a `repo` scope, a heavy ask at first run.

The installer lane owns the intent field, the app screen, and the step list.
This spec owns §1-§3.

## 5. The headless gate is already here, and goes with this change

The installer lane's gate — which stops `home.init` being enqueued headless with
no URL — is **already on this branch as `bc02814`** (a cherry-pick of their
`8e50d23`). Do not cherry-pick it again.

Its justification is that the only reachable outcome is failing on auth, which
stops being true the moment no-URL succeeds. Left in place it would leave a
clean-room install with **no home repo at all** while everything downstream
assumes there is one. So **delete the `applies` clause and its comment block in
the same commit that adds local-only creation**, so the tree is never in a state
where the gate exists but is pointless.

**Keep its third test** — "still applies interactively with no RT_HOME_URL" —
with its expectation rewritten for this design. It is what catches this change
quietly disabling the step for real users.

## Testing

- **Local-only init produces a working repo**: `user/` is a git repo on `main`
  with an initial commit, no remote, and every artifact the clone path produces.
- **Resolution order**, each rung in turn — and specifically that an intent
  `homeRepo` beats `RT_HOME_URL`, which is the case current plumbing gets wrong.
- **An existing repo is never re-initialised**, with and without a remote.
- **The daemon skips the push with no remote** and broadcasts no
  `home:push-failed` — asserted over several cycles, since the bug this prevents
  is per-cycle spam.
- **Attaching a remote pushes the backlog** without a new commit and without a
  restart. Drive it with a janitor tick (`janitorIntervalMin`, default 30) — the
  only cycle that fires with no file change. The existing `setTimeout`/`now` deps
  support this; "no restart" does not mean "immediately".
- **Green requires a completed push.** Each of the four states renders correctly;
  specifically, a remote with no `refs/remotes/origin/<branch>` and a remote with
  unpushed commits both report `needs-you`, not `ready`. This is the assertion that stops the probe
  reporting shape instead of outcome.
- **Tests build the whole sequence, not just the fixture: `git init` → commit →
  attach a remote → first push → second push.** A clone arrives with upstream
  configured, an origin, and history, which is why every defect found reviewing
  this spec was invisible on the author's machine — and each one lived in a
  different step of that sequence, so a fixture alone would not have caught them
  all.
- **The probe's status is `needs-you`**, asserted explicitly — `skipped` would
  render as info and show no warning.
- **A `lastPush` record survives a commit cycle** (the clobber case).
- **`rt verify` shows the home row as a warning, not a failure.** Assert *that
  row's* status and severity — **not** that the whole run passes, because
  `access.team-repo` is `required: true` and reports `missing` on a machine with
  no team remote (`lib/setup/validators/access.ts:50-56`), which is a critical
  failure unrelated to this change.
- **`home.init` still applies interactively with no URL** (the kept gate test).

**Test against a HOME with no clone.** This machine cannot detect a regression
here: `home.init` short-circuits on the existing clone, so the path never runs
locally. That is the same shape as the bug this spec fixes — the code looked fine
because the failing path was never exercised.

## Out of scope

- **`rt home remote set <url>`** — the obvious follow-up verb for attaching a
  remote to an existing repo. Today's remedy is the `git remote add` command in
  §2, and the row says so rather than implying an affordance that does not exist.
- Creating a remote repo on the operator's behalf (installer lane; needs `gh`
  auth and a `repo` scope).
- The settings-page home-repo panel — the page does not exist yet.
- Migrating anyone off the old default. Nobody is on it: it is private to its
  owner, so every other operator's `home.init` failed rather than cloning it.
