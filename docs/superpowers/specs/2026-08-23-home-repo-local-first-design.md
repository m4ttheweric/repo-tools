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

Resolution order for the clone URL:

1. `--url <url>`
2. the setup intent's `homeRepo` (see §4)
3. `RT_HOME_URL` in the environment
4. **none of the above → `git init` a local-only repo**

`DEFAULT_USER_REPO_URL` is **deleted**, not replaced. rt never invents a home
repo for someone.

The local-only path produces the same tree the clone path does — `user/` as a
git repo, `.gitignore`, `snapshot-owners.jsonc`, the machine-key file, the
profile directory, the `skills.jsonc` symlink — with an initial commit and no
remote. Every downstream consumer sees exactly what it sees today.

**A repo that exists is never re-initialised.** The existing short-circuit on an
already-present clone stays; local-only is only the behaviour for a first run
with no URL.

## 2. The snapshot daemon: "no remote" is a state, not a failure

Today `lib/daemon/home-snapshot.ts` pushes unconditionally and broadcasts
`home:push-failed` when the push fails (`:485`). There is no remote detection
anywhere in the module. A local-only repo would therefore fire a failure event
on every cycle — the difference between a supported state and a tolerated one.

The daemon checks for a configured remote before arming the push. With none:

- it commits on the same debounce, unchanged
- it **skips the push** — no push timer, no retry timer, no `home:push-failed`
- it logs the skip once at `debug`, not on every cycle

Everything commit-side is untouched: the janitor, claimed zones
(`snapshot-owners.jsonc`, `rt home claim|release`), and the live kill switch all
behave identically. This is deliberately not a new mode — it is one branch
before the push.

**A remote appearing later needs no restart.** The check reads the repo's
current remote at push time, so attaching one begins pushing on the next cycle.

## 3. Honesty: a local-only repo must never read as backed up

This is the real risk of always-create, and the part most likely to be got
wrong: **the user gets a working repo and reasonably assumes it is safe.**

`rt verify` renders over the health probes in `lib/setup/rt-health.ts`; a
non-required probe that reports anything other than `ready` renders as a
warning (`commands/verify.ts:70-75`). So the home-repo probe reports a distinct
non-`ready` state when the repo has no remote, and it is **not** marked
required — a warning, not a failed check. That satisfies the installer lane's
invariant that a probe which cannot verify must never report `ready`: nothing
has left this machine, so "backed up" cannot be verified.

Wording matters as much as the state. The row says what is and is not true:

> **home repo — local only.** Your settings are versioned on this machine but
> are not backed up anywhere. Add a remote to sync them.

Not "not configured" (it is configured, deliberately), and not an error (nothing
is wrong). The tray's health row carries the same state and the same sentence.

**Shipping surfaces are `rt verify` and the tray.** The settings page from
`2026-08-23-settings-console-page-design.md` is specced but not built, and is
queued behind the console's binary-compile work — so it cannot be where this
warning lives first. When it exists, a home-repo panel is the natural home for
the indicator. Note it will not be key-shaped: "this repo has no remote" is
derived git state, not a registry key, so it needs its own panel rather than a
row in the key table.

## 4. How the URL reaches rt

`SetupIntent` (`lib/setup/intent.ts`) gains a top-level `homeRepo?: string`.
It is orthogonal to `mode` — a `create` and a `join` both need one, and
`restore` already carries its own under `restore.homeRepo`.

The Mac app's setup collects it and writes the intent, the same way
`TeamChoiceModel` already calls `rt setup intent restore` for the restore flow.
**Deferring is a first-class answer**: choosing nothing yields a local-only repo
and a warning, never a blocked install. Whether the app also offers to create a
remote repo on the operator's behalf is the installer lane's design question,
not this spec's — it needs `gh` auth and a `repo` scope, which is a heavy ask at
first run.

The installer lane owns the intent field, the app screen, and the step list.
This spec owns everything under §1-§3.

## 5. The headless gate rides along

The installer lane holds an unpushed commit (`8e50d23`, branch
`fix/home-init-gate`) that stops `home.init` being enqueued headless with no
URL. Its justification is that the only reachable outcome is failing on auth —
which stops being true the moment no-URL succeeds. Left in place afterwards it
would leave a clean-room install with **no home repo at all**, while everything
downstream assumes there is one.

So it is cherry-picked into this change and removed in the same commit, so the
tree is never in a state where the gate exists but is pointless. **Its third
test is kept** — the one asserting `home.init` still applies interactively with
no URL — because it is what catches this change quietly disabling the step for
real users. Its expected reason changes; its value does not.

## Testing

- **Local-only init produces a working repo**: `user/` is a git repo with an
  initial commit, no remote, and every artifact the clone path produces.
- **Resolution order**, each rung in turn, including that a present `--url`
  beats an intent `homeRepo` beats `RT_HOME_URL`.
- **An existing repo is never re-initialised**, with and without a remote.
- **The daemon skips the push with no remote** and broadcasts no
  `home:push-failed` — asserted over several cycles, since the bug this prevents
  is per-cycle spam.
- **The daemon pushes once a remote is attached**, with no restart.
- **`rt verify` reports local-only as a warning, not a failure**, and the run
  still passes its critical checks.
- **`home.init` still applies interactively with no URL** (the kept gate test).

**Test against a HOME with no clone.** This machine cannot detect a regression
here: `home.init` short-circuits on the existing clone, so the path never runs
locally. That is the same shape as the bug this spec fixes — the code looked
fine because the failing path was never exercised.

## Out of scope

- Creating a remote repo on the operator's behalf (installer lane; needs `gh`
  auth and a `repo` scope).
- The settings-page home-repo panel — the page does not exist yet.
- Migrating anyone off the old default. Nobody is on it: it is private to its
  owner, so every other operator's `home.init` failed rather than cloning it.
