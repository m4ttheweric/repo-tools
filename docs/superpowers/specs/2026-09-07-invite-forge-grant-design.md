# Invite forge grant, and pull-only members (MAT-409)

Status: approved 2026-09-07. Implements MAT-409; MAT-415 attaches to it later.

## Problem

`rt team invite` advertises "and grant them forge read access" and never does.
The grant is gated on `rtMayManageMembership`, and nothing in rt writes that
field, so every invite falls to the skip branch and prints one manual step. The
invitee cannot clone the team repo until a human adds them on the forge by
hand, and leg 1 of "the pack lands" begins with that clone. Every VM join pass
granted its joiners out of band.

The grant code itself is complete and correct for both forges
(`lib/team/forge.ts`). Only the permission that unlocks it is unreachable.

Two facts found while mapping it decide most of the design:

1. `createdByRt` **is** written, at `lib/team/create.ts:146`, but only on the
   `gh repo create` path. A pasted `--remote` never sets it, and there is no
   rt-creating path for GitLab at all.
2. MAT-405 made every member's daemon push straight to the team repo's default
   branch. A member granted read-only therefore clones fine and then pushes
   forever against a permission they do not hold.

## Rulings this implements (Matt, 2026-09-07)

- The grant is **read-only**: GitHub `pull`, GitLab Reporter (20). The level
  `grantRead` already asks for.
- rt manages forge access **only on repos rt itself created**. Everywhere else
  it grants nothing and touches nothing: precise needs-you rows, and "your
  admin gives you access; that decides."
- **Members never push.** The member-side snapshot daemon goes pull-only in
  this same change, or a fresh join produces a daemon erroring on rejected
  pushes against its own read-only grant.
- **No unprotecting branches, anywhere, ever.** MAT-408's unprotect-main
  framing is superseded.
- A member's team-scope write **refuses at the choke points**, exit 2, naming
  the future proposal flow.

## The record: two provenance facts, one permission

`TeamLocalRecord` (`lib/team/team-local.ts`, `~/.mattstack/rt/teams/<slug>.json`,
0600, never synced) gains a third field:

| field | means | written by |
| --- | --- | --- |
| `createdByRt` | rt ran `gh repo create` for this remote | `create.ts:146` (exists) |
| `joinedByRt` | this clone arrived by redeeming an invite | `joinRedeem` (new) |
| `rtMayManageMembership` | the operator asked rt to manage membership here | the offer (new) |

`joinedByRt` mirrors `createdByRt` exactly: provenance, recorded at the one
moment it is knowable, conferring no rights. It belongs in this file for the
same MAT-387 reason the permission does. A synced role flag would let a team's
author decide what a member's daemon does on the member's own machine.

**Absent means false means pushes.** No migration. A clone that predates the
field keeps the behavior it has today, because nothing recorded how it arrived.
The alternative default silently stops the owner's own sync, which is the worse
failure by a wide margin.

This is also why the signal is not derived from the setup intent: `mode:
"create" | "join"` is cleared on success (`apply.ts:141`, `join.ts:441`) and
does not survive into steady state, let alone a daemon restart.

## Part A: the grant

### The gate becomes three-way

`mintInvite`'s branch (`lib/team/invite.ts:171`) grows a third case:

| state | outcome | steps |
| --- | --- | --- |
| permission held | `grantRead` as today | whatever it returns |
| `createdByRt`, no permission | `skipped` | names the opt-in command |
| not `createdByRt` | `skipped` | the forge's own member page, plus "your admin gives you access; that decides" |

The third case is the common one and the one that must read well: it is Matt's
own team (an employer repo), every GitLab team, and every pasted remote.
`forge.ts` already builds those member-page URLs in `githubBaseSteps` /
`gitlabBaseSteps`; export a `membershipSteps(remote, handle)` that reuses them
rather than writing the URLs a second time. An unparseable remote yields `[]`,
matching `grantRead`'s own skipped contract.

### Two doors to the permission

**`rt team manage-membership [on|off] [--team <slug>] [--json]`** is the
headless door and the one the needs-you text names. The bare form prints the
current state and whether the permission is offerable at all. Turning it `on`
where `createdByRt` is false is refused, not merely ineffective: rt does not
administer a repo it was pointed at.

**A TTY prompt at invite time** is the door an owner actually walks through,
because that is the moment the question is concrete ("add luke to this repo?")
rather than abstract. It runs in `commands/team.ts` before `mintInvite`, via
the prompt facade `teamCreate` already uses, gated on `interactive()`
(`isTTY && !RT_BATCH`) and `!json`. Answering yes writes the permission, and
`mintInvite` then reads it through its existing seam with no change to its gate
beyond the messaging. Non-TTY, `--json`, and `RT_BATCH` keep today's exact
shape: same envelope, same exit code, new steps text.

