# Gate facility: hard gates, answered anywhere

**Date:** 2026-09-03
**Repos:** rt (the facility), board, console, mattstack-skills (engine parts), the installed team pack (its own repo)
**Supersedes:** the board-owned gate design in `board:docs/superpowers/specs/2026-09-02-gate-events-design.md` (its build is reworked onto this facility before merging) and the review-only skills spec briefly committed to mattstack-skills (absorbed here as the Skills layer section)

## Problem

Runs block on human decisions, and today each blocking mechanism is its own
island:

- Pipeline `:work` runs present hard gates as in-pane structured forms; the
  pane is the only place to answer. Monitoring several runs means opening
  each pane to find out what is being asked.
- The board gate-events pass (BOARD-20/21) built a second answer surface,
  but only for review gates, and board-owned end to end: `board/gate/*`
  topics, gate state in per-gate files beside the board's review state, a
  board answer endpoint with its own conflict logic, and a parked-resume
  path hardwired to the review wrapper.
- Respond and doctor have their own decision mechanics (in-pane posting
  gates; terminal `error` escalations that dead-end until a human relaunches).
- Shepherdr hand-rolls a question relay between the herd and the user, scoped
  to the shepherd pane; the questions persist in the herd DB but the relay
  path dies with the shepherd, and no other surface can pick them up.

Every new surface would re-solve waiting, conflict arbitration, parking, and
resume. The console cannot help at all.

## Vision

One gate primitive, many answer pathways. A gate is a first-class record any
surface can render and answer: the pane (its form unchanged), the board card,
the console's run view, shepherdr's relay. First answer wins; everything else
reconciles. One comprehensive build; the held gate-events branches are
reworked onto the facility before anything merges.

## The facility (rt daemon)

### Registry

The daemon owns gate state:

| field | meaning |
|---|---|
| `id` | minted at open |
| `subject` | opaque `<prefix>:<id>` string (non-empty, prefix-filterable, daemon-uninterpreted); `mr:<url>` and `run:<id>` are the two prefixes surfaces render in v1 |
| `kind` | opener-declared label (`review-post`, `respond-plan`, `doctor-escalation`, ...), opaque to the daemon; the board's resume-by-pane-kind and shepherdr's relay policy both key off it |
| `meta` | optional opener-declared object (e.g. `needs: pane`, pane-only option markers, a human-renderable label) |
| `questions` | the existing `GateQuestion[]` shape: `{id, label, multi, options}` |
| `status` | `open`, `answered`, `parked`, `closed` |
| `answer` | `{answers, by, answeredAt}`; each answer value may carry an optional free-text `note` |
| `openedAt`, `parkedAt`, `closedAt` | timestamps |
| `agent`, `pane` | opener's refs, for focus, push delivery, and resume |
| `nudge` | optional push-delivery spec recorded by the opener (how to reach an attended pane; unattended panes need none, they block in `gate wait`) |
| `delivery` | outcome of the last PANE push attempt (`delivered` = the inbox accepted the frame, `dead-pane` = connect failure) plus a `released` marker set when the pane provably reconciled; subscription-push outcomes live on the subscription rows, not here |

The registry is persisted (SQLite beside the events journal) and survives
daemon restarts; gates outlive any surface AND the daemon itself. A
restarted daemon serves `gate list`/`wait` from the persisted rows.

### Verbs

- `gate open --subject <s> --kind <k> --questions <json> [--meta <json>]
  [--agent <id>] [--pane <id>] [--nudge <spec>]` mints the id, stores the
  row, emits `gate/opened/<id>`. **Supersede rule:** opening a gate on a
  subject that already has an OPEN gate of the same kind closes the old one
  (`closed`, reason `superseded`) in the same transaction; this is the
  board store's replace semantics (a re-review never inherits a prior
  gate's answers) promoted to the facility, and it makes a crashed wrapper's
  relaunch safe.
