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
  topics, gate state in board review files, a board answer endpoint with its
  own conflict logic, and a parked-resume path hardwired to the review
  wrapper.
- Respond and doctor have their own decision mechanics (in-pane posting
  gates; terminal `error` escalations that dead-end until a human relaunches).
- Shepherdr hand-rolls a question relay between the herd and the user, scoped
  to the shepherd pane and lost if the shepherd dies.

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
| `subject` | `mr:<url>` or `run:<id>` |
| `questions` | the existing `GateQuestion[]` shape: `{id, label, multi, options}` |
| `status` | `open`, `answered`, `parked` |
| `answer` | `{answers, by, answeredAt}` |
| `openedAt`, `parkedAt` | timestamps |
| `agent`, `pane` | opener's refs, for focus, nudge, and resume |
| `nudge` | optional delivery spec recorded by the opener |

### Verbs

- `gate open --subject <s> --questions <json> [--agent <id>] [--pane <id>] [--nudge <spec>]`
  mints the id, stores the row, emits `gate/opened/<id>`.
- `gate answer <id> --answers <json> --by <surface>` is the single arbiter:
  compare-and-swap, a second answer is rejected cleanly. On success: store,
  emit `gate/answered/<id>`, run the nudge. Every surface answers through
  this verb; no per-surface conflict logic anywhere.
- `gate wait <id>` blocks until answered: journal-first and cursor-seeded,
  the race-hardened pattern the held board branch proved, promoted into the
  facility.
- `gate list [--open] [--subject-prefix mr:|run:]` is what surfaces render
  from. A query, never a journal fold.
- `gate park <id>` marks parked; answering unparks. Parking is a state
  transition here; parking POLICY stays with owners. The board keeps its
  grace sweep for `mr:` gates. `run:` gates do not auto-park in v1; a run
  waiting at a gate is normal and its pane stays.

### Events

`gate/opened/<id>` and `gate/answered/<id>` are ordinary rt-bus events
through the existing journal and the published `eventsEmit/Wait/List`
wrappers. The notifier's `rt.notify.eventBridges` routes them like any other
event, so tray notifications with a focus action come free. The namespace is
generic (`gate/*`, subject in the payload), replacing the board-scoped
`board/gate/*`.

### Nudge

On `answered`, the daemon delivers the opener's nudge: a message into the
blocked pane's session. A pending in-pane form is dismissed by an arriving
message (standard harness behavior), and the verb proceeds on the recorded
answer. Backends are pluggable per opener: herdr pane delivery for
board-launched panes, rt chat for signed-in sessions. A dead pane gets no
nudge; resume handles it (below).

### Agent and pane integration

The registry row's `agent`/`pane` refs power three things: a Focus button on
every gate card (the existing `paneFocus` bridge), nudge delivery targeting,
and parked resume. Agent status can surface "at gate" so run listings show
blocked state without extra plumbing.

## Surfaces

### Board (rework of the held branch)