Prompting in the command layer rather than inside `mintInvite` keeps the mint
free of UI and keeps the prompt from landing after the relay POST has already
mutated the world.

### No capability probe

An earlier sketch probed the forge for the caller's own access level before
offering. It is not needed: `createdByRt` already answers "is this rt's repo",
and `grantRead` already classifies a real 403 as `insufficient-permission` with
honest steps. A probe would add an API call, a failure mode, and a second
source of truth for the same question.

### Honesty fixes

- `lib/command-tree-def.ts:1851` describes invite as "and grant them forge read
  access". It becomes conditional.
- `lib/setup/validators/access.ts:70` says rt needs "read/write access to your
  team's home repo". On a pull-only clone that is wrong; the row says read.

## Part B: pull-only members

### It means no commit, either

Pull-only is not push suppression. A clone that commits locally and never
pushes grows `ahead`, turns every pull into a rebase, and eventually parks on a
conflict its owner cannot resolve by pushing. MAT-415's invariant is the right
one and it is cheaper: the member's tree is always clean, so fast-forward is
always sufficient and a member can never reach the conflict path at all.

So a pull-only spec skips the auto-commit, skips the janitor commit, never arms
the push timer, and returns early in `doPushInner` as a backstop. `pullNow`,
the fetch, the boot pull, `schedulePull`, and the conflict marker are untouched.

### Where it attaches

The decision is computed once per clone in the supervisor
(`lib/daemon/team-snapshots.ts`), which knows the slug, and carried on the spec
next to `pull` where `teamSnapshotSpec` already decides what kind of repo this
is (`lib/daemon/home-snapshot.ts:352`). Enforcement sits at the two git-calling
seams: the commit in `doRun` and the push in `doPushInner` (`:838-868`). Both
are singular; `doPushInner` has exactly one caller chain.

`SnapshotStatus` exposes the mode so `team.sync` and `rt team status` can say
"pull-only" instead of leaving a member wondering why nothing pushes.

### A clone that is already ahead

Member clones already exist (the VM guests, any earlier joiner) and may carry
local commits or a dirty tree when this ships. Fast-forward will fail there.
That surfaces as a `team.sync` needs-you naming the divergence. rt does not
auto-reset the clone: discarding a human's uncommitted work to tidy a state
transition is exactly the kind of destructive convenience this codebase refuses
elsewhere.

### What this replaces

Today a rejected push retries forever on geometric backoff capped at an hour,
and in status it looks identical to a transient network failure. There is no
"this needs a human on the forge" state at all. Pull-only removes the cause instead of
adding a classifier for the symptom.

## Part C: refusing member-side team writes

### Why refusal and not a warning

