# rt runner — design

A slick full-screen TUI that manages long-running commands as headless
herdr panes. Built as a standalone **Go + Bubble Tea** binary that ships
inside the rt release and is launched by a thin `rt runner` command.

Visual reference (approved 2026-08-29):
https://claude.ai/code/artifact/e7b3814f-7fc2-4526-aa03-b4f3203d24e4
Artboard source: `.local-dev/design/rt-runner/` (gitignored scratch).

## Goal

Give Matt one clean board to launch, watch, and control the
long-running commands of a work session (dev servers, watchers,
workers). Each command runs **headless** in its own herdr pane so its
output never clutters the screen; the board lists them, and a keypress
tails, focuses, restarts, stops, or adds one. The board is owned by the
pane it runs in: quit the board and everything it launched dies with it.

## Non-goals

- **Not a persistent process manager.** No supervision, no restart-on-
  crash, no state that outlives the TUI. rt's daemon was deliberately
  stripped of process supervision; this does not re-add it. herdr owns
  the processes while the board is alive.
- **Not the old runner.** The prior `commands/runner.tsx` was a
  lanes + ports dashboard. This is a flat command list. The old runner's
  widgets were extracted into `lib/tui/` and are not reused (that kit is
  Ink/TS; this binary is Go).
- **Not a `rt run` replacement.** `rt run` keeps its current one-shot
  inline behavior unchanged. The runner reuses its `--resolve-only`
  resolver to add commands.
- **No inline/tmux fallback.** herdr is required.

## User-facing behavior

`rt runner` opens a full-screen board in the current terminal. States
shown in the reference:

- **Populated board.** One row per command: status glyph, name, the
  command string, `pkg · repo`, and uptime (or `exited <code>`). The
  selected row carries a pink accent bar. An open **tail peek** shows
  the selected command's last ~8 output lines, refreshed ~1s.
- **Empty board.** `Nothing running. Press a to add a command.`
- **Quit confirm.** Because quit tears everything down, a `y/n` guard
  appears whenever at least one process is still running.

### Status states

