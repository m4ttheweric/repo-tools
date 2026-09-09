# The background server: one home for headless panes, addressable from every verb

**Date:** 2026-09-09
**Tickets:** RT-113 (this design), RT-114 (the `--help` launch bug, fixed on the same branch)
**Repos:** rt (daemon, CLI, rt-client); mr-board consumes the result, no board code in scope
**Supersedes:** the herd-private hidden-server arrangement from `2026-09-08-rt-herd-design.md` section "Hidden mode" (the mechanics survive; the ownership moves)
**Status:** approved in brainstorm 2026-09-09; implementation pending

## Problem

The estate has three background-pane mechanisms and none of them share an
abstraction: the herd's hidden herdr server (daemon-started, herd-private,
socket recorded per herd row), the runner's `--herdr` engine (its own socket
door), and `rt agent --surface headless` (no pane at all). Every
pane-consuming verb in the command tree (`rt pane list/peek/send/focus`,
chat `--pane`, gate refs, agent results, herd status) assumes the single
visible server, so a pane on the hidden server is unreachable except through
herd-specific verbs. W3 proved the hidden mechanics live; RT-113 is Matt's
ask to generalize them: one standing headless server, and every pane verb
works on its panes with nothing special at the call site.

## Decisions (brainstormed with Matt, 2026-09-09)

- ONE daemon-owned background server; herd hidden mode, the runner's
  `--herdr` engine, and new consumers (board agent actions) all become its
  clients. Not a fourth mechanism beside the existing three.
- Pane addressing by **prefix**: `bg:w1:p2`. Bare ids keep meaning the
  visible server.
- Lifecycle **lazy**, with ensure-on-touch built into the abstraction: no
  caller ever checks whether the server is up.
- Environment fidelity is designed in, not assumed (see Environment).
- **Hard cutover**: one branch, everything lands together; no staged waves.
- The tmux default of the runner is out of scope: different substrate,
  deliberately kept.
- Vocabulary: the server is the **background server** (`bg`). "Headless"
  keeps meaning `rt agent --surface headless` (a pane-less claude run) and
  nothing else. Herds keep the user-facing word "hidden"; a hidden herd is a
  herd whose panes live on the background server.

## The bg service (daemon-owned)

A daemon service owning what `deps.hidden.*` does for herds today,
promoted and generalized.

- `ensure()`: idempotent start. nohup in a shell with job control on, own
  process group, survives daemon restarts. Fixed socket:
  `~/.config/herdr/sessions/bg/herdr.sock`, session name `bg`.
- `up()`, `stop()`, and a **client registry** (claims).
- **Claims:** every consumer that creates panes registers one --
  `herd:<id>`, `runner:<pid>`, `agent:<record id>` -- and releases it when
  its panes close. `stop` refuses while claims are live and lists them by
  name. No force flag exists.
- Claims persist in their own store file beside the herd registry: never
  `state.db`, no `SCHEMA_VERSION` entanglement, refusal semantics survive
  daemon restarts.
- **Ensure-on-touch:** `ensure()` runs before every operation that CREATES
  a pane on the bg server (herd hidden start, `rt agent start --bg`, the
  runner's acquire). Operations addressing an EXISTING `bg:` pane (peek,
  send, inject, escape, focus/attend, list, status) never ensure: a pane on
  a downed server no longer exists, so starting a fresh empty server cannot
  help -- they answer "not running" / pane-not-found cleanly instead. The
  caller still never checks server state itself; the abstraction owns both
  behaviors.
- Lifecycle event forwarding (the wildcard `events.subscribe` per known
  server) keys off this service; herd stops being special.
- `rt herd stop --hidden` becomes an alias for the service stop; its
  refusal is now claim-based, so it refuses for a live runner board too,
  by name.

## Environment

The daemon runs under launchd with a minimal env; the failure class is
known (dev-daemon 127, deck TCC). Three mechanisms, layered by lifetime:

1. **Pane env is fresh at pane spawn.** Every pane runs the user's login
   shell, which re-sources zshenv/zprofile at creation -- mise shims, PATH.
   A pane spawned now sees a PATH change made five minutes ago regardless
   of server age; already-running panes are frozen at their own spawn,
   exactly like visible terminal tabs. W3's workers proved this live
   (claude, bun, git, rt all resolved inside daemon-started hidden panes).
2. **Server env is seeded, not inherited.** `ensure()` captures a
   login-shell snapshot (`zsh -lc` probe: PATH, HOME, SHELL, TMPDIR, LANG)
   and starts herdr with it, so the server's own binary resolution matches
   the user's terminal, not launchd. This layer is frozen at `ensure()`
   time; its blast radius is herdr internals only.
3. **Parity is checked, not assumed.** After start, `ensure()` runs one
   probe in a throwaway bg pane and diffs `which bun node claude rt git`
   and `$PATH` against the same probe on the visible server; a mismatch
   logs a loud structured warning naming the drift. The probe re-runs
   lazily when a bg spawn fails with a command-not-found shape.

**Structural non-parity, named:** TCC grants, `SSH_AUTH_SOCK`, and
`launchctl setenv` vars live in the GUI session and cannot be equalized by
construction. This list is the known delta; a failure matching it is
recognized, not re-diagnosed.

Bg panes get `HERDR_SESSION`/socket env pointing at the bg server, so rt
verbs run inside them resolve their own pane correctly.

## Addressing and the verb sweep

