# rt runner: design

A slick full-screen board that manages long-running commands as headless
herdr panes. The first (and V1's only) `session` view of the rt-ui bridge:
brains in `commands/runner.ts`, pixels in `rt-ui session --view board`.

Reads with `2026-08-29-rt-ui-bridge-design.md`, which owns the protocol,
the binary, distribution, and testing seams. This spec owns the runner's
behavior, the `board` view's model and intents, and the herdr engine.

Approved screens (Runner board page):
https://claude.ai/code/artifact/a3c48e8f-03a9-4be5-be17-84a3988f39bb

## Goal

One clean board to launch, watch, and control the long-running commands of
a work session (dev servers, watchers, workers). Each command runs
**headless** in its own herdr pane so its output never clutters the screen;
the board lists them, and a keypress tails, focuses, restarts, stops, or
adds one. The board is owned by the pane it runs in: quit the board and
everything it launched dies with it.

## Non-goals

- **Not a persistent process manager.** No supervision, no restart-on-
  crash, no state that outlives the TUI. rt's daemon was deliberately
  stripped of process supervision; this does not re-add it. herdr owns the
  processes while the board is alive.
- **Not the old runner.** The prior `commands/runner.tsx` was a lanes +
  ports dashboard. This is a flat command list.
- **Not a `rt run` replacement.** `rt run` keeps its one-shot inline
  behavior and its `launchInHerdr` "not inside herdr → run sequentially"
  fallback; the runner reuses only its resolver.
- **No inline/tmux fallback.** herdr is required. The probe is the socket
  (`herdrAvailable()` in `lib/herdr/client.ts`: the socket exists and
  answers `session.snapshot`), not `HERDR_ENV`; a board driven from a pane
  is the normal case, but only the socket is actually needed to launch.
- **No standalone binary.** An earlier draft had the runner as its own Go
  program shelling out to `rt run` and `herdr`. Superseded: the runner is
  a TS command rendering through the shared `rt-ui` helper. herdr logic
  stays in TS where `lib/agent-herdr.ts` and `lib/herdr-launch.ts` already
  live.

## User-facing behavior

`rt runner` opens the board in the current terminal (alt-screen). Under
`RT_BATCH` or without a TTY it prints "rt runner needs an interactive
terminal" and exits 1. States, as drawn:

- **Populated board.** One row per command: status glyph, name, the command
  string, `pkg · repo`, and uptime (or `exited <code>`). The selected row
  carries a pink bar. An open **tail peek** shows the selected command's
  last ~8 output lines, refreshed ~1 s.
- **Empty board.** `Nothing running. Press a to add a command.`
- **Quit confirm.** A `y/n` layer whenever at least one process is still
  running, because quit tears everything down.

### States

| state | glyph | derived from |
|---|---|---|
| running | ● mint | the pane's foreground process is not its shell |
| stopped | ○ dim | foreground is the shell and the exit sentinel read `0` or `130` (clean exit or Ctrl-C) |
| crashed | ✗ coral | foreground is the shell and the sentinel read any other code |
| starting / stopping | braille spinner mint / coral | optimistic, until the next poll confirms |

`herdr pane process-info` reports `foreground_processes[]` and `shell_pid`
but **no exit code** (verified against the live CLI 2026-08-29). So every
command is launched wrapped: `cd <dir> && <cmd>; printf '\n__rt_exit %s\n'
$?`, and the exit code is parsed from the last `__rt_exit` line in `pane
read` once the foreground has returned to the shell. That is the only way
stopped and crashed can be told apart.

### Keys

| key | action |
|---|---|
| `j`/`k`, ↑/↓ | move selection (Go-local, never crosses the pipe) |
| `a` | add a command via the `rt run` picker |
| `s` | restart selected: Ctrl-C, wait for the shell, re-run in the same pane |
| `x` | stop selected: Ctrl-C |
| `f` | focus selected: jump herdr's view to its live pane |
| `t` | toggle the tail peek (Go-local; emits a `tail` intent so TS knows what to poll) |
| `q` / Ctrl-C | quit (confirm layer if anything is running), then tear down |

## Architecture

```text
commands/runner.ts (TS)                rt-ui session --view board (Go)
  entries[] + herdr calls   ──model──▶   renders the board
  runs the intent loop      ◀─intent──   j/k/t handled locally; a/s/x/f/q emitted
  polls liveness + tails
```

The TS command owns every entry, every herdr call, and the poll timers. Go
owns the cursor, the open/closed tail panel, the spinner frame, the
quit-confirm layer, and the per-second uptime display. The wire carries
only domain state down and user actions up.

### The `board` view

**Model** (full replacement on every push):

```jsonc
{ "workspace": "rt-runner-a3f9",
  "entries": [
    { "id": "e1", "name": "dev", "command": "bun run dev", "pkg": "web", "repo": "acme",
      "state": "running" | "stopped" | "crashed" | "starting" | "stopping",
      "startedAt": "2026-08-29T22:38:26.000Z",   // Go derives m:ss on its own 1 s tick; TS never pushes a counter
      "exitCode": null,                          // set once the sentinel is read
      "error": null,                             // a herdr failure message for this entry, if any
      "tail": null | [ { "ts": "22:41:07", "text": "VITE v5.4.2  ready in 412 ms" }, … ] }
  ] }
```

`tail` is non-null for exactly one entry: the selected one, while the peek
is open, **whatever its state**. A crashed entry's tail is the case that
matters most (it shows why it died), so `pane read` runs for it as readily
as for a running one. Go emits `{ "t": "intent", "name": "tail",
"entryId": "e1", "open": true|false }` on toggle and on selection change
while open; TS runs the first `pane.read` **immediately** on that intent
(never waiting for the next tick, so a `j`/`k` with the panel open never
shows a blank peek), then every 1 s, and nulls the previous entry's tail.
The `__rt_exit` sentinel line and the trailing shell prompt are filtered
out of what is pushed.

**Intents** (all carry `entryId` except `add` and `quit`):

| intent | TS does |
|---|---|
| `add` | the add flow below |
| `restart` | marks `starting`, sends Ctrl-C, waits for the foreground to return to the shell (poll `process_info` up to 5 s), then runs the wrapped command in the same pane; if the shell never returns, marks `error` "did not stop" and leaves the pane alone |
| `stop` | marks `stopping`, sends Ctrl-C |
| `focus` | `tab.focus` |
| `tail` | starts/stops the tail poll for that entry |
| `quit` | teardown, exits 0 (Go has already shown the y/n layer and only emits `quit` on `y`) |

The quit-confirm layer is Go-local: Go knows whether any entry is running
from the model, shows the layer on `q` or Ctrl-C, and emits `quit` only on
`y`. TS never sees `n`. The board therefore never produces
`closed{cancel}`; a `130` from the child is treated as "the UI died".

### Add flow

`a` is the one intent that needs the terminal for something other than the
board: the `rt run` picker chain is fzf. There is no suspend protocol;
the flow is:

1. TS sends `close`, **awaits the child's exit** (Go has left the alt
   screen and restored the terminal), and pauses both poll timers.
