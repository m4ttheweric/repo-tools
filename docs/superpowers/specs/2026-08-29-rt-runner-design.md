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
  behavior unchanged; the runner reuses its `--resolve-only` resolver.
- **No inline/tmux fallback.** herdr is required.
- **No standalone binary.** An earlier draft had the runner as its own Go
  program shelling out to `rt run` and `herdr`. Superseded: the runner is
  a TS command rendering through the shared `rt-ui` helper. herdr logic
  stays in TS where `lib/agent-herdr.ts` and `lib/herdr-launch.ts` already
  live.

## User-facing behavior

`rt runner` opens the board in the current terminal (alt-screen). States, as
drawn:

- **Populated board.** One row per command: status glyph, name, the command
  string, `pkg · repo`, and uptime (or `exited <code>`). The selected row
  carries a pink bar. An open **tail peek** shows the selected command's
  last ~8 output lines, refreshed ~1 s.
- **Empty board.** `Nothing running. Press a to add a command.`
- **Quit confirm.** A `y/n` layer whenever at least one process is still
  running, because quit tears everything down.

### States

| state | glyph | meaning |
|---|---|---|
| running | ● mint | process alive |
| stopped | ○ dim | user stopped it (Ctrl-C), shell idle |
| crashed | ✗ coral | process exited non-zero |
| starting / stopping | braille spinner mint / coral | optimistic, until the next liveness poll confirms |

### Keys

| key | action |
|---|---|
| `j`/`k`, ↑/↓ | move selection (Go-local, never crosses the pipe) |
| `a` | add a command via the `rt run` picker |
| `s` | restart selected: Ctrl-C, then re-run in the same pane |
| `x` | stop selected: Ctrl-C |
| `f` | focus selected: jump herdr's view to its live pane |
| `t` | toggle the tail peek (Go-local) |
| `q` / Ctrl-C | quit (confirm layer if anything is running), then tear down |

## Architecture

```
commands/runner.ts (TS)                rt-ui session --view board (Go)
  entries[] + herdr calls   ──model──▶   renders the board
  runs the intent loop      ◀─intent──   j/k/t handled locally; a/s/x/f/q emitted
  polls liveness + tails
```

The TS command owns every entry, every herdr call, and the poll timers. Go
owns the cursor, the open/closed tail panel, the spinner frame, and the
quit-confirm layer. The wire carries only domain state down and user
actions up.

### The `board` view

**Model** (full replacement on every push):

```jsonc
{ "workspace": "rt-runner-a3f9",
  "entries": [
    { "id": "e1", "name": "dev", "command": "bun run dev", "pkg": "web", "repo": "assured-dev",
      "state": "running" | "stopped" | "crashed" | "starting" | "stopping",
      "uptimeSec": 161, "exitCode": null,
      "tail": [ { "ts": "22:41:07", "text": "VITE v5.4.2  ready in 412 ms" }, … ] }   // last 200 lines, running entries only
  ] }
```

`uptimeSec` is computed in TS from `startedAt` and pushed with each poll;
Go does not run its own clock for it (one source of truth, one tick).
`tail` is pushed only for the selected entry when the peek is open: Go
emits `{ "t": "intent", "name": "tail", "entryId": "e1", "open": true }` on
toggle and on selection change while open, and TS starts or stops the
`pane read` poll for that entry.

**Intents** (all carry `entryId` except `add` and `quit`):

| intent | TS does |
|---|---|
| `add` | closes the session, runs the `rt run` picker, launches the result, re-opens the session with the full model |
| `restart` | marks `starting`, `pane send-keys C-c`, then `pane run <cmd>` in the same pane |
| `stop` | marks `stopping`, `pane send-keys C-c` |
| `focus` | `tab focus <tabId>` |
| `tail` | starts/stops the `pane read` poll for that entry |
| `quit` | `workspace close`, exits 0 (Go has already shown the y/n layer and only emits `quit` on `y`) |

The quit-confirm layer is Go-local: Go knows whether any entry is running
from the model, shows the layer on `q`, and emits `quit` only on `y`. TS
never sees `n`.

### Add flow