One ref grammar, one parser. `parsePaneRef` / `formatPaneRef` live in
rt-client (exported; version bump announced before merge per CLAUDE.md).
`bg:w1:p2` targets the background server; bare `w1:p2` is the visible
server, byte-compatible with today. Herd rows keep their separate
`herdrSocket` column. Gate rows and every other pane-id-shaped string field
(`GateRow.pane`, `GateOrigin.paneId`, `AgentRecord.paneId`, `HerdJobInfo.pane`)
carry NO socket today and gain none: the prefixed ref rides IN the existing
string field, which is the design's payoff -- no schema changes anywhere.
The ref is parsed at each use site (the daemon's edge and the injection
seams).

A census correction the sweep must absorb: `lib/daemon/inject.ts`
(pane:send, chat:invite) and `lib/daemon/gate-escape.ts` (the gate Escape
nudge) have no socket parameter at all today -- injecting into a hidden
pane is currently impossible, full stop. The sweep threads a
ref-resolved socket through both.

Two rules make the sweep one rule instead of per-verb patches:

1. **Round-trip rule.** Any output that prints a pane prints it in
   addressable form: a bg pane always renders `bg:w1:p2` -- herd status,
   spawn results, `rt pane list`, gate rows, room lifecycle lines. Whatever
   one verb prints, every verb accepts. Mechanically testable.
2. **The behavior fork lives in exactly one verb: `focus`.** Bare ref: the
   tray path, unchanged (herdr has no focus; the tray raises the window).
   `bg:` ref: the attend flow -- a visible tab running a terminal attach
   against the bg pane, tab id printed, detach hint (`ctrl+b q`). There is
   no new `attend` verb; focus IS attend for background panes.
   `rt herd attend <job>` survives as job-name sugar over the same code.

Everything else is mode-blind: `peek`, `send`, chat `--pane`, gate
nudge/inject resolve the ref, pick the socket, behave identically.
`rt pane list` grows one labeled bg section when the server is up and stays
silent when it is not.

## Consumers

- **Herd:** `hidden.ensure()` delegates to the bg service. `rt herd start
  --hidden` claims `herd:<id>`; wrap-up releases it. Herd rows keep their
  socket field; herd surfaces display `bg:` refs per the round-trip rule.
  Otherwise behavior-invisible.
- **Runner `--herdr`:** the engine gets the bg socket from the daemon
  (ensure + claim `runner:<pid>`). Honesty note from the census: the
  runner has ZERO daemon dependency today -- it resolves the ambient
  `HERDR_SOCKET_PATH` (or the default socket) and errors only when herdr is
  not answering there -- so this RPC (via the
  rt-client wrappers every other command already uses) is wholly new
  wiring, not a re-point. Die-with-board is preserved: teardown closes its
  own workspace as today, then releases the claim. The tmux default is
  untouched.
- **`rt agent start --bg`:** new flag. The daemon plumbing is a head
  start: `agent:start`'s payload already carries `herdrSocket?` wired
  through `launch()`, so `--bg` is CLI parsing plus daemon-side
  ensure+claim (`agent:<record id>`) plus printing the `bg:` ref. The
  claim releases when the pane closes (the lifecycle forwarder already
  watches bg-server `pane.closed` events). This is the primitive board
  actions consume; board-side adoption is out of scope here.

## RT-114 rides along

`rt agent start --help` launches a real agent (no required positional, so
nothing forces the usage path). Fix on this branch, early: `--help` on any
leaf prints usage and exits 0, side-effect free, plus tests: the tree's
existing leaf-guard coverage for ordinary leaves, and a structural check
that every self-dispatching leaf module consults the new guard.

## Testing

- Unit: ref parse/format round-trip; claim lifecycle and stop refusal
  (refusal message names live claims); focus-fork routing against fake tray
  and fake herdr; dual-server `pane list`; read-vs-write ensure semantics;
  env snapshot capture and parity probe with fake shells.
- One mechanical invariant test: every formatter output feeds the parser.
- e2e (opt-in, tagged, the chat/herd recipe): ensure, spawn a pane, peek
  and send via `bg:` ref, focus-as-attend, stop refused while a claim is
  live, stop clean after release.
- The regression test from RT-114 across the whole command tree.

## Rollout: hard cutover

One branch. RT-114 fix first, then service, sweep, consumer re-points,
tests. Cutover when confident: merge, dev daemon restart (the running
daemon is the deployed code), rt-client publish from main with the version
bump announced to peer sessions, and stop any live legacy `herd` hidden
session (`herdr session stop herd`) -- the bg service uses session name
`bg` with its own socket, so a leftover `herd` server would be orphaned,
not adopted. No staged waves, no compatibility shims beyond bare-ref
backcompat, which is permanent.

## Rejected alternatives

- **A fourth server beside the existing three** (standing server for new
  consumers only): ships faster, leaves three background worlds and every
  verb still needing to know which one a pane lives in. Rejected as the
  opposite of the ask.
- **Daemon-side bare-id resolution across servers** (no prefix): zero
  caller changes, ambiguous in scripts the moment both servers hold a
  `w1:p2`. Rejected for the prefix.
- **Boot-time server start:** always-on process on machines that never use
  it; lazy + ensure-on-touch gives the same caller experience without it.
- **Migrating the runner's tmux default:** different substrate, deliberate
  prior ruling; only the `--herdr` mode converges.
