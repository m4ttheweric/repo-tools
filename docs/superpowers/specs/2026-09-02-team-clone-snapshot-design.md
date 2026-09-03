# Team clone snapshot (MAT-405)

Status: approved design, 2026-09-02. Ticket: MAT-405 (child of MAT-386).
Predecessors: RT-30 (home snapshot daemon), the 2026-09-02 GitLab two-VM
join passes on MAT-393, and the day-one audit on MAT-403.

## Problem

`~/.mattstack/teams/<slug>/` is a git clone the home repo ignores. After
`rt team invite`, `rt team members sync`, `rt secrets set --team` or
`rt settings set --scope team`, the change sits uncommitted in the owner's
clone; `rt team publish` pushes only committed work; nothing on a member's
machine ever pulls. So a joiner's age recipient, the roster, the team's
secrets and tracking never reach anyone without two hand steps the VM
harness currently performs in `rt-tray/vm/run/host/team-propagate.sh`:
the owner's `git commit` + `rt team publish`, and the joiner's credentialed
`git pull`.

The installer spec promised "rt commits every settings/secrets write to
the user or team repo and pushes in the background"; RT-30 delivered the
user half only.

## Rulings (Matt, 2026-09-02)

1. **Multi-writer.** Any member's local team commits push; the daemon
   rebases its own commits onto the remote; a real conflict is a
   needs-you row. (The team's members hold Developer on the team repo.)
2. **Pull cadence:** every 5 minutes, before every push, and at daemon
   boot. `rt team pull` for the impatient.
3. **Commit scope:** only `mattstack/`, `.sops.yaml` and
   `.claude-plugin/`. The rest of a team clone (acme-tools carries
   `src/`, `docs/`) stays hand-committed.
4. **Conflict:** abort the rebase, stop pushing that clone, surface a
   needs-you row; the clone keeps working locally.
5. **Join:** Install's `verify` step waits for the joiner's first pull to
   settle.
6. **Shape:** one snapshot engine, two specs (approach A below); not a
   second module, not a cron over the CLI verbs.

## Design

### 1. Engine and specs

`lib/daemon/home-snapshot.ts` already takes `repoDir`; what is
home-specific is a handful of constants: the kv namespace
(`home-snapshot`), the broadcast names (`home:snapshot`,
`home:push-failed`), the owners file (`snapshot-owners.jsonc`), the
push record, and the absence of any pull. Those become a `SnapshotSpec`:

```ts
interface SnapshotSpec {
  id: string;                       // "home" | `team:${slug}`
  repoDir: string;
  kvNamespace: string;              // "home-snapshot" | `team-snapshot:${slug}`
  eventPrefix: "home" | "team";     // home:snapshot, team:snapshot, ...
  /** Paths (relative to repoDir) the engine may stage; undefined = everything outside claimed zones. */
  scope?: (relPath: string) => boolean;
  /** Present on team specs: fetch + rebase policy. */
  pull?: { intervalSec: number };
  /** Present on team specs: the forge token rt holds for origin, or null. */
  tokenFor?: () => Promise<string | null>;
}
```

`startSnapshot(spec, deps)` replaces `startHomeSnapshot(deps)`; the home
call site builds the home spec with today's values, so the home instance
is behavior-preserving. The refactor lands as its own commit: pure move,
existing `home-snapshot.test.ts` green before any team code exists.

The team spec:

- `scope`: `mattstack/**`, `.sops.yaml`, `.claude-plugin/**`. Claimed
  zones (`snapshot-owners.jsonc`) apply the same way if a team ever
  declares them; the file is optional.
- `pull: { intervalSec: 300 }` from `rt.teamSnapshot` (below).
- `tokenFor`: `storedForgeToken(probes, originUrl)` from
  `lib/team/stored-forge-token.ts`; the push and every fetch go through
  `gitWithToken` (`lib/team/git-credential.ts`): env, never argv, never
  the URL.

### 2. Team clone supervisor

`lib/daemon/team-snapshots.ts`, started by the daemon beside the home
instance:

- At boot, lists `~/.mattstack/teams/*`; each entry that is a git repo
  with an `origin` gets one engine instance with the team spec. A clone
  without a remote is logged once and skipped.
- Watches `~/.mattstack/teams/` (non-recursive) so a clone created by
  `team.join` or `team.create` starts an instance within the debounce
  window, and a removed clone stops its instance. The watch cannot see an
  origin added inside an existing clone (`rt team publish --remote`
  edits `.git/config`), so the supervisor also rescans on a timer (the
  pull interval); that is how a clone without a remote becomes eligible.
- Settings: `rt.teamSnapshot` (machine scope, `merge: "deep"`,
  `migrated: true`) with the same fields as `rt.homeSnapshot` plus
  `pullIntervalSec` (default 300). Default `enabled: true`.
- `status()` returns one entry per clone; `team:snapshot-status` is the
  daemon verb.

### 3. Pull, push, conflict

Pull runs at boot, on the interval, and immediately before every push:

1. `git fetch origin` with the token.
2. If `origin/<branch>` is ahead and local has no daemon commits ahead:
   `git merge --ff-only`.
3. If local is ahead: `git rebase origin/<branch>` (the daemon's own
   commits are small store edits; rebasing them onto teammates' work is
   the multi-writer ruling).
4. A rebase that stops on a conflict (git leaves `rebase-merge` or
   `rebase-apply` under the git dir): `git rebase --abort`, persist
   `{ at, detail }` under the clone's kv namespace, emit
   `team:conflict { id, detail }`, and suspend pushes and the APPLYING of
   pulls for that clone until the marker clears. The fetch itself keeps
   running every tick: it is what notices the branch is no longer ahead
   (the clearing condition in 5) and what keeps `lastPullAt` fresh, so
   `team.sync` reports the conflict and not staleness on top of it. The
   working tree is back to the local branch; nothing is lost, nothing
   propagates. A rebase that never
   started (exit 1 with no such directory: unstaged changes outside the
   commit scope, an index lock) is not a conflict; it is skipped with
   git's reason and retried on the next tick, since a dirty `src/` is
   normal in a clone that is also a working repo.
5. The marker clears when the local branch is no longer ahead of
   origin (a hand rebase then `rt team publish`, or a reset); the next
   tick notices and resumes.

Push reuses the engine's existing scheduling and geometric backoff. A
push rejected as non-fast-forward is not a failure: it triggers a pull
and one immediate retry. One git operation runs at a time per clone: the
commit cycle and the pull share a guard, so a timer-driven rebase never
overlaps an add/commit. The forge token is read once per pull interval
per clone (a keychain read plus a sops decrypt), not per git call.

Surfaces:

- Checklist / verify row `team.sync` (kind `tool`, required: false,
  recheck `on-activate`): `ready` when every clone has no conflict, no
  standing push or fetch error, and a successful fetch within the last two
  pull intervals (a pull that never reached the remote does not count);
  `needs-you` naming the clone otherwise (conflict, push error, stale or
  never pulled, or a clone the daemon is not watching); `missing` when
  the daemon is down; `ready` naming `rt.teamSnapshot.enabled` when the
  setting is off, since the supervisor then holds no instance and every
  clone would otherwise read as unwatched forever. Lives beside
  `home.backup` in `lib/setup/validators/rt-health.ts`.
- `rt team status` gains `lastPull`, `lastPushAt`, `conflicted` per team
  (`lastPush`, origin/main's commit date, already exists).
- `rt team pull [--team <slug>]`: a manual cycle (fetch + rebase, no
  push); prints the same result the engine reports. `rt team publish`
  keeps its meaning (commit is the engine's job; publish pushes now and
  sets a remote).

### 4. Join and Install

`team.join` is unchanged. The supervisor's `teams/` watcher starts the
new clone's instance during Install, and the instance's first pull runs
at once. `verify` (which already re-reads `tool.daemon` for up to 5 × 3 s)
gives `team.sync` the same budget: it re-reads while the row carries the
marker it opens its detail with when every clone in it is simply waiting
for a first pull, so a joiner whose owner ran `members sync` during
Install still leaves Install able to decrypt. The marker is matched at
the start of the detail, never as free text, since slugs and git's own
stderr also land there; and a critical failure outside the settling set
ends the loop on the first read rather than sharing that budget.

### Out of scope

Team-declared claimed zones beyond the file's existing semantics; a
merge strategy other than rebase; conflict resolution UI (the row names
the clone and the two-command fix); pulling anything outside
`~/.mattstack/teams/`.

## Testing

- Engine refactor: the existing home-snapshot suite passes unchanged
  against the home spec.
- New unit tests (fake exec/watch/clock, as today): scope filtering
  stages only scoped paths; pull precedes push; ff-only vs rebase
  branch; conflict aborts, persists the marker, suspends, resumes when
  clear; non-ff push rejection pulls and retries once; token reaches
  fetch/push through env, never argv; supervisor starts on boot, on a
  new clone, stops on removal, skips a clone without origin.
- Row + verbs: `team.sync` row states; `rt team pull --json` envelope;
  `rt team status --json` fields.
- End to end: `rt-tray/vm/run/host/team-propagate.sh` drops its owner
  commit/publish and joiner pull steps; the kitchen-sink pass
  (`fixtures/team-kitchen-sink`) must stay `TEAM fails=0` on both joiners
  with only the daemon moving bytes. That run is the acceptance test.

## Rules this design binds

- Every git call on a team clone carries rt's token through the inline
  helper; a bare `git` on a team clone is a defect (found five times on
  2026-09-02).
- The engine never stages outside a spec's scope; a team clone that is
  also a working repo must not get its source auto-committed.
- A conflict is surfaced, never resolved by discarding either side.