- `gate answer <id> --answers <json> --by <surface>` is the single arbiter:
  compare-and-swap; a second answer is rejected cleanly, and the rejection
  payload carries the recorded `{answers, by, answeredAt}` so the loser can
  proceed on the winner without a second round-trip. Validation is
  daemon-side, in this one verb, and STRICT on option membership: question
  ids must match, multi-shape must fit, and for a question carrying options
  the answer value (each element, for multi) must match one option's text
  verbatim or the answer is rejected loudly at record time; free-text rides
  the per-answer `note` or an option-less question. (Ruled 2026-09-03 on
  SKILLS-58's addendum: a live herd recorded an ordinal answer cleanly and
  two workers silently did the opposite of the decision; a value the
  receiver validates against option text makes that failure loud.) The
  companion rule binds surfaces: render options in the row's order and
  submit the chosen option's text verbatim, never an index or a paraphrase.
  On success: store, emit
  `gate/answered/<id>`, push per Delivery. Every surface answers through
  this verb; no per-surface conflict or validation logic anywhere.
- `gate wait <id>` blocks until the gate is answered or closed:
  registry-status-first (an already-answered gate returns immediately),
  blocking, re-entrant, and loopable by contract around the daemon's
  request cap; a daemon restart mid-wait is a reconnect-and-re-ask, never
  an error. (This retires the held branch's client-side journal-fold
  workaround; the registry is the source of truth.)
- `gate list [--open] [--subject-prefix mr:|run:] [--kind <k>]` is what
  surfaces render from. A query, never a journal fold.
- `gate park <id>` marks parked; answering unparks. Park is CAS-guarded:
  only `open` parks, and parking an `answered` gate is a clean rejection
  (the caller re-reads and acts on the answer instead). Parking POLICY
  stays with owners: the board keeps its grace sweep for `mr:` gates and
  must park FIRST, closing the pane only on park success, so a
  just-answered gate is never killed mid-posting. `run:` gates do not
  auto-park in v1.
- `gate close <id> --reason <abandoned|superseded|pruned>` is the terminal
  transition for a gate that will never be answered: a run abandoned at a
  `clarify` gate, an MR leaving the board (the rework's replacement for
  `pruneGateStates`), a superseded open. Closing an answered gate is a
  no-op rejection. Waiters are released with the closed status. Callers:
  the board sweep for off-board MRs, the run-close path for finished or
  abandoned runs, the supersede rule above.
