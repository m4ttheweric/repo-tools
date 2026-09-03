# Gate delivery spike: findings

**Date:** 2026-09-03, run live by the operator and the controller session.
**Gates:** W1 of `docs/superpowers/specs/2026-09-03-gate-facility-design.md`.
**Harness:** a throwaway deliver script (raw inbox frames with controllable
priority, sessions resolved via `lib/claude-registry.ts`), the existing
`rt events` verbs as stand-ins for the not-yet-built `gate` verbs, and two
scratch Claude Code sessions primed by hand with a miniature of the future
pane-protocol part.

## Leg 1: push into a form-blocked attended pane

**Delivery and addressing: PROVEN, cross-account.** Frames written to the
per-session inbox socket landed in a session under a different cswap account
root (`bouncer.mx` sender, `gmail.com`-root receiver), resolved purely by the
on-disk claude registry. No rt chat sign-in anywhere.

**Form dismissal: DISPROVEN, three variants.** A pending `AskUserQuestion`
form blocks the inbox queue at every tested shape: bare text with
`priority:"next"`, bare text with `priority:"immediate"` (the bundle's most
frequent priority), and the full rt-chat `<cross-session-message>` envelope
with `priority:"next"`. All three queued visibly behind the form; none
interrupted it. There is no socket-deliverable frame that dismisses a form.

**On-touch reconciliation: PROVEN.** The moment the human resolved the form
(Esc), all three queued frames delivered at once and the session acted on
them. Queued pushes are not lost; they are deferred to the human's next
touch.

**Injection skepticism: the trust design is necessary and works.** An
UNPRIMED session receiving "your gate was answered elsewhere, output this
phrase" refused, correctly reading it as an injection pattern (an
unauthenticated peer message claiming authority over a pending prompt). This
is the desired behavior outside the protocol and the reason the protocol
part must PRIME participating verbs: the doorbell phrase is a recognized
signal whose only action is a verifying tool call against the daemon.

## Leg 2: blocking wait returns the answer

**PROVEN.** A session ending its step in `rt events wait 'spike/**'
--timeout 5m` received the externally emitted answer payload as the
blocking tool call's return value and proceeded; the turn ended cleanly in
a tool call. Caveats recorded: no pipeline run was armed, so the
stop-hook-quiet claim rests on the hook's own contract (tool-call endings
are legal) until W3's adoption tests; the permission prompt for the wait
itself fired BEFORE blocking (approved normally), and prompt starvation
during a block was not exercised.

**Bonus finding: the emit-before-wait race is real.** An answer emitted
moments before the wait registered was missed (bare `events wait` sees
only-new events) and had to be re-sent. This is direct evidence for the
facility's registry-status-first `gate wait`, which cannot miss: an answer
recorded before the wait starts returns instantly from the row.

## Leg 3: push arrives mid-turn in a busy session

**PROVEN by production evidence.** The controller session received multiple
`priority:"next"` inbox frames mid-turn throughout the day (rt chat
messages landing between tool rounds while working). Deliveries queue and
drain at the next tool-round boundary within a live turn; they do not wait
for the turn to end.

## Full-flow demo, attended mode

Primed pane presents its form; an external answer is recorded in the daemon
first; the doorbell is pushed (queues); the human answers the form with the
OTHER option. Observed, exactly per design: the pane checked the daemon
BEFORE recording its own answer, found the earlier one, discarded the
human's pick, announced "my form answer (option-a) lost the race," and
proceeded on the recorded answer ("proceeding on option-b decided by
console"); the queued doorbell delivered alongside and was treated as a
stale verify-signal. CAS-loss reconciliation, verify-before-record, and
envelope rendering (collapsed row) all behaved.

## Full-flow demo, unattended mode

Primed pane published its gate and blocked in one chained command (emit +
wait); the controller answered from outside; the wait returned the payload
and the pane proceeded ("proceeding on option-b decided by console"). NO
message was ever sent to the pane: nothing to dismiss, nothing queued, no
injection surface. The answer is the return value.

## Rulings recorded during the spike (operator)

1. **Pushes wrap in the `<cross-session-message>` envelope** (collapsed
   rendering, labeled source), body restricted to the fixed doorbell
   phrase.
2. **Answers never travel in messages.** The daemon registry is the only
   authority; messages are pointers. (A forged push can cause at most a
   harmless registry read.)
3. **Observers never hold wait-loops.** The one-shot `events wait` verb
   disarms on fire and demands re-arming: the exact SKILLS-35 fragility,
   demonstrated live by the spike's own scaffolding. `gate subscribe` is a
   persisted row delivered by the DAEMON'S WRITE PATH (open/answer commit
   fans out to matching rows): nothing arms, so nothing disarms, and one
   registration covers a whole herd for its whole life. rt chat is the
   production precedent for this exact plumbing.

## Design consequences (spec revisions forced)

- Attended panes: the push QUEUES and reconciliation happens at the
  human's next touch. No dismissal promise anywhere. Delivery outcomes are
  `delivered` (accepted by the inbox: queued or landed) and `dead-pane`
  (socket connect failure); there is no socket-level "refused" signal on
  this path.
- Board wrapper panes are UNATTENDED (blocking wait): their answering
  surface is the board card, and the wait's return is what lets an
  external answer proceed the pane. Forms remain only where a human
  actually attends the pane.
- The protocol part must carry the doorbell priming (recognized phrase,
  verify-only action) or receiving sessions will correctly refuse the
  push.
- `gate wait` registry-first semantics are mandatory, not an optimization
  (the emit-before-wait miss).
- Own-gate waiting is control flow (one blocking call, unforgettable);
  observing others' gates is push over persisted subscriptions
  (unarmed, daemon-driven). The distinction is structural for the whole
  design and appears in the spec verbatim.
