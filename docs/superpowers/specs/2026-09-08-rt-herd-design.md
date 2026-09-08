# rt herd: shepherdr on gates and chat, with nothing to remember

**Date:** 2026-09-08
**Tickets:** SKILLS-59 (field report), SKILLS-58 (gate decisions through the bus), SKILLS-35 (watch loop drops events)
**Repos:** rt (the facility), mattstack-skills (shepherdr engine and job template)
**Supersedes:** the shepherd-side half of `mattstack-skills:docs/superpowers/specs/2026-08-19-shepherdr-event-bus-design.md` (herd-wait, herd-bridge, the herd DB's question and report tables) and the shepherdr adopter section of `2026-09-03-gate-facility-design.md`, which this spec completes.

## Problem

Two heavy herds (2026-09-03/04 and 2026-09-07/08, three design jobs each)
shipped their work, and SKILLS-59 records what the shepherd went through to
get there. The shape of every finding is the same: the shepherd or the worker
had to remember a step, and the step got forgotten.

- `herd-wait.sh` is a one-shot bus wait. Re-arming it after every exit is
  discipline in prose; the shepherd lapsed twice, each time leaving worker
  reports unread for 40 to 90 minutes.
- `herd-bridge.py`, the pane-lifecycle poller, is a long-lived background
  process, and SKILLS-58 recorded it dying four times in one run.
- The only path from shepherd to worker is `herdr agent prompt`, off the
  record and rejected when the worker sits on a form. Rulings and review
  findings went through it anyway.
- Milestone reviews (spec ready, plan ready) are terminal-shaped reports:
  the completion step marks the job done on any report, and "tell it to
  revise" names no transport. Nine review rounds ran over the unsanctioned
  channel.
- `herd-job --status`, `--handled <rid>`, the resume checklist, the
  subscription liveness check: each is a bookkeeping call the shepherd must
  remember to make.

The estate has moved since the shepherd loop was designed. The 2026-09-03
gate facility ruled that observers never hold wait loops and are pushed to
by the daemon's write path. rt chat delivers message bodies straight into a
session's context over the same inbox socket, cross-account, with rooms,
DMs, claims, and a viewer. herdr now exposes `events.subscribe` with
`pane.agent_status_changed`, `pane.closed`, and `pane.exited`, which the
bridge was written to compensate for the lack of. The 2026-09-04 shepherdr
commit adopted the gate facility for run-backed questions only; design-job
questions, which is what both heavy herds were made of, stayed on the old
path.

## Vision

Gates carry every question and milestone decision. One chat room per herd
carries everything else: reports, rulings, reviewer findings, lifecycle
notices. The rt daemon owns the herd registry, so job status, subscriptions,
and pane lifecycle are side effects of verbs the agents run anyway or of
daemon behaviour. The shepherd's watch section is deleted. The one design
rule, stated once: **no obligation lives as prose an agent must remember.**
Every step is either a verb run at the moment it is needed, with its
trigger already in context, or the daemon's job.

## Decisions (2026-09-08, in-session)

- Gates for questions, the chat room for the rest.
- Pane lifecycle is forwarded by the daemon from one herdr subscription,
  not by a plugin hook and not dropped.
- The herd registry is daemon-owned (`rt herd` verbs), not a swapped
  transport under the existing python scripts.
- The invisible herd-session mode survives, as `rt herd start --hidden`.
- Every herd gets its own herdr workspace named for the run; all worker
  panes are tabs in it (Matt, mid-session).
- Nothing an agent must remember: audited per verb below.

## The facility (rt daemon)

### Registry

Its own SQLite store beside the gates registry, never `state.db`, so it
stays out of the `SCHEMA_VERSION` claim race documented in CLAUDE.md.

**`herds`**

| field | meaning |
|---|---|
| `id` | `<name>-<stamp>`, minted at start |
| `repo` | the repo identity (rt-client serialized form, per `docs/repo-identity.md`) |
| `room` | chat room name, `herd-<id>` slugified |
| `workspace` | herdr workspace label, `herd: <id>`; every job pane is a tab in it |
| `shepherd` | `{session, handle}`; updated by `resume` |
| `herdr` | `{socket}`: the herdr server every pane of this herd lives on (the visible server, or the hidden session's) |
| `status` | `active`, `wrapped` |
| `createdAt`, `wrappedAt` | timestamps |

**`herd_jobs`**

| field | meaning |
|---|---|
| `herd`, `name` | key; `name` fits herdr's agent-name grammar (`[a-z][a-z0-9_-]{0,31}`), rejected loudly otherwise |
| `worktree`, `branch`, `tree` | from provision (or `--dir`); `tree` is the registry tree name `rt worktree dispose` keys on, which for a pool tree is the slot name, not the branch |
| `pane`, `agentSession` | from `rt agent start` |
| `handle` | the chat handle sign-in returned (`name`, suffixed on collision) |
| `disposable` | true for reviewer jobs; the daemon closes the pane on their report |
| `status` | `spawning`, `active`, `at-gate`, `at-milestone`, `done`, `closed`, `crashed` |
| `lastGate`, `lastReport` | ids, for `status` rendering |

### Verbs

Every verb records what it did. There is no separate bookkeeping verb.

- `rt herd start --name <n> [--repo <path>] [--hidden] [--json]` mints the
  id (suffixing `-2`, `-3` on a same-second collision), creates the room,
  records the workspace label `herd: <id>` (the first `spawn` creates the
  workspace through agent start's find-or-create, so its root tab is
  adopted rather than left blank), signs the caller's session in as
  `shepherd` when the session has no presence row and keeps its existing
  handle when it does, joins the room, registers `gate subscribe
  --subject-prefix herd:<id>` for the caller's session, records the herdr
  socket (see Hidden mode), and prints `{herd, room, workspace,
  subscription, handle}`. One workspace per run is the whole containment
  rule: every pane the herd creates is a tab there, never in the workspace
  the human is looking at. The caller's session id is `CLAUDE_CODE_SESSION_ID`;
  outside a Claude session the verb refuses with a one-line reason.
- `rt herd spawn --herd <id> --job <name> --brief <file> [--model M]
  [--effort E] [--account A] [--dir <worktree>] [--json]` provisions a tree
  through `rt worktree provision --branch <job> --disposal job` unless
  `--dir` names one; runs `rt agent start` in it with the brief as prompt,
  `--workspace "herd: <id>" --tab <job>` (agent start's find-or-create by
  label, so a respawn lands in the same workspace), the job name as the
  session's `--name` (agent start's pool-handle reservation is bypassed
  for herd jobs, so chat and the registry agree on the name), the hidden
  session's socket as a per-call parameter when the herd is hidden,
  `crossSessionInbound: accept` in the passed settings, and env `HERD_ID`,
  `HERD_JOB`, `HERD_ROOM`; signs the pane in as `<job>` and joins the room
  (daemon-side, zero worker turns); inserts the job row as `spawning`,
  flipping to `active` on herdr's `pane.agent_detected`. The
  fresh-worktree trust dialog is accepted as `spawn-agent.sh` does today.
  `--dir` on an existing job name is a respawn: the row's previous pane is
  closed first (agent start dedups on the tab label and would otherwise
  focus the dead tab instead of launching), then the row is reused with the
  new pane. `--disposable` marks a reviewer job.
- `rt herd ask --questions <json> [--context <text>] [--json]` (worker;
  herd and job from env) opens a gate: subject `herd:<id>/<job>`, kind
  `question`, `--agent <job> --pane <pane>`, `--nudge {session: <own>}`,
  meta `{herd, job}`; sets the job `at-gate`; prints `holding at gate
  <id>` and exits 0. Nothing else. It never blocks and never launches a
  background process: the daemon's nudge wakes the worker on answer.
- `rt herd milestone --artifact <path> [--summary <text>]` (worker) posts
  the artifact path and summary to the room on the record (`--quiet`
  semantics: the gate push is the wake, not the post), then opens a gate of
  kind `milestone` with the fixed options **Approve** / **Revise** / **Spawn
  a reviewer**, same refs and nudge as `ask`; sets `at-milestone`.
- `rt herd answer <gate> [--json]` (worker) prints the recorded answer:
  each question's chosen value and its `note`. A thin read over the
  registry; it is the one thing a nudged worker runs.
- `rt herd report [--file <path>]` (worker; body on stdin otherwise) posts
  to the room mentioning the shepherd's handle and sets the job `done`. A
  `disposable` job's pane is closed by the daemon in the same call and the
  job set `closed`, so a reviewer needs no follow-up from the shepherd.
- `rt herd gates [--herd <id>] [--json]` (shepherd) lists open gates for
  the herd: every `herd:<id>/*` subject, plus every `run:` gate whose run's
  `worktree` field is byte-identical to a job's worktree. The match runs
  daemon-side; this retires the jq incantation in today's gate relay.
- `rt herd status [--herd <id>] [--json]` renders jobs with status, pane,
  open gate id, unread count, and herdr's live agent status per pane, plus
  whether lifecycle forwarding is connected.
- `rt herd resume <id>` re-subscribes with the caller's current session
  (idempotent on the daemon side), updates `shepherd.session`, and prints
  `gates`, unread room messages (`rt chat read <room>` semantics), and
  `status`. That is the entire resume checklist.
- `rt herd close <job>` closes the pane and sets `closed`; the daemon's
  lifecycle forwarder sees a `closed` job and stays silent on its
  `pane.closed`.
- `rt herd attend <job>` opens a focused tab in the visible session
  attached to a hidden pane's terminal, the same terminal-attach mechanics
  `attend.sh` uses today, and prints the tab id to close afterwards. A
  no-op with a message when the herd is not hidden.
- `rt herd stop --hidden` stops the headless herdr server; refuses while
  any herd recorded on it is still `active`.
- `rt herd wrap-up <id> [--close-panes] [--dispose <job>...]
  [--delete-job-dirs] [--archive-room]` executes the wrap-up form's answers:
  panes closed through `close`, and the herd workspace closed once its last
  herd pane is gone (keeping panes keeps the workspace), trees disposed
  through `rt worktree dispose` (its unmerged-work guard refuses and the
  refusal is reported, never overridden), job dirs deleted, the room
  archived; sets the herd `wrapped`. Nothing runs that the flags do not
  name.

### Daemon behaviour (no verb)

**Lifecycle forwarding.** On start the daemon opens one herdr
`events.subscribe` per herdr server it knows (the default socket, plus each
hidden session recorded on an active herd), for `pane.agent_detected`,
`pane.agent_status_changed`, `pane.closed`, `pane.exited`, reconnecting with
backoff. For panes in `herd_jobs`:

| herdr event | job status | daemon action |
|---|---|---|
| `agent_detected` | `spawning` | set `active` |
| `agent_status_changed` to `blocked`, still blocked 30s later | any but `closed` | room post `<job> blocked` from the system handle `herdr`, mentioning the shepherd |
| `agent_status_changed` working/idle | any | nothing; these are the flips that trained neglect in SKILLS-35 |
| `closed` or `exited` | `spawning`, `active`, `at-gate`, `at-milestone` | set `crashed`; room post `<job> exited` mentioning the shepherd; close any open gate on `herd:<id>/<job>` with reason `abandoned` |
| `closed` or `exited` | `done`, `closed` | set `closed` silently |

Posts from the system handle ride `postAndNotify` like any post; the handle
has no presence row and no inbox, so it never receives deliveries.

**Gate answer coupling.** `gate:answer` or `gate:close` on a `herd:`
subject sets the job back to `active` only when it is `at-gate` or
`at-milestone`; a `crashed` or `closed` job stays as it is (the crash path
closes the job's gate after marking it crashed).

**Nudge reliability.** The gate pane push (`pushToPane` in `gate-push.ts`)
gains the chat delivery's retry with backoff and a 30s sweep that re-pushes
`answered` gates whose last push was `dead-pane` (never closed ones: a
closed gate has nothing for the pane to act on), so a worker's wake is as
reliable as a chat message. A gate that stays `dead-pane` after the sweep
renders in `rt herd status` as "answered, worker not woken"; the shepherd
DMs the worker, which is the only manual step and is prompted by the
status line. `status` also shows the shepherd's own subscription row (id,
last delivery outcome, dead flag) so a quiet shepherd can be diagnosed from
any session.

**Room wake policy.** The room is created with the default `wake_on
mention`. Workers mention the shepherd on reports; the shepherd DMs workers;
the human's posts deliver as `@here` by chat's standing rule, so the skill
tells the human that a question for the shepherd is a DM to it.

### Hidden mode

`rt herd start --hidden` starts (idempotently) the headless herdr server
named `herd` exactly as `herd-session.sh start` does today, records its
socket path on the herd row, and every herdr call the daemon makes for this
herd (spawn, lifecycle subscription, peek, close, attend) targets that
socket. The daemon's herdr runner reads the daemon's own environment, not
the caller's, so `agent:start` takes the socket as a per-call parameter and
`spawn` passes the herd's. The server is started through `nohup` in a
shell with job control on, so it lands in its own process group and
survives the daemon being restarted under launchd. The invariant
`herd-session.sh` documents survives: a hidden session is a separate server
and panes never move between servers; `attend` is a terminal attach from a
visible tab, not a move. `rt herd status` shows the hidden session's pane
count and whether its server is up; stopping the server is `rt herd stop
--hidden` and refuses while any herd on it is active.

## Worker contract (the brief)

The job template keeps its two-copy structure (Method body verbatim,
task/verification/report scaffolding). The herd sections shrink to five
instructions, each one command at the moment it is needed, each with its
trigger in context:

1. **Ask.** `rt herd ask --questions '<json>' --context "<why>"`, then end
   the turn. Options are the worker's own text; the first is its
   recommendation. When `[gate] <id> answered elsewhere; re-read the
   registry` lands, run `rt herd answer <id>` and continue. The human's
   free text arrives as a `note` on the chosen value; read it.
2. **Milestone.** `rt herd milestone --artifact <path>`, then end the turn.
   Approve: continue. Revise: the note carries the feedback ("see pane"
   means it was left in the pane); revise, then milestone again. Spawn a
   reviewer: findings arrive as a DM; revise, then milestone again.
3. **Report.** `rt herd report` with the body on stdin, at completion.
4. **Messages.** Anything from the shepherd or a reviewer arrives as a chat
   DM. Reply with `rt chat dm <handle>`, never SendMessage. Every delivery
   restates this line.
5. **Pipeline verbs.** Start runs with `--spawned-by herd:<id>` as today;
   their gates open on `run:` subjects through the gate-protocol part and
   the shepherd sees them through `rt herd gates`.

The `--questions` JSON is the registry's `GateQuestion[]` shape; strict
option membership at `gate answer` makes a bare ordinal impossible, which is
the SKILLS-58 silent-inversion fix carried over.

A worker that forgets to end its turn loses nothing: the nudge lands
mid-turn between tool rounds. A worker that ends in prose with no open gate
is a settled-silent pane; its exit is forwarded by the daemon, and its idle
case is visible in `rt herd status`.

## Shepherd loop

Setup up to the spawn is unchanged: job specification, the per-job strategy
and model question, the accounts slot, two-copy briefs. Then
`rt herd start`, and `rt herd spawn` per job. **There is no step 3.** The
skill's watch section, its exit-code table, its re-arm rule, and its bridge
health rule are deleted.

**On a gate push** (`[gate] <id> is now open; re-read the gate registry`):
`rt herd gates`; present up to four gates in one form, each option's
`label` when it has one else the option text, the job's recommendation
first; record with `rt gate answer <id> --answers '<json>' --by shepherd`,
values verbatim. A CAS rejection means another surface answered first: say
in one line which answer won and from where, proceed on it, never re-ask.
Answer on the worker's behalf only when the answer is literally in the
brief.

**On a room message:**

- `<job>` report: the two objective checks as today (`git log --oneline`,
  `git diff --stat` against the fence), plus one new check: each active
  job's changed-file set diffed against every other active job's, so a
  cross-job collision surfaces at the report instead of at integration
  (SKILLS-58 finding 2). Update the status table. Integration remains its
  own job.
- `herdr: <job> blocked`: `rt pane peek <pane>`; if a human is needed, the
  attend flow (`rt herd attend <job>` in hidden mode, or the pane id in
  visible mode).
- `herdr: <job> exited`: report the crash to the human with the pane id;
  never silently respawn.

**Shepherd to worker** is `rt chat dm <job>`: rulings that invalidate
in-flight work, scope changes, reviewer findings. It is on the record, the
human reads it in the viewer, and it lands mid-turn. The scope-redirect
form is unchanged; "kill and respawn" is `rt herd close <job>` then
`rt herd spawn` with the new brief.

## Milestones and review rounds

The milestone gate's three options are fixed by the verb. The human answers
through the shepherd's form. **Revise** carries the feedback in the note
(the shepherd asks for it in the same form when the option is chosen).
**Spawn a reviewer** makes the shepherd run `rt herd spawn --job
review-<job> --dir <job's worktree> --disposable` with a brief that reads
the artifact, DMs findings to `<job>`, and reports a verdict; the daemon
closes the reviewer's pane on that report because the job is disposable.
The job revises and runs `rt herd milestone` again, which opens
a fresh gate; the supersede rule closes any stale open one of the same kind
on the same subject. Every round is gate, DM, gate: on the record in the
room and the registry, and the daemon flips the job between `at-milestone`
and `active` on its own.

## Resume and recovery

- **Shepherd relaunched or compacted:** `rt herd resume <id>`. Nothing
  else; the verb is the checklist.
- **Daemon restart:** herd rows, gates, subscriptions persist. The herdr
  subscriptions are re-established with backoff; until they are,
  `rt herd status` says lifecycle forwarding is off.
- **Worker respawn:** `rt herd spawn --job <same> --dir <worktree>`; the
  verb closes the row's old pane first, reuses the stored brief, and the
  brief's resume text is unchanged.
- **Dead nudge:** retry and sweep as above; the residual case is a status
  line, not a lost answer.
- **Dead subscription:** the daemon marks it after three consecutive
  failures; `resume` re-subscribes, and `status` shows the subscription
  row's last outcome so a shepherd that has gone quiet can be diagnosed
  from any session.

## Wrap-up

The existing wrap-up form (the `wrap-up-form` include) gains one question:
archive the room, yes or no. `rt herd wrap-up` executes exactly the
answers. Nothing is auto-removed; a disposal refusal is reported as the
guard's own words.

## Testing

**rt unit** (fake runners, fake herdr event stream, fake inbox server as
the chat and gate tests already use):

- herd store: create, job insert, status transitions, resume updating the
  shepherd session.
- `spawn` composes provision and `rt agent start` with the expected argv
  (including the herd workspace and the job tab label), env, and settings;
  `--dir` reuses a row.
- `start` creates the workspace unfocused and records its label; a second
  `start` with the same name mints a new id and a new workspace.
- `ask` opens a gate with subject, refs, nudge, and meta, sets `at-gate`,
  launches nothing.
- `milestone` posts quietly then opens a gate with the three fixed options.
- lifecycle forwarding: `agent_detected` flips `spawning`; blocked debounce
  (a block that clears in under 30s posts nothing); exited on `active`
  posts and closes the gate, exited on `done` is silent.
- `gates` matches `run:` subjects on worktree only, never repo plus branch.
- `report` mentions the shepherd's handle and sets `done`.
- nudge retry: a `dead-pane` first attempt is retried and the sweep
  delivers once the socket returns.
- `wrap-up` runs only the flagged actions and reports a dispose refusal.

**e2e** (opt-in, tagged, the chat e2e's recipe): spawn one throwaway worker
through `rt herd spawn`; the worker runs `rt herd ask`; a second session
subscribed by `rt herd start` receives the push; it answers; the worker's
transcript shows the nudge frame.

**Skill** (writing-skills discipline, no unit tests for prose): the RED
baseline is today's skill under the two-herd transcript shape (re-arm count,
pane reads to learn a question). The live smoke is a two-job design herd
with one Revise round and one reviewer round, and the assertion is that the
shepherd's transcript contains zero background processes and zero
`herdr agent prompt` calls.

## Scope, deletions, sequencing

**Deleted from shepherdr:** `herd-init.py`, `herd-ask.py`, `herd-answer.py`,
`herd-read.py`, `herd-report.py`, `herd-job.py`, `herd-bridge.py`,
`herd-wait.sh`, `herd_db.py`, `relay-answer.sh`, `spawn-agent.sh`,
`herd-session.sh`, `hrd`, `attend.sh`, `herd-scripts.test.sh`, and
`references/herd-bus.md`. **Kept:** `parts/accounts` (pick-account),
`parts/strategy`, the two-copy job template, `references/cloud-lane.md`,
the `wrap-up-form` include, the gate relay's labeled-option rule.

**Waves.** W1, rt: registry, verbs, lifecycle forwarding, nudge retry,
hidden mode; rt-client wrappers for `herd*`. Additive; merges to rt main on
its own. W2, mattstack-skills: shepherdr SKILL.md and job-template rewrite
against W1's verbs, engine bump, recompile. W3: one dogfood herd, the smoke
above, SKILLS-59 closed with the transcript as evidence.

**Coordination.** The registry is its own store file, so no `SCHEMA_VERSION`
claim. The rt-client version bump for the wrappers is announced before
merge, per CLAUDE.md. The 09-04 gate relay text in the skill (list-and-match
on worktree) is retired by `rt herd gates`, not kept alongside it.

## The audit: what an agent still has to remember

Stated so the rule can be checked against the design rather than assumed.

| Actor | Obligation | Why it is safe |
|---|---|---|
| shepherd | run `rt herd start`, `rt herd spawn` | the start of the work, not a mid-run step |
| shepherd | present a pushed gate | the push is in context and says what to run |
| shepherd | run `rt herd resume` after a relaunch | the first thing a relaunched shepherd does; the skill opens with it |
| worker | `rt herd ask` / `milestone` / `report` at the moment of need | the moment is the trigger; each is one command |
| worker | run `rt herd answer` when nudged | the nudge is in context and names the gate |
| worker | end the turn after `ask` | forgetting costs nothing; the nudge lands mid-turn |

Everything not in this table (re-arming, bridge health, job status,
handled marks, subscription liveness, cursor persistence, run-dir naming,
pane-id addressing) is a verb side effect or daemon behaviour.

## Rejected alternatives

- **Chat as the question channel.** Prose questions lose option structure,
  CAS, first-answer-wins from the console, and strict membership; the
  SKILLS-58 inversion would come back as a paraphrase instead of an
  ordinal.
- **Keep the python scripts, swap the transport.** Cheaper, but the daemon
  would know no herd, so "who to mention" is a convention and job status
  and resume stay as prose. That is the failure class this spec exists to
  end.
- **herdr-chat plugin hook for lifecycle.** Zero daemon work, but a process
  per status flip, a room-owner convention, and pane truth held away from
  the daemon that already resolves panes to sessions.
- **Drop lifecycle events.** Closest to what SKILLS-58 observed in
  practice, and the one regression against today's contract.
- **Foreground blocking `rt herd ask`.** One tool call and nothing to
  remember, but the harness caps a foreground call at ten minutes and a
  human answer can take hours; the daemon nudge gives the same "nothing to
  remember" without the cap.