- `gate subscribe --subject-prefix <mr:|run:...> --session <addr>` registers
  a push subscription: the daemon delivers `gate/opened` and `gate/answered`
  notifications for matching subjects directly into the subscriber's session
  (delivery below). Registered once; never re-armed. Subscriptions are
  persisted rows like gates (a daemon restart never silently voids a
  shepherd's coverage), each recording its last-delivery outcome;
  `gate unsubscribe <id>` removes one, and a subscription whose session is
  gone or whose delivery keeps failing is marked dead and pruned, with the
  outcome on the row so the loss is observable, never silent.

### Events

`gate/opened/<id>` and `gate/answered/<id>` are ordinary rt-bus events
through the existing journal and the published `eventsEmit/Wait/List`
wrappers. Daemon-internal gate emissions MUST take the dual journal +
broadcast path (the `events:emit` handler's path), never the bare
journal-only emit, or live subscribers (the board relay, the notify bridge)
never see them. Subscription patterns are Bun.Glob, where `*` does not
cross `/`: the pattern for all gate events is `gate/**` (the held board
branch already tripped on exactly this).

Payloads are specified in W1: `opened` carries `{id, subject, kind,
questions, meta, agent, pane, label}` (the label human-renderable, from
`meta`; `meta` included so live cards can render pane-only options
disabled without a registry round-trip);
`answered` carries `{id, subject, kind, answers, by, paneId}`. The
notifier's `rt.notify.eventBridges` routes these like any other event, and
`paneId` is what its suppression and tray focus action key off; bridge
rules go per-kind, or use the payload label, so templates never render a
foreign kind's fields. Bridge-routed notifications ARRIVE WITH W2 (the
notify bridge and its settings key live on the held rt branch that merges
there); W1 itself needs no notifier. The namespace is generic, replacing
the board-scoped `board/gate/*`.

### Delivery

Two delivery modes, keyed on whether the gated pane is attended. Every gated
pane publishes its gate either way.

**Unattended panes** (herd workers, board-launched panes): the verb blocks in
`gate wait` after publishing. No form is presented. The answer returns as the
blocking tool call's result, so nothing has to wake the worker, no relay
touches pane input state, and the pipeline stop hook is satisfied because the
turn ends in a tool call rather than prose. A human who opens the pane can
still interrupt the wait and answer conversationally (`gate answer --by
pane`). This is the direction SKILLS-58 proposed after the 2026-09-03 herd
run, where bus-published questions died because the stop hook forced pane
forms and the answer relay failed against form-blocked agents.

**Attended panes** (a human's interactive session): the verb publishes and
presents the normal in-pane form; the in-pane experience does not change.
When the gate is answered elsewhere first, the daemon pushes a doorbell
message into the pane's session over the socket messaging protocol. The
push QUEUES behind the pending form (spike-proven: no frame shape dismisses
a form) and delivers at the human's next touch, when they answer or cancel
the form; the verb then verifies against the registry and proceeds on the
recorded answer. Reconcile-on-touch is the attended mechanism, not a
fallback, and the human is by definition present. Pushes are wrapped in the
`<cross-session-message>` envelope (collapsed rendering, labeled source)
with the fixed doorbell phrase as the entire body.

**The push channel** is the Claude Code socket messaging protocol, the same
transport rt chat rides. It works across Claude Code accounts (herds
distribute across accounts; native SendMessage does not cross them), and it
requires no rt chat sign-in: the daemon addresses the session directly. The
same channel carries subscription notifications (`gate subscribe`), so an
observer such as a shepherd is pushed to, never polling and never re-arming
a wait: the fragility SKILLS-35 documented (dropped notifications during
interactive turns, manual re-arm discipline) does not exist in this design,
and gap recovery after a crash or compaction is `gate list --open` against
the registry.

**Delivery is fallible and therefore observable.** Every push attempt
records its outcome on the gate row: `delivered` (the inbox socket accepted
the frame; it is queued or landed) or `dead-pane` (connect failure). There
is no "refused" state on the inbox path (that vocabulary belonged to
`injectIntoPane`, which is not the backend; the inbox write is
spike-proven). **Release tracking makes the reconciliation gap renderable
and self-clearing:** the gate is marked `released` only when the pane
provably reconciled, meaning ANY `gate answer` attempt arriving from the
gate's own pane, winner or CAS-loser (a losing attempt proves the pane
read the winner). A delivered-but-unreleased gate renders as "answered,
pane not yet released" on surfaces, alongside open gates, instead of
silently clearing the badge; the marker clears the moment the pane
converges. **Stale-push rule:** a push for a gate the pane has already
reconciled is discarded; the doorbell phrase is a recognized signal whose
ONLY action is a verifying registry read, never free-form instructions.
The protocol part PRIMES participating verbs for it: the spike showed an
unprimed session correctly refuses such a message as an injection attempt,
which is the desired behavior outside the protocol and the reason priming
is part of the contract.

**Own-gate waiting is control flow; observing is push.** A verb waiting on
its OWN gate blocks in `gate wait`: one tool call that IS the control flow,
nothing to remember, nothing to re-arm. An observer watching OTHER agents'
gates (a shepherd over a herd) NEVER holds wait verbs: the one-shot wait
disarms on fire and demands re-arming, the exact SKILLS-35 fragility.
Observers register a persisted subscription once, and delivery is a side
effect of the daemon's WRITE PATH: when open/answer commits, the daemon
fans out to matching subscription rows. Nothing arms, so nothing can be
forgotten; rt chat is the production precedent for this exact plumbing.

A dead pane gets no delivery; resume handles it (below).

**Spike: RUN 2026-09-03, findings in
`docs/superpowers/spikes/2026-09-03-gate-delivery-spike.md`.** Cross-account
no-sign-in delivery, mid-turn arrival, on-touch reconciliation, the
blocking wait returning the answer, and BOTH full flows (attended with
CAS-loss reconciliation; unattended with no message at all) were proven
live. Form dismissal was DISPROVEN across three frame variants, which
produced this section's queue-and-reconcile-on-touch design; the
emit-before-wait miss observed in the stub is the standing evidence for
registry-status-first `gate wait`.

### Agent and pane integration

The registry row's `agent`/`pane` refs power three things: a Focus button on
every gate card (the existing `paneFocus` bridge), push-delivery targeting,
and parked resume. Agent status can surface "at gate" so run listings show
blocked state without extra plumbing.

### Trust boundary

Answering a gate triggers actions that leave the machine: posting review
comments, approving MRs, and (doctor) conflict resolution and author-gate
override. The boundaries, stated so they survive adoption:

- `gate answer` is reachable from the local daemon socket and from the
  board/console HTTP endpoints; all are local-only in this pass. No peer or
  team answering exists yet; adding a remote surface later is a trust
  decision, not a transport detail.
- `--by <surface>` is informational, not authenticated. It names the
  pathway for the decision record; it grants nothing.
- Push text is data, never instructions: a fixed phrasing the receiving
  verb recognizes as "re-read the registry," full stop.
- An answered gate is CONSENT, not verification. Verb-side safety checks
  survive facility adoption unchanged: the doctor still re-verifies the
  author gate independently before acting on an answered escalation,
  exactly as its safeguards demand today.

## Surfaces

### Board (rework of the held branch)

The guts swap; the experience stays. The status-bin `gate` verbs become thin
clients of the daemon with the same CLI shape. The board stops owning gate
state: boot reconcile is `gate list --subject-prefix mr:`, live updates
subscribe to `gate/**` events, and `/gate/answer` proxies
`gate answer --by board` (daemon CAS replaces the board's 409 logic). The
grace sweep stays board-side and executes facility transitions (park first,
close the pane only on park success, per the verb contract); MRs leaving
the board are pruned with `gate close --reason pruned`, replacing
`pruneGateStates`. Parked resume generalizes two ways: the wrapper prompt
is rebuilt by the gate's `kind` (review, respond, doctor) instead of
assuming review, and the TRIGGER moves off the board's own answer endpoint
onto the `gate/answered` subscription plus a boot-reconcile pass over
parked gates answered while the board was down; with answers arriving from
any surface, an endpoint-triggered resume would silently never fire for a
console-answered parked gate. Surviving unchanged from the held branch:
the card UI, focus buttons, auto-close at done, launch-via-agent, the
park/resume UX.

### Console (new)

RunRow shows a blocked badge when an open gate exists for `run:<id>`.
RunDetail renders the gate card, ported from the board's pattern: questions,
an Answer action (`gate answer --by console`), and Focus pane side by side.
v1 scope: the console renders `run:` gates and the board renders `mr:`
gates; cross-rendering is a later nicety.

### Pane (one protocol, two modes)

A shared engine part defines gating for any verb or wrapper. Every gated
pane publishes (`gate open` with subject, questions, and pane refs), then:

**Attended** (a human's interactive session, the default for a
human-invoked verb):

1. Present the normal in-pane structured form. The in-pane experience does
   not change. When the gate carries more questions than one form call fits
   (the tool caps questions per call), present in chunks and submit exactly
   ONE `gate answer` after the last chunk; a CAS rejection at that point
   discards all chunks.
2. Form answered: `gate answer --by pane`. If CAS reports an earlier answer,
   discard the form's answer, say in the pane which answer won and from
   where, and proceed on the recorded one (the CAS rejection carries it);
   the decision record's `--decided-by` names the winner.
3. Answered externally while the form sits: the doorbell push QUEUES behind
   the form and delivers when the human answers or cancels it; either way
   the verb's next step is the same registry verify, and it proceeds on the
   recorded answer. A push for a gate already reconciled is discarded.

**Unattended** (spawned by a herd, a board launch, or any `--spawned-by`
surface):

1. Block in `gate wait`; the answer returns as the tool result. No form.
   A `closed` result means the decision site is abandoned: the verb ends
   that path cleanly per its own policy (a closed clarify gate ends the
   run's asking, never invents an answer).
2. A human who opens the pane can interrupt the wait and answer
   conversationally: `gate answer --by pane`. On a CAS rejection the
   answer already landed elsewhere; say so and proceed on the recorded
   one, exactly as the attended branch does.

**Daemon down** (either mode): form-only in-pane, exactly today's behavior.

Attendance comes from the invocation context (the spawning surface says so;
a human-run verb defaults to attended). The question "open any blocked pane
and the question is waiting" holds in both modes: attended panes show the
form, unattended panes show the wait with the gate stated above it.

## Skills layer: caller-owned posting decisions

The review engine currently owns the posting decision through a two-gate
protocol (`post-severity`, then `post-disposition`) compiled into its
Deliver step. Under the facility the decision is the caller's; the engine
keeps judgment and execution. This section is the absorbed review-only spec.

One principle, stated once in the engine: review verbs produce judgment and
execute posting; they never decide what posts.

| Context | Who decides |
|---|---|
| Board-launched review | The human, via the gate (any surface); the wrapper hands `{tiers, outcome}` down through the fill |
| Direct terminal run | The human, via ONE combined in-pane form: tiers multi-select over the levels present, pre-selected; disposition single-select, Comment default; Iterate here; Hold |
| Any future caller | Same contract: hand a decided selection plus disposition |

The two-gate protocol retires. Gate ownership is declared in the invocation
itself; wrapper, fill, and verb share one conversation, so handing answers
down is the conversation continuing.

Engine edits (mattstack-skills):

- `attachments/review/review/SKILL.md`, the Deliver step: present the draft,
  state the levels present in one structured line, take the caller's
  `{tiers, outcome}` or ask the one combined question, execute posting, and
  when an rt-runs run is active record the decision at execution time
  (`rt runs decision record --contract gate@1 --scope post --selection
  '{"levels":[...],"disposition":"..."}' --decided-by <decider>`, the
  decider naming who actually answered: board, console, pane, shepherd).
- `attachments/review-posting/SKILL.md`, rewritten execution-only. Inputs: a
  decided `{levels, disposition}` plus the draft, or the written report file
  when the draft is not in context (the parked-resume case; the report's
  fixed severity buckets suffice). Keeps: no side door, the single summary
  scoped to posted levels, empty selection posts summary only, Approve posts
  findings first, the tacit-approval language rule, forge-conditional
  execution, the writing-style step, the close HARD-GATE. Gains one guard:
  this part never asks anything; arriving without a decided selection and
  disposition is a caller bug, so stop.
- Untouched IN THIS WAVE (W2): `review-core-*`, `gitlab-mr-threads`,
  `wrap-up-form`, self-review, receive-review. Self-review never posts and
  adopts the facility only through the pipeline part in W3; receive-review
  restructures in W3 per the Respond adopter, not here.
- The decision-record vocabulary changes with this edit: one record at
  scope `post` with a combined `{levels, disposition}` selection replaces
  today's `post-severity` + `post-disposition` pair, and `--decided-by`
  moves from verb names to surface names. Any consumer rendering decisions
  by scope gets named and checked in the plan.
- Iterate here and Hold remain pane-semantic options: when an answer picks
  one, the verb acts on it in-pane and opens a NEW gate when it re-asks
  (the consumed gate is terminal); openers may mark such options pane-only
  via `meta` so remote cards render them disabled.

Fill edits (team pack repo): the pack's review fill becomes a thin @2
adapter. Both provides spots (the fill's frontmatter and the pack
manifest's provides row) declare BOTH contracts during the transition,
`mr-review@1 mr-review@2`, because the wrapper's resolver requires an exact
`contract@major` match and a clean bump would break slot-resolved launches
under the currently live @1 board (the resolver splits `provides` on
whitespace, so dual declaration is supported); @1 is dropped once the
reworked board deploys. Flow: invoke the review verb
declaring caller-owned gating; save the report before reporting levels;
report the levels present; on handed `{tiers, outcome}` execute posting and
hand the outcome back for `done --outcome`; under `--resumed-gate` execute
posting from the report file plus answers, never re-reviewing. Under a
wrapper that never hands answers (an @1 wrapper), nobody owns the gate, the
engine fallback asks the one combined question in-pane, and the fill hands
back the disposition: today's behavior minus one gate, so pack updates are
safe against the currently live board.

## Adopters

### Review (`mr-review@2`)

The skills layer above, with the wrapper gating via facility verbs in
UNATTENDED mode: it publishes and blocks in `gate wait`, exactly as the
held design had it, because the board card is a review pane's answering
surface and only the wait's return lets an external answer proceed the
pane (spike ruling). The conversational escape hatch stays. Park, resume
via `--resumed-gate`, re-review semantics, and the clean-review one-click
approve all carry over from the held design.

### Respond (`mr-respond@2`)

Respond's decision surface collapses from today's three gates (verdicts,
fixes, post) to two facility gates, answerable from any surface:

- Gate 1, the plan: per-thread questions (reply, fix, skip) built from the
  fill's adjudication and recommendations, plus the code-changes approval.
  Grouped with the in-pane form's question cap in mind, WITHOUT losing
  per-thread decidability: every thread remains individually selectable
  (options carry thread ids), grouping only bounds how many questions any
  one form chunk carries. Board and console cards render the full list
  either way, and however the pane chunks its presentation, exactly one
  atomic `gate answer` lands.
- Gate 2, the posting: after fixes, post replies and disposition.

The receive-review verb restructures to adjudicate and execute, never
decide. The wrapper contract bumps to `mr-respond@2` accordingly.

### Doctor (`mr-doctor@2`, `mr-doctor-api@2`)

Doctor stays unattended by default. Where it today dead-ends in `error`
needing an enumerable human decision (conflict strategy, author-gate
override, budget extension), it opens an escalation gate naming its
executable options plus a "leave it to me in the pane" option. Answering
from any surface lets the doctor continue instead of being relaunched.
Non-enumerable failures remain `error`.

### Pipeline hard gates

The shared pane-protocol part is adopted by every `gate@1`-bracketed
decision site: `clarify` gates, self-review's fix/ship gate, resume offers,
stage gates. Adoption is a mechanical include plus each site publishing its
questions with subject `run:<id>`. Attendance follows the invocation: a
human-run `:work` verb is attended (form as today), a herd-spawned worker is
unattended (blocking wait, no form). The existing `rt runs decision record`
bookkeeping keeps working, with `--decided-by` taken from the CAS answer's
`by`. This is what lights up the console for `:work` runs. The pipeline
stop hook likely needs no herd awareness under the blocking design (the
turn ends in a tool call); the W1 spike confirms.

### Shepherdr

Shepherdr already hand-rolls this: workers emit blocked/question signals and
the shepherd relays structured questions between the herd and the user,
scoped to the shepherd pane. SKILLS-58 (filed from the 2026-09-03 seven
worker herd) documents how that relay fails today: the pipeline stop hook
forces workers into pane forms, killing their published questions; the
answer relay fails against form-blocked agents (`agent prompt` rejects a
blocked agent); and the shepherd burned six pane reads just to learn what
forms were asking. SKILLS-35 documents the watcher side: notifications
dropped during interactive turns, re-arm as manual discipline.

Under the facility: worker questions become gates, workers are unattended
panes (they publish and block in `gate wait`; no forms, no relay against
pane input, answers return as tool results, cross-account because the daemon
is the transport). The shepherd registers ONE `gate subscribe` for its
herd's subjects at herd start and is pushed to over the socket protocol;
nothing is re-armed during normal operation, and recovery after a gap is
`gate list --open` plus a liveness check on its own subscription row,
re-subscribing if the daemon pruned it (a gone session, persistent
delivery failure).
The relay becomes one more surface: shepherdr presents herd gates in the
shepherd conversation exactly as today and records answers with `gate
answer --by shepherd`.

Not every herd question has a run id: the per-job strategy/model question
fires before any run exists, and design-job questions never get one. The
subject being an opaque `<prefix>:<id>` (per the registry) covers them
(e.g. a herd-scoped prefix); in v1 those render on the relay only, while
`run:` gates also render on the console.

Gains: worker-run questions escape the shepherd pane (answerable on the
console, the worker's own pane, or the relay; first answer wins); the
QUESTION's availability stops depending on any single surface (today open
questions persist in the herd DB but die with the failed relay path; in
the registry, any surface picks them up); zero pane reads to learn a
question (the registry row carries it); and the existing "theirs to
answer, never yours" distinction becomes relay policy over the gate's
`kind`/`meta` rather than a separate mechanism. SKILLS-58's
direction is absorbed here; its open questions (permission-prompt
starvation under a blocking wait, timeout behavior, whether the stop hook
needs herd awareness) are the W1 spike's checklist plus plan-time details.
The plan pins the exact question-contract replacement after a full read of
the shepherd engine.

## Waves

- **W1, the facility:** the delivery spike (RUN 2026-09-03, see Delivery),
  then daemon registry, verbs, events, subscriptions, push delivery;
  rt-client wrappers. Additive; may merge to rt main early. Nothing
  half-wired ships.
- **W2, review end to end:** board rework onto the facility plus the skills
  layer (engine, fill). The shared pane-protocol part is CREATED here, with
  the review wrapper as its first consumer (W3 adopts it across the
  pipeline); the held rt branch's notify bridge and settings keys merge
  here, which is when bridge-routed gate notifications light up. Live
  verify, then the held gate-events family (board, rt, console branches)
  merges here.
- **W3, everything answers everywhere:** the pipeline part and verb
  adoption, the console surface (it needs `run:` gates to exist, hence this
  wave), respond @2, doctor @2, shepherdr.

Every push, publish, plugin update, and merge is individually gated on the
operator's go.

## Verification

- **W1:** the delivery spike (COMPLETE; findings recorded); CAS race test
  (two surfaces answer the same gate fast; exactly one wins and the
  loser's rejection carries the winning answer); lifecycle tests
  (supersede-on-open closes the prior gate AND releases its waiters;
  `gate close` releases waiters with the closed status; `gate park` on an
  answered gate rejects cleanly); wait re-entry across a daemon restart; a
  subscription push received by a second session.
- **W2:** the review smoke: findings review (gate opens, card offers tiers
  plus outcome, only selected tiers post, scoped summary, correct
  reaction); clean review one-click approve; the REQUIRED park, answer,
  resume test (fresh pane posts from the report file, no re-review, no
  hang); daemon-down degraded form.
- **W3:** block a herd-spawned worker at a self-review gate (unattended:
  no form), answer from the console, and watch the blocked wait return and
  the run proceed with no message ever sent; an attended `:work` pane
  answered from the console reconciles at the human's next touch (queued
  doorbell, registry verify); a shepherd herd question answered from the
  console; a doctor escalation answered from the board; respond's two
  gates end to end.

Skill prose has no unit tests; the writing runs under the writing-skills
discipline, and the smokes above are the behavioral checks.

## Coordination notes (live hazards)

- The settings registry keys shipped in rt-client 0.14.0
  (`rt.notify.eventBridges`, `board.agent.*`, `board.gateGraceMinutes`)
  exist only on the held `gate-events-rt` branch. No rt-client publish from
  main until that branch merges, or those commits are cherry-picked first.
- `board.reReview {enabled}` registration (queued elsewhere) waits for the
  facility branch by agreement; its shape is orthogonal to this design.
- SKILLS-58 (herd gate decisions through the bus, not pane forms) is
  absorbed by this spec's Delivery and Shepherdr sections; it stays open as
  the dogfood evidence record until W3 ships the herd path.

## Decisions (2026-09-03)

- One comprehensive spec; no fragmentation across passes.
- The in-pane experience does not change; the pane is one pathway among
  many; first answer wins.
- Held gate-events branches are reworked onto the facility before merging.
- Facility architecture: daemon gate registry with CAS answer, not
  journal-as-truth.
- Caller owns the posting decision; the engine keeps judgment and posting
  execution; the two-gate protocol retires.
- Doctor is a full member: escalation gates in the same wave as respond and
  the pipeline verbs.
- Self-review is not migrated through posting changes (it never posts); it
  reaches the facility through the generic pipeline part.
- The engine records rt-runs decisions at execution time regardless of
  decider.
- Unified pane protocol, two modes: every gated pane publishes; attended
  panes present the unchanged in-pane form, unattended panes block in
  `gate wait` with no form (revised 2026-09-03 on SKILLS-58's evidence,
  which showed forms in worker panes are the defect, not the UX).
- Delivery rides the Claude Code socket messaging protocol (rt chat's
  transport) with no chat sign-in required: cross-account doorbell pushes
  for attended panes (queue + reconcile-on-touch; nothing dismisses a
  form) and `gate subscribe` notifications. Observers are pushed to by the
  daemon's write path; nobody arms or re-arms event waits (SKILLS-35).
  Pushes wrap in the `<cross-session-message>` envelope; answers never
  travel in messages (spike rulings, 2026-09-03).
- Board wrapper panes are UNATTENDED (publish + blocking wait, as the held
  design had them): the board card is their answering surface, and the
  wait's return is what lets an external answer proceed the pane (spike
  ruling, 2026-09-03).
- The W1 delivery spike RAN 2026-09-03 and settled the mechanics; findings
  and rulings in `docs/superpowers/spikes/2026-09-03-gate-delivery-spike.md`.
- Option membership is STRICT, not advisory (revised 2026-09-03 on the
  SKILLS-58 addendum's silent-inversion evidence): option-bearing questions
  reject non-member values at the CAS verb; answers carry option text
  verbatim; surfaces never reorder or translate to indices. SKILLS-58's
  bridge-death and re-arm-lapse findings independently confirm the
  daemon-owned subscription design.

## Rejected alternatives

- Journal-as-truth facility (no registry): every surface re-implements the
  open-minus-answered fold; listing blocked runs means scanning journals;
  parking needs bespoke events.
- The fill drives the old two gates with pre-decided answers: an agent
  auto-answering forms meant for humans, with contradictory protocol text
  left in context.
- Board-owned gates shipped as-is with a later migration: buys a topic and
  ownership migration against a live journal for no design benefit, since
  nothing is deployed yet.
- Splitting the engine posting part in two: include rewiring and version
  churn for identical compiled output.
- Per-surface gate mechanisms (board endpoint logic, shepherdr relay,
  doctor errors) kept separate: the fragmentation this spec exists to end.