`a` is the one intent that needs the terminal for something other than the
board: the `rt run` picker is fzf. Rather than a suspend/resume protocol,
TS **closes the session** (Go leaves the alt screen and exits 0), runs
`rt run --resolve-only` inline (its pickers draw to stderr, the resolved
`RunResolveResult` JSON lands on stdout, already how `commands/run.ts`
works), launches the result as a new headless tab, and **opens a fresh
session** with the full model. Sessions cost ~25 ms; the board blinks once
and comes back with the new row in `starting`. An empty stdout (Matt backed
out) re-opens the board unchanged.

### Engine: the herdr CLI, from TS

Every process operation is a `herdr` subprocess call through the runner
pattern in `lib/agent-herdr.ts` (absolute path, `HERDR_SOCKET_PATH` set, a
non-zero exit fails the operation loudly).

| runner action | herdr call |
|---|---|
| create the board's home (lazily, on first add) | `workspace create --label rt-runner-<id> --no-focus` → `result.root_pane` |
| add a command | first: rename the fresh workspace's initial tab and `pane run` in its root pane; then `tab create --workspace <ws> --label <name> --no-focus` → `pane run <root_pane> <cmd>` |
| tail | `pane read <pane> --source recent --lines 200` |
| focus | `tab focus <tab>` |
| stop | `pane send-keys <pane> C-c` |
| restart | `pane send-keys <pane> C-c`, then `pane run <pane> <cmd>` |
| liveness | `pane process-info --pane <pane>` |
| teardown | `workspace close <ws>` |

Two tokens to confirm against the live CLI during implementation (the verbs
exist; the exact strings are unverified): the send-keys name for Ctrl-C
(assumed `C-c`) and the `process-info` field that names the foreground
process (running vs. exited, and the exit code for crashed).

"Headless" is a `--no-focus` workspace: its tabs keep running while
unfocused. Each runner instance gets its own uniquely labeled workspace, so
several boards can run at once.

### Lifecycle: die with the TUI

The board is in-memory only. On quit (`quit` intent, Ctrl-C, SIGINT,
SIGTERM, or the session dying), TS closes the whole workspace, killing every
tab and process at once. The documented gap: `SIGKILL` runs no cleanup and
orphans the workspace (recoverable by hand with `herdr workspace close`).
Acceptable for a session-scoped tool.

### Polling

A TS timer every ~1.5 s issues `pane process-info` per entry, derives the
state, recomputes `uptimeSec`, and pushes the full model. When a tail is
open, a second ~1 s timer issues `pane read` for that one entry and pushes.
Optimistic `starting`/`stopping` hold until a poll confirms. All herdr calls
are async (`runCapture`); the intent loop never blocks on one.

## Wiring

- `commands/runner.ts`: `runnerCommand`: herdr probe (`herdrAvailable`
  from `lib/herdr/client.ts`; on failure print how to start herdr and exit
  non-zero before any UI), then the session loop above.
- `lib/command-tree-def.ts`: a `runner` node, `module:
  "./commands/runner.ts"`, `fn: "runnerCommand"`, `requiresTTY: true`, no
  required positional (so no `omitBehavior`).
- `lib/module-registry.ts`: `"./commands/runner.ts": () =>
  import("../commands/runner.ts")`.
- `ui/internal/views/board/`: the Go view, golden-tested against the three
  artboards.

## Error handling

- **herdr down**: caught by the probe; plain message, exit non-zero, no UI.
- **herdr verb fails mid-session**: the entry gets `state: "crashed"` with
  the herdr message in `exitCode`-adjacent `error` text; the board stays
  usable.
- **`rt run` add returns nothing / bad JSON**: board re-opens unchanged.
- **session dies**: TS runs teardown, prints a plain message, exits 1.

## Testing

- **Command loop** against `fake-rt-ui` (scripted intents) and
  `fake-herdr`-style herdr fakes (`HERDR_BIN`): add, stop/restart optimistic
  states, tail toggle, quit teardown, lazy workspace creation, the
  close-then-reopen add flow.
- **Model assembly**: pure unit tests for `process-info` → state and
  `uptimeSec`.
- **Go view**: `teatest` golden output for populated + tail, empty, and
  quit-confirm, matching the artboards; j/k/t/q behavior; `quit` emitted
  only on `y`.

## Follow-ups

- "Add to runner" from `rt run`: does not fit the ephemeral, pane-owned
  model (no persistent board to target). Deferred.
- Rename / reorder rows: omitted from V1 for minimalism.
- Running outside a herdr client: only the socket is needed, but `focus`
  assumes a herdr UI is attached somewhere. V1 assumes `rt runner` runs from
  within herdr.