A member's team-scope write does not merely fail to reach the team. Verified
against a scratch repo: an uncommitted change to a tracked team file makes
`git merge --ff-only` fail outright ("Your local changes to the following files
would be overwritten by merge", exit 1). A silent local write therefore **jams
that clone's pulls** until a human cleans it up. A guard that leaves any path
open leaves a member one command away from a stuck clone.

### The inventory

Every path by which a member machine can write team scope today. None is
identity-checked anywhere; `resolveStorePath` selects a team store purely by
which clone exists locally.

| path | writes | verdict |
| --- | --- | --- |
| `rt settings set/unset --scope team` (`commands/settings-keys.ts:259,323`) | ~30 registered keys | refuse |
| settings-kit `POST /set` with `scope:"team"` (`packages/settings-kit/src/server.ts:259,299`) | same keys, from any console/board/deck UI | refuse |
| `saveVariation` (`lib/variations.ts:96`) | `rt.variations` | degrade, see below |
| VSCode legacy import (`extensions/vscode/rt-context/src/branchNaming.ts:65`) | `rt.branchNaming` | degrade, see below |
| `rt team publish` (`lib/team/publish.ts:74`) | pushes straight to the forge | refuse |
| `rt team members sync` (`lib/team/members.ts:149,236`) | roster, `.sops.yaml`, re-encrypts every secret | refuse |
| `rt team members remove` (`lib/team/members.ts:377,389,399`) | roster, recipients, re-encrypt | refuse |
| `rt secrets set/rotate --team` (`commands/secrets.ts:134,187,247`) | `mattstack/secrets/*.json` | refuse |
| `rt setup slack create-app` (`commands/setup.ts:1037,1049`) | `mattstack.integrations` + two team secrets | refuse |

### The guards

**One choke point covers four rows.** `resolveStorePath`
(`packages/rt-client/src/settings/write.ts:212-231`) is where every settings
write picks a team store: the CLI, the HTTP surface, variations, and the
extension all funnel through it. The guard goes there.

rt-client needs to read one field of a record the CLI owns. To keep a single
source of truth for the location, `teamLocalPath` moves into rt-client's
`paths.ts` beside `teamSettingsPath`, and `lib/team/team-local.ts` imports it;
rt-client reads only `joinedByRt`, the CLI keeps owning the whole record and
its Probes seams. Only the path is shared, and it is shared rather than copied.
The shared helper must keep taking the home directory explicitly, or the
Probes-seamed tests that run against a fake home stop working.

**Three explicit guards** for the paths that do not go through settings:
`rt team publish`, `rt secrets --team`, and `rt team members sync|remove`.

**Two degrade instead of refusing**, because a refusal there is a regression in
an unrelated command:

- `saveVariation` is reached from `rt run`. It catches the pull-only refusal
  and writes user scope with a one-line notice. Failing a member's `rt run`
  because a variation could not reach the team is not an improvement.
- The VSCode extension's legacy import is a silent background migration. It
  skips silently.

### Error text

Exit 2 with a `UserActionableError`, and it names the flow that will make the
change possible rather than only saying no: this machine joined by invite, its
clone is pull-only, team settings changes will be proposed to the owner for
approval (MAT-415), and until that ships the owner makes the change.

### The Install trap

`lib/setup/steps/secrets.ts:36` drains staged secrets into the team store for
`team-<slug>-(rt|board)` domains, and a joiner runs the full Install checklist.
The guard must not turn a joiner's Install red. Whether that step can be
reached with staged team secrets on a joined machine is a question the
implementation answers with a test before the guard lands, not an assumption.

## Non-goals

- **Branch protection of any kind.** No unprotecting (ruled out outright), and
  no protect-at-create scaffolding either: that is MAT-415's, where it pairs
  with members holding a branch-capable role.
- **A GitLab repo-create path.** Consequence, stated plainly: every GitLab
  team, the VM harness included, is permanently a needs-you repo where rt
  grants nothing. That is the ruling working as intended, not a gap.
- **Push-level grants.** MAT-415 raises members to branch-capable when
  proposals ship.
- **Proposal branches** (MAT-415). This design only has to not foreclose them,
  and pull-only-with-a-clean-tree is the state they build from.
- **An owner check on the settings surface generally.** The guard keys on this
  machine's own provenance, not on a claim about who the caller is.
- No `SCHEMA_VERSION` bump: nothing here adds a table. No rt-client publish:
  `dist` is rebuilt locally per CLAUDE.md because `file:` consumers copy it.

## Testing

Test-first throughout. `bun run test:all` is the gate, not `bun run test`:
e2e is a separate script and verbatim formats fail only there.

Existing tests that change deliberately, not around:

- `lib/team/__tests__/invite.test.ts:434-497`, the "forge membership is not
  rt's to grant" block. Its `!createdByRt` cases keep their meaning exactly;
  the `createdByRt`-without-permission case gains the offer's steps.
- `commands/__tests__/team.test.ts:248`, which pins the current
  "Ask whoever administers" string verbatim.

New coverage: the three-way gate; `manage-membership` on/off/bare and its
refusal where `createdByRt` is false; the TTY offer writing the permission and
the non-TTY path keeping its envelope byte for byte; `joinedByRt` written by
redeem and absent-means-pushes; a pull-only spec that fetches and
fast-forwards but never commits or pushes; a pull-only clone that cannot
fast-forward reporting needs-you rather than resetting; each refusal guard;
`saveVariation`'s degrade; and the Install secrets step staying green on a
joined machine.

e2e gets the `manage-membership` `--json` envelope and usage string, since
team has almost no e2e coverage and this repo's exact-string assertions live
there.

## Files

`lib/team/team-local.ts`, `lib/team/invite.ts`, `lib/team/forge.ts`,
`lib/team/join.ts`, `lib/team/members.ts`, `lib/team/publish.ts`,
`commands/team.ts`, `commands/secrets.ts`, `commands/setup.ts`,
`lib/variations.ts`, `lib/command-tree-def.ts`,
`lib/daemon/home-snapshot.ts`, `lib/daemon/team-snapshots.ts`,
`lib/setup/validators/access.ts`, `lib/setup/validators/rt-health.ts`,
`packages/rt-client/src/settings/{write,paths}.ts`,
`extensions/vscode/rt-context/src/branchNaming.ts`, `lib/setup/steps/secrets.ts`,
plus generated docs.

`lib/module-registry.ts` needs no entry: `manage-membership` lands in
`commands/team.ts`, already registered.
