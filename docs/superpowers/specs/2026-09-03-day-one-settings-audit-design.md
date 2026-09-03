# Day-one settings audit: what a new teammate ends up with

2026-09-03, MAT-403. A pass over every registered settings key from the
JOINER's seat: someone who redeems an invite to a team that already exists,
runs Install on a fresh Mac, and expects to work. The enumeration is the suite
registry (`packages/rt-client/src/settings/registry-defs.ts`, 78 keys), not
memory, and every day-one state below was read out of the code that writes it
rather than inferred.

The 2026-09-02 footprint audit on MAT-403 covered the team store's own
contents and landed corrections C1-C11. This pass does not redo that work. It
asks a different question: given a healthy team store, what does the joiner's
resolved surface actually look like when Install finishes.

## What has changed since 2026-09-02

Four things moved, and each closes gaps the earlier pass had to leave open:

- **MAT-405 (rt#185)** gave every clone under `~/.mattstack/teams/<slug>/` its
  own snapshot engine: it commits the team zone, pushes with rt's stored forge
  token, and fast-forward pulls every `pullIntervalSec`. A `--scope team` write
  or a `members sync` now reaches every member without a hand commit or pull.
- **`git.identity`** (Install step 6) writes the global `user.name` and
  `user.email` from the connected forge profile when the machine has none, so
  the snapshot engine has a committer git can resolve.
- **MAT-402's spec** mapped the plugin and bindings legs of a team pack landing
  on a joiner, and filed seven gaps. Three became tickets: MAT-409, MAT-410,
  MAT-411.
- **C1-C11** put the team's forge, tracking, Linear team key, switchboard URL
  and the first team secrets into the team scope, where they propagate.

## Reading the table

**Day-one state** is what the key resolves to on a joiner's machine the moment
`rt setup apply` finishes, on a fresh Mac, having redeemed an invite to a team
whose owner has authored the team store.

Verdicts:

- **travels** ... the team store carries it and the joiner inherits it.
- **seeded** ... an Install step writes it.
- **default** ... the registry default is correct for a joiner.
- **app-owned** ... the consuming app writes it on first run; rt has no part.
- **by hand** ... nobody writes it and nothing breaks; the joiner sets it when
  they want the behavior.
- **GAP** ... something a joiner needs is missing, wrong, or silently absent.

## The audit table

### `rt.*`, per-repo (repo-scoped sections under `repos.<identity>`)

These live in whichever store declares them and apply only once the repo is
cloned AND indexed. `repos.clone` (step 10) does both, awaiting
`updateRepoIndexAsync` before it returns.

| Key | Scopes | Who writes it | Day-one state for a joiner | Verdict | Correction |
|---|---|---|---|---|---|
| `rt.roles` | user/team/machine | team owner, by hand | inherited from the team store; live after `repos.clone` | travels | none |
| `rt.intercepts` | user/team/machine | team owner, by hand | **inherited but never installed**: `intercepts.install` runs at step 8, two steps before the clone | **GAP** | C-A |
| `rt.worktrees` | user/team/machine | team owner, by hand | inherited; `{onDeck:0}` default otherwise | travels | none |
| `rt.worktreeReadyApproval` | user/team/machine | `rt worktree` on first approval | unset; the joiner approves a team-authored ready ladder once, by design | by hand | none |
| `rt.sync` | user/team/machine | team owner, by hand | inherited | travels | none |
| `rt.branchNaming` | user/team/machine | team owner, by hand | inherited | travels | none |
| `rt.variations` | user/team/machine | team owner, by hand | inherited | travels | none |
| `rt.presets` | user/team/machine | the operator, by hand | unset; personal | by hand | none |
| `rt.dopplerTemplate` | user/team/machine | team owner, by hand | inherited | travels | none |
| `rt.hooks` | user/team/machine | `rt hooks` | unset until the joiner enables one | by hand | none |

### `rt.*`, machine and user

| Key | Scopes | Who writes it | Day-one state for a joiner | Verdict | Correction |
|---|---|---|---|---|---|
| `rt.repoIdentityOverrides` | machine | by hand | unset; only forks and multi-remote checkouts need it | by hand | none |
| `rt.repoRoots` | machine | `settings.seed` (step 9) | seeded from a detected candidate dir, or `~/Documents/GitHub` created when the team declares repos | seeded | none |
| `rt.notifications` | user | `rt notifications` | unset; the notifier falls back to its own defaults | by hand | none |
| `rt.cron` | machine | `cron.triage` (step 17) | one trigger when `board.triage.enabled`, else nothing | seeded | none |
| `rt.repoTracking` | machine | `rt daemon track` | unset, and correct: `loadRepoTracking` folds the team's `mattstack.tracking` in for every cloned+indexed repo | travels | none |
| `rt.runsPruneDays` | machine | default 30 | 30 | default | none |
| `rt.runaway` | machine | by hand | unset; guard uses its own thresholds | by hand | none |
| `rt.workspacePrefs` | machine | by hand | unset; the joiner picks an editor when they first open a tree | by hand | none |
| `rt.homeSnapshot` | machine | default | enabled, 20s debounce, 60s push delay | default | none |
| `rt.teamSnapshot` | machine | default | enabled, 300s pull interval; this is what makes the team store propagate | default | none |
| `rt.worktreeApp` | machine | the worktree hook installer | set once the joiner installs the hook | app-owned | none |
| `rt.sdmEnrichment` | team | team owner, by hand | inherited | travels | none |
| `rt.logRetentionDays` | machine/user | default 14 | 14 files, not 14 days | default | none |
| `rt.logLevel` | machine/user | default | `info` | default | none |
| `rt.apiPort` | machine/user | default | 9401 | default | none |
| `rt.daemonPath` | machine | by hand | unset; daemon uses its inherited PATH | by hand | none |
| `rt.trustedBrowserOrigins` | user/machine | by hand | `[]` | default | none |
| `rt.integrations` | user | `rt setup <id> connect` | `forgeHost` written when the joiner connects a forge; `switchboardUrl` when they confirm one | seeded | none |

### `mattstack.*`

| Key | Scopes | Who writes it | Day-one state for a joiner | Verdict | Correction |
|---|---|---|---|---|---|
| `mattstack.integrations` | team | `team.create` scaffold writes `forge`; the owner adds the rest | inherited whole; drives every `account.<id>` checklist row | travels | none |
| `mattstack.tracking` | team | team owner, by hand | inherited; `repos.clone` clones each declared repo | travels | none |
| `mattstack.appPath` | machine | `settings.seed` | seeded, and refused for a DMG or translocated path | seeded | none |
| `mattstack.mode` | machine | `rt settings dev-mode` | unset, which is correct: `resolveIntendedMode` derives the flavor from the running wrapper | default | none |
| `mattstack.roster` | team | **nobody** | **absent unless the owner hand-authored it, and the joiner is never appended**: `rt team invite` writes `board.members` only | **GAP** | C-D |

### `claude.*`

| Key | Scopes | Who writes it | Day-one state for a joiner | Verdict | Correction |
|---|---|---|---|---|---|
| `claude.marketplaces` | user/team | by hand | unset, and correct: `computeMarketplaces` adds the team clone directory unconditionally whenever a team is joined | by hand | none |
| `claude.plugins` | user/team | by hand | unset, and correct: `computePlugins` derives the reference from the clone's own `marketplace.json` | by hand | none |

### `deck.*`

| Key | Scopes | Who writes it | Day-one state for a joiner | Verdict | Correction |
|---|---|---|---|---|---|
| `deck.apps` | user | deck | written by deck as apps are published | app-owned | none |
| `deck.access` | user | deck | written by deck | app-owned | none |
| `deck.platform` | machine | deck setup | unset until the joiner runs deck's own setup; only an operator publishing publicly needs it | app-owned | none |

### `board.*`, team scope

Every row here travels with the clone. `team.create` scaffolds only `board.title`
and, for a GitLab forge, `board.gitlabHost`; the rest are the owner's to author,
deliberately, so an empty scaffold value cannot flip a running board's
store-ownership latch.

| Key | Scopes | Who writes it | Day-one state for a joiner | Verdict | Correction |
|---|---|---|---|---|---|
| `board.gitlabHost` | team | `team.create` scaffold (GitLab forge) | inherited | travels | none |
| `board.projects` | team | team owner, by hand | inherited | travels | none |
| `board.members` | team | `rt team invite`, `rt team members sync` | inherited, and the joiner's own handle is appended by the invite that brought them in | travels | none |
| `board.title` | team | `team.create` scaffold | inherited | travels | none |
| `board.botUsernames` | team | team owner | inherited | travels | none |
| `board.ticketPrefixes` | team | team owner | inherited | travels | none |
| `board.slack` | team | team owner | inherited; the client secret is a team secret, not this key | travels | none |
| `board.doctorSkill` | team | team owner | inherited | travels | none |
| `board.triage.doctorSkill` | team | team owner | inherited | travels | none |
| `board.tabs` | team | team owner | inherited | travels | none |

### `board.*`, user scope

| Key | Scopes | Who writes it | Day-one state for a joiner | Verdict | Correction |
|---|---|---|---|---|---|
| `board.staleAfterDays` | user | by hand | unset; board uses its own default | by hand | none |
| `board.workspaces` | user | by hand | unset; panes launch into no named workspace | by hand | none |
| `board.defaultMember` | user | **nobody** | **unset: the joiner's board does not know which roster member they are**, though the invite just proved their forge handle | **GAP** | C-C |
| `board.hiddenMembers` | user | by hand | unset; nothing hidden | by hand | none |
| `board.triage` | user | by hand | unset, so `cron.triage` skips; opt-in by design | by hand | none |

### `board.*`, machine scope

| Key | Scopes | Who writes it | Day-one state for a joiner | Verdict | Correction |
|---|---|---|---|---|---|
| `board.claudeCommand` | machine | by hand | unset; board falls back to a plain `claude` | by hand | none |
| `board.cwds` | machine | `board.keys` (step 16) | seeded to the first tracked repo under `rt.repoRoots[0]`, else logged and left unset | seeded | none |
| `board.triageMaxConcurrent` | machine | by hand | unset; board uses its own cap | by hand | none |
| `board.switchboardUrl` | machine | **nobody in rt** | unset; a team fact at machine scope, duplicating `mattstack.integrations.switchboard.url`, which the team store already carries (C4) | note | recorded, MAT-399 |

### `boxscore.*`

| Key | Scopes | Who writes it | Day-one state for a joiner | Verdict | Correction |
|---|---|---|---|---|---|
| `boxscore.projects` | team | team owner | inherited | travels | none |
| `boxscore.linearDoneStates` | team | team owner | inherited | travels | none |
| `boxscore.sizeBand` | team | team owner | inherited | travels | none |
| `boxscore.excludeFilePatterns` | team | team owner | inherited | travels | none |
| `boxscore.ignoredMrs` | team | team owner | inherited | travels | none |
| `boxscore.botPatterns` | team | team owner | inherited | travels | none |
| `boxscore.hiddenMembers` | user | by hand | unset; reads names out of `mattstack.roster`, which C-D is about | by hand | none |
| `boxscore.defaultRange` | user | by hand | unset; boxscore uses its own window | by hand | none |

### `gitq.*`

| Key | Scopes | Who writes it | Day-one state for a joiner | Verdict | Correction |
|---|---|---|---|---|---|
| `gitq.workSlots` | machine | `board.keys` | seeded to `<repoRoot>/.gitq-slots`, 3 slots, when a repo root exists | seeded | none |
| `gitq.forges` | user | gitq | written by gitq; token env NAMES only, never a token | app-owned | none |
| `gitq.board` | machine | `board.keys` | seeded with the tracked repo names and port 11008 | seeded | none |

### `chat.*`

| Key | Scopes | Who writes it | Day-one state for a joiner | Verdict | Correction |
|---|---|---|---|---|---|
| `chat.handle` | user | by hand | unset, and correct: the agent handle is derived per repo and directory | by hand | none |
| `chat.humanHandle` | user | **nobody** | **resolves to the registry default, which is one specific person's handle** | **GAP** | C-B |
| `chat.viewerUrl` | user | default | `https://chat.mattstack`, the domain deck serves the viewer on for every install | default | none |
| `chat.herdrWorkspace` | user | default | `chat` | default | none |
| `chat.push.provider` | user | by hand | unset; no push until the joiner configures one | by hand | none |
| `chat.push.target` | user | by hand | unset | by hand | none |

### `agent.*`

| Key | Scopes | Who writes it | Day-one state for a joiner | Verdict | Correction |
|---|---|---|---|---|---|
| `agent.model` | user/machine | by hand | unset, so `rt agent` omits the flag | by hand | none |
| `agent.effort` | user/machine | by hand | unset, flag omitted | by hand | none |
| `agent.account` | user/machine | by hand | unset, default profile | by hand | none |
| `agent.extraArgs` | user/machine | by hand | unset | by hand | none |

## The four corrections, and their ruling

All four were ruled to land on this branch (2026-09-03). No new registry key
and no rt-client publish: the registry on `main` is behind published rt-client
0.14.0, so a key added here would collide with the three that live only on the
held gate-events branch.

### C-A. `intercepts.install` runs before the repos it needs exist

**Evidence.** `STEP_IDS` (`lib/setup/contract.ts`) puts `intercepts.install` at
position 8 and `repos.clone` at position 10. `installShims()` calls
`buildInterceptRules()` (`lib/endpoint/shim.ts`), which iterates
`loadRepoIndex()` and emits a rule only for a repo that is in that index. On a
fresh machine the index is empty at step 8, so the function returns `[]` and
`writeInterceptRules([])` persists an empty cache stamped with the current time.

Nothing re-runs the step. `rt home init`'s materialize phase also runs
`rt intercept install`, but `home.init` is step 1, earlier still.

The failure is silent in both directions a joiner could notice it:

- `rt verify`'s `tool.intercepts` row calls `shimReport()`, which reads the
  cached rules. An empty cache yields `report.length === 0`, and the row
  returns `status: "skipped"` with "no intercepts declared" instead of a
  warning.
- `staleIntercepts()` compares the cache's `generatedAt` against the mtime of
  each source store file. The team clone was written at step 4, before the
  cache at step 8, so the cache is newer and the probe reports not-stale.

Net: a team that declares `rt.intercepts` for its repo gets no shim on any
joiner's machine, and every surface that could say so says the opposite.

**Correction.** Move `intercepts.install` to sit immediately after
`repos.clone` in `STEP_IDS` and in `STEPS` (`lib/setup/steps/index.ts`), which
must stay in lockstep. `path.link` (step 7) already created `~/.local/bin` and
put it on PATH, and nothing between the two positions depends on the shims, so
the move has no other consequence. `repos.clone` awaits
`updateRepoIndexAsync` before returning, so the index is populated, not racing.

The pinned order is asserted in `lib/setup/__tests__/contract.test.ts`; that
assertion moves with it. The step list in
`docs/superpowers/specs/2026-08-21-rt-setup-contract.md` is a dated design
record and is not rewritten; this spec is the record of the change.

**Test.** A test that builds a context whose repo index is empty at
`intercepts.install`'s old position and populated at its new one, asserting the
rules cache is non-empty after apply. Red before the reorder.

### C-B. `chat.humanHandle` defaults to one specific person

**Evidence.** `registry-defs.ts` gives `chat.humanHandle` the default `"matt"`.
Nothing writes the key, so every joiner resolves that value. Two live consumers
act on it:

- `lib/daemon/handlers/chat.ts` turns a post into an `@here` broadcast only
  when the poster's handle equals `chat.humanHandle`. A joiner's own posts
  therefore never wake the room, which is the opposite of the wake model's
  intent.
- `commands/chat.ts` and the DM handlers use it as the human's address, so an
  agent told to mention "the human" mentions a handle that does not exist on
  that machine.

**Correction.** Seed the key at Install from the joiner's forge login.
`forgeLogin(p, provider, host, token)` already exists in `lib/team/forge.ts`
and is what `joinRedeem` uses to prove the joiner's handle, so this adds no new
mechanism. The seed goes in `board.keys` (step 16), which already owns the
"resolve a fact, write it only when the key is unset" idiom and runs after both
the team clone and the forge connect. It degrades the way that step's other
branches do: no forge connected, or no login resolvable, logs a line and leaves
the key alone.

The registry default is left in place. Removing it would make an unseeded
machine resolve empty, and the DM handlers refuse loudly on an empty handle;
that refusal is the right behavior for a misconfigured machine but a
regression for one that simply has no forge. The seed is what makes the default
stop mattering.

**Test.** `board.keys` with a stub forge login writes `chat.humanHandle`; with
the key already set it does not overwrite; with no forge it logs and leaves it.

### C-C. `board.defaultMember` has no writer

**Evidence.** Grepping `lib/` and `commands/` finds no writer for
`board.defaultMember` anywhere in rt, and the registry gives it no default. The
key names which roster member the local board runs as, and the invite the
joiner just redeemed proved exactly that handle.

**Correction.** The same `board.keys` seed as C-B, from the same resolved
forge login, written at user scope and only when unset.

**Test.** Covered by C-B's test, extended to assert both keys.

### C-D. `mattstack.roster` is never appended

**Evidence.** `mattstack.roster` is registered at team scope and described as
the cross-app roster successor. It has zero writers and zero readers in rt.
`rt team invite` (`lib/team/invite.ts`) appends the invitee to `board.members`
and nothing else, and `rt team members sync` (`lib/team/members.ts`) maintains
`board.members` alone. `boxscore.hiddenMembers` is documented against
`mattstack.roster`, so a joiner is invisible to the app that reads it.

**Correction.** `rt team invite` appends the handle to `mattstack.roster` as
well as `board.members`, using the same team-scope write and the same
already-validated handle. The append is idempotent on the handle, matching
`board.members`' own behavior, and a store with no roster starts one.

**Test.** Invite against a fixture store with and without an existing roster;
a second invite of the same handle does not duplicate.

## Recorded, not implemented here

Each of these is real and evidenced, and each belongs to a ticket or a repo
that is not this branch.

| Finding | Where it belongs |
|---|---|
| The invite's forge-access grant is dead code: `rtMayManageMembership` is never written, so every joiner needs a manual forge grant before their clone can succeed | MAT-409 |
| A team pack's updates never reach Claude's plugin cache: the clone pulls a new pack version, the installed plugin stays stale | MAT-410 |
| `rt team invite` has no dry run; every call mints a real relay record and appends to the roster | MAT-411 |
| A team pack is installed never-enabled and nothing surfaces that, or names the command that enables it | MAT-402 spec, G1/R1 |
| The bindings merge gates on a retired `team.jsonc`, so a joiner's `skills.jsonc` is never written | MAT-402 spec, G2/R2, in the team repo and in mattstack-skills |
| `plugins.install` does not re-run after a team-snapshot pull changes the clone | MAT-402 spec, G3, and MAT-410 |
| Team repos are cloned without `--filter=blob:none`, so a joiner full-clones a product monorepo | MAT-402 spec, G4 |
| `rt setup pack`'s unbound-stage check is not in the apply order, so an unbound pipeline surfaces at runtime instead of install time | MAT-402 spec, G5 |
| `board.switchboardUrl` is a team fact at machine scope, duplicating `mattstack.integrations.switchboard.url` | MAT-399, and the C8 follow-up already open on MAT-403 |
| The Linear MCP server is a per-machine, per-person Claude Code config that nothing installs or checks | MAT-406 |
| A team store can carry a credential-shaped connection string in an `rt.variations` value, outside the encrypted store | the team's own repo; worth a convention, not an rt change |
| The release script commits the marketplace under one specific person's git identity | operator-only, out of the joiner's path |

## What this audit did not find

Worth stating, because each was a suspected gap on the ticket and is not one:

- `claude.marketplaces` and `claude.plugins` do not need team-scope values.
  `computeMarketplaces` adds the team clone directory unconditionally on any
  joined team, and `computePlugins` derives the install reference from the
  clone's own `marketplace.json`.
- Team-declared tracking reaches a joiner without a machine-scope write.
  `loadRepoTracking` folds `mattstack.tracking` over the machine map for every
  identity present in the repo index, with the raw machine map winning per repo
  so a local opt-out is never overwritten.
- `mattstack.mode` unset is correct, not missing. `resolveIntendedMode` derives
  the flavor from the running wrapper, and a consumer defaulting unset to prod
  would stand the dev pair down on a fresh machine.
- The `verify` step already gives `team.sync` a settle budget, so a joiner
  mid-first-pull is not judged before their clone has caught up.

## Acceptance

- A joiner whose team declares `rt.intercepts` for a tracked repo ends Install
  with those shims installed, and `rt verify`'s `tool.intercepts` row says so.
- A joiner's `chat.humanHandle` and `board.defaultMember` resolve to their own
  forge handle, not to a default and not to nothing.
- A joiner invited to a team appears in `mattstack.roster` as well as
  `board.members`.
- `bun test lib packages/rt-client`, `bun x tsc --noEmit`, `bun run docs:check`
  and `scripts/repo-purity.sh` all pass.

## Out of scope

Every row in "Recorded, not implemented here". Any new registry key, any
rt-client publish, and any change outside this repo.