2. TS runs the picker chain **in-process**: `commands/run.ts` gains an
   exported `resolveRun(ctx): Promise<RunResolveResult | null>` (the
   repo → worktree → package → script chain with no launch and no stdout
   write), which `runCommand --resolve-only` also uses. No second `rt`
   process, no dispatcher breadcrumb, no `clearScreen`, no dev-mode
   binary drift.
3. On a result, TS appends the entry in `starting` and **reopens the
   session immediately** with that optimistic row, then performs the
   herdr launch (`tab.create` + the wrapped `pane run`) behind the board;
   the next poll flips the row to `running`. On `null` (Matt backed out),
   TS reopens the board unchanged.

What the user sees: the board drops to the normal screen, fzf appears
(that is fzf's own spawn, which rt users already know), fzf closes, the
board is back with the new row spinning. The only rt-ui cost in that gap
is one session spawn, which happens while the user's eyes are still on
the picker's exit.

Poll timers are gated on an open session: nothing is pushed while the
session is closed, so no push can hit a closed pipe.

### Engine: herdr over the socket

Every herdr call goes through `lib/herdr/client.ts` (`herdrRequest`):
one NDJSON request per connection to `~/.config/herdr/herdr.sock`, no
subprocess. The socket API (`herdr api schema --json`, protocol 19)
carries every verb the runner needs; method names are listed here as read
from that schema, with params confirmed against it at implementation time.

| runner action | socket method |
|---|---|
| create the board's home (lazily, on first add) | `workspace.create` (label `rt-runner-<id>`, unfocused) → root pane |
| add a command | first: `tab.rename` the fresh workspace's initial tab and run in its root pane; then `tab.create` (label = entry name, unfocused) → run in its root pane |
| run a command in a pane | `pane.send_text` with the wrapped command + `pane.send_keys` Enter (what `herdr pane run` does; `shellQuote` from `lib/herdr-launch.ts` for the `cd` prefix and the command, exactly as `launchInHerdr` does) |
| liveness | `pane.process_info` |
| exit code | `pane.read` (recent, unwrapped) → last `__rt_exit N` line |
| tail | `pane.read` (recent, last 200 lines) |
| focus | `tab.focus` |
| stop | `pane.send_keys` Ctrl-C |
| teardown | `workspace.close` |

The schema also publishes a `pane.exited` event; if it carries the pane's
foreground exit, phase 2 may subscribe to it instead of parsing the
sentinel. The sentinel is the specified mechanism; the event is an
optimization to evaluate, not a dependency.

One token to confirm at implementation time: the key name `send_keys`
expects for Ctrl-C.

"Headless" is an unfocused workspace: its tabs keep running while
unfocused. Each runner instance gets its own uniquely labeled workspace, so
several boards can run at once.

### Lifecycle: die with the TUI

The board is in-memory only. On quit (`quit` intent, SIGINT, SIGTERM, or
the session dying), TS closes the whole workspace, killing every tab and
process at once. The documented gap: `SIGKILL` runs no cleanup and
orphans the workspace (recoverable by hand with `herdr workspace close`).
Acceptable for a session-scoped tool.

### Polling

- **Liveness**: every 1.5 s, `pane.process_info` per entry over the socket
  (six entries is six socket round-trips, no spawns), derive state, and
  push the model **only if something changed**. Uptime is not a change:
  Go derives it from `startedAt`.
- **Tail**: every 1 s while a tail is open, `pane.read` for that one
  entry; push only if the lines changed.
- Optimistic `starting`/`stopping` hold until a poll confirms. All calls
  are async; the intent loop never blocks on one, and a herdr error on an
  entry sets its `error` and leaves the board usable.

## Wiring

- `commands/runner.ts`: `runnerCommand`: the TTY/`RT_BATCH` gate, the herdr
  probe (plain message + exit 1 on failure, before any UI), then the
  session loop above.
- `commands/run.ts`: extract `resolveRun(ctx)` from `runCommand`; behavior
  of `rt run` and `rt run --resolve-only` unchanged.
- `lib/command-tree-def.ts`: a `runner` node, `module:
  "./commands/runner.ts"`, `fn: "runnerCommand"`, `requiresTTY: true`,
  `fullscreen: true` (so the dispatcher leaves no breadcrumb on the normal
  screen after the board exits), no required positional (so no
  `omitBehavior`).
- `lib/module-registry.ts`: `"./commands/runner.ts": () =>
  import("../commands/runner.ts")`.
- `ui/internal/views/board/`: the Go view, golden-tested against the three
  artboards.

## Error handling

- **herdr down**: caught by the probe; plain message, exit 1, no UI.
- **herdr call fails mid-session**: the entry's `error` is set and shown in
  its right column in coral; the board stays usable.
- **`resolveRun` returns null / throws**: board reopens unchanged (a throw
  is logged at `warn`).
- **session dies** (exit without `closed`, or any non-zero exit): TS runs
  teardown, prints a plain message, exits 1.

## Testing

- **Command loop** against `fake-rt-ui` (scripted intents) and a fake herdr
  socket (`lib/herdr/__tests__/fake-herdr.ts`): add (close → resolve →
  reopen-optimistic → launch), stop/restart optimistic states and the
  wait-for-shell in restart, tail toggle and the one-entry rule, quit
  teardown, lazy workspace creation, push-only-on-change.
- **State derivation**: pure unit tests for `process_info` + sentinel →
  state/exitCode.
- **Go view**: `teatest` golden output for populated + tail, empty, and
  quit-confirm, matching the artboards; j/k/t behavior; uptime derivation
  from `startedAt`; `quit` emitted only on `y`.

## Follow-ups

- "Add to runner" from `rt run`: does not fit the ephemeral, pane-owned
  model (no persistent board to target). Deferred.
- Rename / reorder rows: omitted from V1 for minimalism.
- `pane.exited` subscription instead of the sentinel, if the event carries
  the code.