The guts swap; the experience stays. The status-bin `gate` verbs become thin
clients of the daemon with the same CLI shape. The board stops owning gate
state: boot reconcile is `gate list --subject-prefix mr:`, live updates
subscribe to `gate/*` events, and `/gate/answer` proxies
`gate answer --by board` (daemon CAS replaces the board's 409 logic). The
grace sweep stays board-side and executes facility transitions. Parked
resume generalizes: the wrapper prompt is rebuilt by pane kind (review,
respond, doctor) instead of assuming review. Surviving unchanged from the
held branch: the card UI, focus buttons, auto-close at done,
launch-via-agent, the park/resume UX.

### Console (new)

RunRow shows a blocked badge when an open gate exists for `run:<id>`.
RunDetail renders the gate card, ported from the board's pattern: questions,
an Answer action (`gate answer --by console`), and Focus pane side by side.
v1 scope: the console renders `run:` gates and the board renders `mr:`
gates; cross-rendering is a later nicety.

### Pane (one protocol, everywhere)

A shared engine part defines gating for any verb or wrapper:

1. Publish the gate: `gate open` with subject, questions, and pane refs.
2. Present the normal in-pane structured form. The in-pane experience does
   not change.
3. Form answered: `gate answer --by pane`. If CAS reports an earlier answer,
   discard the form's answer and proceed on the recorded one.
4. Answered externally while the form sits: the nudge message dismisses the
   form and the verb proceeds on the recorded answer.
5. Daemon down: form-only, exactly today's behavior.

This unifies a split the held branch had: board-launched panes used to hold
silently at `gate wait` with conversational answering only. Under the shared
part, every gated pane presents its form, so "open any blocked pane and the
question is waiting" holds across `:work` runs and board panes alike.

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
- Untouched: `review-core-*`, `gitlab-mr-threads`, `wrap-up-form`. The
  self-review and receive-review verbs keep their own gates as gates; they
  adopt the facility through the pipeline part below, not through posting
  changes (self-review never posts).

Fill edits (team pack repo): the pack's review fill becomes a thin @2
adapter. Both provides spots bump to `mr-review@2` (the fill's frontmatter
and the pack manifest's provides row). Flow: invoke the review verb
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

The skills layer above, with the wrapper gating via facility verbs and
presenting the in-pane form per the unified pane protocol. Park, resume via
`--resumed-gate`, re-review semantics, and the clean-review one-click
approve all carry over from the held design.

### Respond (`mr-respond@2`)

Respond keeps its two decision phases; each becomes a facility gate,
answerable from any surface:

- Gate 1, the plan: one question per unresolved thread (reply, fix, skip)
  built from the fill's adjudication and recommendations, plus the
  code-changes approval.
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
questions with subject `run:<id>`. The existing `rt runs decision record`
bookkeeping keeps working, with `--decided-by` taken from the CAS answer's
`by`. This is what lights up the console for `:work` runs.

### Shepherdr

Shepherdr already hand-rolls this: workers emit blocked/question signals and
the shepherd relays structured questions between the herd and the user,
scoped to the shepherd pane. Worker questions become facility gates, and the
relay becomes one more surface: shepherdr presents herd gates in the
shepherd conversation exactly as today and records answers with
`gate answer --by shepherd`; its watcher keys off `gate/opened` events.

Gains: herd questions escape the shepherd pane (visible and answerable on
the console, the board, the worker's own pane, or the relay; first answer
wins); questions survive a shepherd crash because gates outlive any surface;
and the existing "theirs to answer, never yours" distinction becomes relay
policy over gate metadata rather than a separate mechanism. The plan pins
the exact question-contract replacement after a full read of the shepherd
engine.

## Waves

- **W1, the facility:** daemon registry, verbs, events, nudge; rt-client
  wrappers. Additive; may merge to rt main early. Nothing half-wired ships.
- **W2, review end to end:** board rework onto the facility plus the skills
  layer (engine, fill). Live verify, then the held gate-events family
  (board, rt, console branches) merges here.
- **W3, everything answers everywhere:** the pipeline part and verb
  adoption, the console surface (it needs `run:` gates to exist, hence this
  wave), respond @2, doctor @2, shepherdr.

Every push, publish, plugin update, and merge is individually gated on the
operator's go.

## Verification

- **W1:** CAS race test (two surfaces answer the same gate fast; exactly one
  wins and the loser gets a clean rejection); wait/list semantics; nudge
  delivery to a live pane.
- **W2:** the review smoke: findings review (gate opens, card offers tiers
  plus outcome, only selected tiers post, scoped summary, correct
  reaction); clean review one-click approve; the REQUIRED park, answer,
  resume test (fresh pane posts from the report file, no re-review, no
  hang); daemon-down degraded form.
- **W3:** block a run at a self-review gate, answer from the console, watch
  the pane's form dismiss and the run proceed; a shepherd herd question
  answered from the console; a doctor escalation answered from the board;
  respond's two gates end to end.

Skill prose has no unit tests; the writing runs under the writing-skills
discipline, and the smokes above are the behavioral checks.

## Coordination notes (live hazards)

- The settings registry keys shipped in rt-client 0.14.0
  (`rt.notify.eventBridges`, `board.agent.*`, `board.gateGraceMinutes`)
  exist only on the held `gate-events-rt` branch. No rt-client publish from
  main until that branch merges, or those commits are cherry-picked first.
- `board.reReview {enabled}` registration (queued elsewhere) waits for the
  facility branch by agreement; its shape is orthogonal to this design.

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
- Unified pane protocol: every gated pane presents its form, including
  board-launched panes that previously held silently.

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