Reused vocabulary (glyph · color from rt's palette):

| State | Glyph | Meaning |
|-------|-------|---------|
| running | ● mint | process alive |
| stopped | ○ dim | user stopped it (Ctrl-C), shell idle |
| crashed | ✗ coral | process exited non-zero |
| starting | braille spinner | optimistic, spawn in flight |
| stopping | braille spinner | optimistic, kill in flight |

### Keybindings

| Key | Action |
|-----|--------|
| `j`/`k`, ↑/↓ | move selection |
| `a` | add a command (via the `rt run` picker) |
| `s` | restart selected (Ctrl-C, then re-run in the same pane) |
| `x` | stop selected (Ctrl-C) |
| `f` | focus selected (jump herdr's view to its live pane) |
| `t` | toggle inline tail peek for selected |
| `q` / `Ctrl-C` | quit (confirm if anything running), then tear down |

## Architecture

### Two-binary shape

repo-tools becomes polyglot. The runner is its own Go module in a
`runner/` subdir; it compiles to a `rt-runner` binary bundled in the
release tarball beside `rt`. The `rt runner` command is a thin Bun
launcher that resolves and execs that binary with inherited stdio, then
exits with its code.

```
rt (Bun)  --exec-->  rt-runner (Go/Bubble Tea)
                        |
                        |-- shell: herdr <verb>          (pane control)
                        `-- shell: rt run --resolve-only  (add a command)
```

The runner never imports rt-client, never touches the daemon, and never
re-implements repo-identity or herdr-launch logic. It composes the `rt`
and `herdr` CLIs as subprocesses. This is what keeps it thin in a second
language.

### Repo layout

```
runner/
  go.mod
  main.go              entrypoint: herdr probe, then Bubble Tea program
  model.go             Model (board state) + Update (event loop) + View
  entry.go             Entry struct + status derivation
  herdr.go             herdr CLI client (workspace/tab/pane verbs)
  rtrun.go             `rt run --resolve-only` bridge (suspend/resume)
  theme.go             Lip Gloss styles ported from lib/tui/palette.ts
  poll.go              periodic liveness/tail refresh (tea.Tick)
  *_test.go
```

### Engine: the herdr CLI

Every process operation is a `herdr` subprocess call, exactly mirroring
`lib/herdr-launch.ts` and `lib/agent-herdr.ts`, but in Go. herdr is
invoked by absolute path with `HERDR_SOCKET_PATH` set (env inherited
from the launcher; falls back to `~/.local/bin/herdr` and
`~/.config/herdr/herdr.sock`, overridable by `HERDR_BIN` /
`HERDR_SOCKET_PATH` for tests).

| Runner action | herdr call |
|---|---|
| create the board's home | `workspace create --label rt-runner-<id> --no-focus` → `result.root_pane` |
| add a command | `tab create --workspace <ws> --label <cmd> --no-focus` → `result.root_pane`, then `pane run <root_pane> <cmd>` |
| first command | reuses the workspace's initial tab (rename it), like `launchInWorkspace` |
| tail | `pane read <pane> --source recent --lines N` |
| focus | `tab focus <tab>` |
| stop | `pane send-keys <pane> C-c` |
| restart | `pane send-keys <pane> C-c`, then `pane run <pane> <cmd>` |
| liveness | `pane process-info --pane <pane>` |
| remove one | `tab close <tab>` |
| teardown | `workspace close <ws>` |

Two herdr specifics to confirm against the live CLI during
implementation (both verbs exist; only the exact tokens are unverified):

- the send-keys token for Ctrl-C (assumed `C-c`);
- the `pane process-info` JSON field that names the pane's foreground
  process (used to distinguish running vs. exited).

A non-zero herdr exit fails the operation loudly (row flips to an error
state with the message), never a silent no-op ... same rule as
`runHerdr` in `lib/agent-herdr.ts`.

### Headless = a background workspace

"Headless" is a `--no-focus` workspace: its tabs keep running while
unfocused, so the command's output is off-screen until Matt asks for it.
`focus` switches herdr's view to that tab; `tail` reads it into the board
without switching. Each runner instance gets its own uniquely-labeled
workspace (`rt-runner-<shortid>`), so several boards can run at once
without colliding.

### Add flow (suspend / resume)

`a` reuses `rt run` untouched:

1. The Bubble Tea program releases the terminal (`tea.ExecProcess`),
   restoring cooked mode.
2. Exec `rt run --resolve-only` with inherited stdio. Its picker chain
   (repo → worktree → package → script) draws to **stderr**; the
   resolved `RunResolveResult` JSON lands on **stdout** ... already how
   `commands/run.ts` is built.
3. The runner parses stdout JSON (`targetDir`, `packageLabel`,
   `commandTemplate`) and re-acquires the terminal.
4. Launch the resolved command as a new headless tab and add its Entry.

An empty stdout (Matt backed out of the picker) is a no-op.

### Lifecycle: die with the TUI

The board is in-memory only. On quit ... `q`, `Ctrl-C`, `SIGINT`,
`SIGTERM`, or a fatal render error ... the runner closes its whole
workspace (`workspace close <ws>`), killing every tab and process at
once. A `y/n` confirm precedes teardown when any Entry is running.

The one gap, documented not solved: `SIGKILL` can run no cleanup and
would orphan the workspace (recoverable by hand with
`herdr workspace close`). Acceptable for a session-scoped tool.

### Status + tail polling

A `tea.Tick` every ~1.5s issues `pane process-info` per Entry to derive
running / stopped / crashed, and (when a tail peek is open)
`pane read` for the selected Entry. Polls run as `tea.Cmd`s off the
render loop so the UI never blocks on a subprocess. Optimistic
`starting` / `stopping` states hold until the next poll confirms.

## Data model

```go
type State int
const ( Running State = iota; Stopped; Crashed; Starting; Stopping )

type Entry struct {
    ID       string   // stable local id
    Label    string   // tab label / display name (from packageLabel)
    Command  string   // the command string
    Cwd      string   // targetDir
    RepoName string   // display, for the pkg · repo column
    TabID    string   // herdr tab id
    PaneID   string   // herdr root pane id
    State    State
    ExitCode *int     // set when exited
    Started  time.Time
}

type Model struct {
    WorkspaceID string   // rt-runner-<id>, created lazily on first add
    Entries     []Entry
    Cursor      int
    TailOpen    bool
    Confirming  bool     // quit confirm layer active
    // ... spinner frame, tail buffer, error line
}
```

The workspace is created lazily on the first `add`, so an opened-then-
quit empty board touches herdr zero times.

## Binary path resolution (the Bun launcher)

`commands/runner.ts` resolves `rt-runner` in this order:

1. `RT_RUNNER_BIN` env override (tests, power users).
2. A sibling of the rt executable: `dirname(process.execPath)/rt-runner`
   (release tarball layout).
3. Dev fallback: a locally built `runner/rt-runner`, else
   `go run ./runner` from the repo root.

It execs with `stdio: ["inherit","inherit","inherit"]` and exits with the
child's code. It performs the herdr-availability probe first (reusing
`herdrAvailable` from `lib/herdr/client.ts`) so the "herdr not running"
message is a fast rt-side exit, not a Go panic. The launcher imports no
Ink / `rt-render` ... it stays off the startup hot path and out of the
no-eager-tui budget.

## Error handling

- **herdr down**: caught by the launcher probe; prints how to start
  herdr and exits non-zero before the Go binary runs.
- **herdr verb fails mid-session**: the affected Entry shows an error
  state + the herdr message; the board stays usable.
- **`rt run` add returns nothing / bad JSON**: no-op with a brief toast;
  board unchanged.
- **binary missing** (release packaging bug): launcher prints the
  resolution paths it tried and exits non-zero.

## Distribution

Read `docs/release-and-distribution.md` before implementing this
section. Concretely:

- **Build**: `.github/workflows/release.yml` gains a Go build step
  (`cd runner && go build -o ../dist/rt-runner`) for macOS arm64, and
  bundles `rt-runner` into the release tarball beside `rt`.
- **Signing / Gatekeeper**: the Go binary is unsigned by default and
  will be Gatekeeper-blocked the same way the app bundle is. It must get
  the same signing / de-quarantine treatment the release already applies
  to `rt`. This is the biggest distribution risk and is verified in the
  VM clean room, not just locally.
- **Startup bench**: unaffected. `rt runner` is a tiny launcher; the Go
  binary is never loaded at rt startup, so `scripts/bench-startup.ts`
  and the no-eager-tui gates stay green.

## Wiring

- `lib/command-tree-def.ts`: add a `runner` node ... `module:
  "./commands/runner.ts"`, `fn: "runnerCommand"`, `requiresTTY: true`,
  no required positional (it opens the board), so no `omitBehavior`.
- `lib/module-registry.ts`: add
  `"./commands/runner.ts": () => import("../commands/runner.ts")`
  (required for the compiled binary to discover the module).

## Testing

- **Go / herdr client**: exercise every verb against a fake `herdr`
  binary injected via `HERDR_BIN` (a script emitting canned JSON),
  mirroring `lib/herdr/__tests__/fake-herdr.ts`. Assert the exact argv
  and JSON parsing (workspace/tab create → root_pane, process-info →
  state).
- **Go / add bridge**: fake `rt` via `RT_BIN` emitting a
  `RunResolveResult`; assert an Entry + a new tab result.
- **Go / model**: Bubble Tea `Update` unit tests (teatest) for
  navigation, add, stop/restart optimistic states, quit-confirm gating,
  and lazy workspace creation.
- **Bun launcher**: unit-test the path-resolution ladder and the herdr
  probe (fake `herdrAvailable`); assert inherited-stdio exec and exit
  code passthrough.

## Follow-ups / open

- **"Add to runner" from `rt run`**: floated in brainstorming but does
  not fit the ephemeral, pane-owned model (there is no persistent board
  to target). Deferred; revisit only if boards ever gain a discoverable
  handle.
- **Rename / reorder rows**: intentionally omitted from V1 for
  minimalism.
- **Running outside a herdr client**: the runner only needs the herdr
  *socket* reachable, but `focus` assumes a herdr UI is attached
  somewhere. V1 assumes `rt runner` is run from within herdr (the normal
  case).
