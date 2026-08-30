# rt-ui bridge: design

rt's UI moves into a Go TUI layer. Brains stay in TypeScript. One bundled
helper binary, `rt-ui` (Bubble Tea v2 + Lip Gloss v2 + huh v2), renders
every interactive screen rt owns; the Bun process drives it over a small
NDJSON protocol. Go is to rt what the native layer is to an Electron or
Tauri app.

Decided 2026-08-29 after a three-way spike (`.local-dev/spikes/tui-shootout/`:
InkUI, Bubble Tea, ratatui; benched by `bench.py`). Approved screens:
https://claude.ai/code/artifact/a3c48e8f-03a9-4be5-be17-84a3988f39bb
(source `.local-dev/design/rt-ui/`; the **Tokens** artboard is the source
for `theme.go`).

## Goal

- Every rt screen that is not fzf renders through one Go binary with one
  theme, so rt's prompts, progress lines, and boards feel like herdr and
  cswap rather than like Ink.
- A hard seam between brains and UI: TS decides *what*; Go decides *how it
  looks*. Domain logic never enters Go; presentation never enters TS.
- Ink, React, `@inkjs/ui`, and `@rezi-ui/*` leave the bundle.
- **The process boundary is never perceptible.** Every design choice below
  is measured against one question: could a user tell there are two
  programs? Spawn cost hides under the user's own reaction time, terminal
  mode transitions happen once per screen, and nothing polls or repaints
  faster than the eye can register a seam.

## Non-goals

- **fzf does not move.** The ~60 fzf sites (`filterableSelect` and
  `filterableMultiselect` in `lib/fzf-select.ts`, `runNavPicker`, the
  dispatcher's `showPicker`, `collectArgs`) stay exactly as they are. fzf
  is already Go, already bundled and signed, and it is the one rt UI Matt
  already likes. Folding it under `rt-ui` is an optional later phase.
- **Go is not the entrypoint.** Every `--json`, `RT_BATCH`, and agent
  invocation keeps running the Bun binary alone with no Go process anywhere.
- **No generic widget tree over the pipe.** That is Ink rebuilt in Go and
  moves the look back into TS. Full-screen views are named kinds with typed
  models; Go owns their layout.
- `rt status` is deleted, not ported. Matt never uses it.

## Stack, pinned

| module | version | role |
|---|---|---|
| `charm.land/bubbletea/v2` | v2.0.9 | program loop |
| `charm.land/lipgloss/v2` | v2.0.6 | styling |
| `charm.land/bubbles/v2` | v2.2.1 | spinner, viewport, key |
| `charm.land/huh/v2` | v2.0.3 | the four prompt kinds |

(All verified resolvable on 2026-08-29. The v2 family lives under
`charm.land/…`; `github.com/charmbracelet/huh` v1 targets bubbletea v1 and
cannot link against this stack.)

**The spike measured v1.** Its numbers (22 ms first paint, 12 MB RSS, the
headless-pty startup stall and its `SetColorProfile` workaround) were taken
on bubbletea v1.3.10. v2 ships a new renderer and its own startup terminal
queries. Phase 1 does not close until `bench.py` has been re-run against
the real `rt-ui prompt` on this stack and the numbers are recorded in the
plan; the "hides under reaction time" argument below rests on a prompt
spawn-to-paint under ~40 ms and is re-checked there.

## Topology

```
rt (Bun, entrypoint, dispatcher, brains)
  │  spawns lazily, only on a TTY, only for interactive commands
  ▼
rt-ui (Go, Contents/Helpers/rt-ui)
  stdin/stdout  ← NDJSON protocol
  /dev/tty      ← every byte of UI (fzf's own model)
```

TS stays the parent and the entrypoint. It spawns `rt-ui` on demand, speaks
newline-delimited JSON over the child's stdin/stdout, and never touches
termios. `rt-ui` opens `/dev/tty` for Bubble Tea's input and output, so
stdio stays free for the protocol.

**Liveness is pipe EOF, in both directions, for every verb.** TS keeps the
child's stdin open for the child's whole life, even for a one-shot prompt
where the spec was written on line one; only TS's death closes it. Go
watches stdin for EOF on a goroutine, treats it as "the brain died",
restores the terminal, and exits. Go ignores `SIGPIPE` and treats any
stdout write error the same way (the Go runtime otherwise exits on a
`SIGPIPE` from fd 1 without running deferred restores, which is exactly the
broken-terminal outcome this exists to prevent). No heartbeats.

The one gate is the one rt already codifies: **`rt-ui` is never spawned unless
`process.stdin.isTTY && !json && !process.env.RT_BATCH`.** Every
non-interactive path stays byte-identical after the migration, which is what
makes it safe to migrate one call site at a time. A command that only makes
sense interactively (the runner) prints a one-line "requires an interactive
terminal" and exits 1 when that gate is closed.

## Three verbs

| verb | lifetime | direction | tty mode | screen | used by |
|---|---|---|---|---|---|
| `rt-ui prompt` | one call | JSON spec in, JSON result out, exit code carries cancel | raw, input + output | inline card | `select`, `multiselect`, `confirm`, `textInput` |
| `rt-ui steps` | one step | write-only stream of events | **cooked, write-only, reads nothing** | inline lines | `createStepRunner().run()`, `withSpinner` |
| `rt-ui session --view <kind>` | while a board is open | bidirectional: models down, intents up | raw, alt-screen | full screen | `rt runner` (V1's only kind: `board`) |

A prompt is the fzf model generalized: stateless, one spawn per call. A
step is one spawn per `run()` (the spinner lives exactly as long as the
work; nothing is alive between steps, so a prompt or an fzf picker between
steps never shares the tty with anything). A session is the only stateful,
bidirectional, alt-screen case.

## Protocol

NDJSON, one object per line, UTF-8. Every object carries `t` (type). The
protocol version is `1`; it is negotiated once per spawn, never mid-stream.
Messages from TS are processed strictly in order; Go never reorders.

### `prompt`

TS writes exactly one spec object to stdin (and keeps stdin open, above).
`rt-ui` renders, writes exactly one result object to stdout, restores the
terminal, and exits.

```jsonc
// spec (stdin)
{ "t": "prompt", "protocol": 1, "kind": "select",
  "title": "Access duration",
  "hint": "shown dim under the title: a description, or a validation message on re-prompt",
  "options": [ { "value": "1h", "label": "1 hour", "hint": "default" }, … ],
  "initial": "1h",
  "back": { "label": "back to resources" } }           // optional; adds the ↩ row

// kinds and their extra fields
// select      options, initial?, back?
// multiselect options, initial?: string[], min?, max?
// confirm     message, default?: true|false, destructive?: bool
// text        placeholder?, initial?, validate?: { "pattern": "^[a-z0-9-]+$", "message": "must be kebab-case" }

// result (stdout)
{ "t": "result", "value": "1h" }          // select
{ "t": "result", "values": ["a","b"] }    // multiselect
{ "t": "result", "ok": true }             // confirm
{ "t": "result", "text": "linear-tools" } // text
```

`hint` is **domain text only** (a description, or the validation message a
re-prompt carries). The keybind header (`enter: select  ctrl-up: back  esc:
cancel`) is composed by Go from `kind` and the presence of `back`; TS never
authors key text. Options carry `value`, `label`, `hint`; there is no color
field on the wire (fzf sites keep their own coloring in `fzf-select.ts`).

Exit codes: `0` answered · `130` cancelled (Esc, Ctrl-C) · `131` back
(ctrl-up or the ↩ row) · `2` bad or unsupported spec (message on stderr) ·
`70` internal failure (message on stderr). Nothing else is ever written to
stdout or stderr.

`validate.pattern` is the only validation Go does; anything richer stays in
TS, which re-prompts with a `hint` carrying the message.

### `steps`

One spawn per step. TS writes the event stream for that step; `rt-ui`
renders it in the normal flow, owns only the active line, and exits when
the step resolves. No stdout.

```jsonc
{ "t": "hello", "protocol": 1 }                                       // first line, from TS
{ "t": "start", "title": "fetching origin…" }
{ "t": "log",   "level": "info" | "warn" | "error" | "success", "text": "…" }  // printed above the spinner line
{ "t": "done",  "title": "origin fetched", "hint": "3 new commits" }  // or
{ "t": "fail",  "title": "rebase stopped", "hint": "conflict in lib/state/db.ts" }
```

- `/dev/tty` is opened **write-only**; steps never enter raw mode and read
  no input. Ctrl-C therefore stays a signal to the whole process group: TS
  runs its existing SIGINT path, Go finalizes the line as `✗ interrupted`
  and exits `130`. TS treats that `130` as "already handled" and continues
  its own SIGINT handling.
- Exit `0` after `done`/`fail`. Stdin EOF before either means the brain
  died: finalize as `✗ interrupted`, restore the cursor, exit `0`.
- If the pipe write fails mid-step (the child died), TS logs at `warn`
  through the CLI logging seam, finishes the task, and prints the final
  line itself in plain text. Never a hang, never a lost result.
- `log()` between steps (no step active) is a plain TS line using the
  existing `lib/tui.ts` colors, unchanged from today. Static lines are the
  one presentation TS keeps; there is no spawn per log line.
- **While a step is active, TS must not write to stdout or stderr.** Ink's
  `patchConsole` hid this today; Go on `/dev/tty` will not. Phase 1 greps
  every `createStepRunner`/`withSpinner` caller for writes inside a task
  and moves them to `log()`.

### `session`

Long-lived and bidirectional. `rt-ui` speaks first so a stale helper fails
on line one. Go enters the alt screen on `open`, not on spawn, so there is
never a blank alt screen waiting for a model.

```jsonc
// rt-ui → TS
{ "t": "hello", "protocol": 1, "version": "0.1.0", "views": ["board"] }
{ "t": "intent", "name": "stop", "entryId": "e3" }        // any user action
{ "t": "closed", "reason": "quit" | "cancel" | "closed" | "error", "message"?: "…" }  // always the last line

// TS → rt-ui
{ "t": "open",  "view": "board", "model": { … } }         // must follow hello
{ "t": "model", "model": { … } }                          // FULL replacement, never a diff
{ "t": "close" }                                          // Go replies closed{reason:"closed"}, restores, exits 0
```

| how the session ends | Go sends | Go exits | TS does |
|---|---|---|---|
| user chose quit in the view (the board's `y`) | `closed{quit}` | 0 | runs the view's teardown, continues |
| user cancelled a view that has no confirm layer (Ctrl-C/Esc where the view defines that as cancel) | `closed{cancel}` | 130 | same as quit for the board; other views define their own meaning |
| TS sent `close` | `closed{closed}` | 0 | **awaits child exit** before touching the tty again |
| protocol mismatch / unknown view | `closed{error}` | 2 | plain message, exit 1 |
| Go internal failure | `closed{error}` if it can | 70 | plain message, exit 1 |
| exit without a `closed` line | (none) | any | "the UI died": teardown, plain message, exit 1 |

Intents Go emits after TS has sent `close` are dropped by TS. A `model`
TS sends after `closed` is ignored by the dying child; TS stops pushing
the moment it sends `close` or reads `closed`.

Rules that keep the seam honest:

- **Models are domain nouns.** Entries, states, timestamps, labels. If a
  message ever needs `style`, `width`, `color`, or `layout`, the design has
  leaked; that is a review finding.
- **Intents carry stable ids**, never row indices, so a model update racing
  a keypress cannot target the wrong row. Ordering is otherwise simple:
  TS applies intents in arrival order, and every push is the full current
  truth, so a push that crosses an intent in flight is corrected by the
  next push.
- **UI state stays in Go**: cursor, scroll, filter text, spinner frame,
  open/closed panels, the quit-confirm layer, and any per-second display
  derivation (an uptime column derives from a pushed `startedAt` on Go's
  own 1 s tick; TS never pushes a counter that would skip seconds under a
  slower poll). The test: if TS needs it to *act*, it rides on the intent;
  otherwise Go keeps it.
- **Full model replace** on every `model` message. Models are kilobytes;
  diffing would buy nothing and cost a class of sync bugs.
- Each view kind's model and intent vocabulary is documented by the feature
  that owns it (the runner spec owns `board`).

## Rendering contract

- **Inline for prompts and steps, alt-screen for sessions.** Ratified from the
  canvas. Inline cards clear themselves fully on exit (the answered confirm
  collapses to one `✓ question  answer` line); nothing is left in
  scrollback but that line. The spike got this collapse from a v1 renderer
  quirk (an empty `View()` rewritten to a space); on v2 it is pinned by a
  `teatest` byte assertion, not assumed.
- **Theme = the Tokens artboard**, byte for byte, in `theme.go`: the plum
  palette from `lib/tui/palette.ts`, the glyph vocabulary
  (`● ○ ✗ ▌ ❯ ◉ ✓ ⚠ ↩`, braille spinner at 80 ms), and the family rules:
  pink rounded card with a dim keybind header = a prompt waiting for input
  (matches rt's fzf pickers); confirm = two lines, no box, peach chevron and
  default-no when `destructive`; muted `#34304E` border = passive panel;
  peach border = destructive confirm layer.
- huh renders the four prompt kinds under a custom huh theme; anything huh
  cannot express (the ↩ back row, the right-aligned title hint) is drawn
  around it, not by forking huh.
- Truecolor always; `rt-ui` fixes the color profile explicitly rather than
  probing the terminal (a probe that waits for an answer is a startup stall
  on any pty nobody answers; how v2 exposes this is confirmed in phase 1).
- Resize: reflow, nothing else.

## TS side

- **The facade does not change.** `select()`, `multiselect()`, `confirm()`,
  `textInput()`, `withSpinner()`, `createStepRunner()` keep their signatures
  and their `BackNavigation` semantics; only their implementation becomes a
  spawn. The ~45 call sites are untouched. As of main `b63d260f`,
  `lib/rt-render.tsx` already holds only these Ink primitives plus
  back-compat re-exports of `fzf-select.ts`; it becomes `lib/ui/prompts.ts`
  + `lib/ui/steps.ts`, with `lib/rt-render.tsx` left as a re-export shim
  until the last importer moves.
- Two deliberate, small behavior changes, both documented at the call
  sites: **Esc cancels every prompt kind** (today `@inkjs/ui` ignores Esc;
  after this, Esc behaves exactly like Ctrl-C and like fzf's `esc: cancel`),
  and `confirm()` gains an optional `{ destructive?: boolean }` so the
  default-no, peach variant is reachable.
- The `stderr: true` option (used to keep stdout clean for JSON, e.g.
  `rt run --resolve-only`) becomes a no-op: `/dev/tty` rendering makes it
  automatic. Removed once no caller passes it.
- New modules:
  - `lib/ui/resolve.ts`: finds the binary (below).
  - `lib/ui/protocol.ts`: the message types, shared by the fixture tests.
  - `lib/ui/spawn.ts`: `runPrompt(spec)`, `runStep(events)`,
    `openSession(view, model)`; each keeps stdin open until exit, returns
    typed results, and maps exit codes: `130 → process.exit(130)` (today's
    Ctrl-C behavior), `131 → throw BackNavigation`, `2`/`70`/anything else
    → a plain one-line error naming the failure and the binary path, then
    `process.exit(1)`. Never a hung prompt, never a silent fallback to a
    different picker (the `FZF_MISSING_MESSAGE` policy).
  - TS's `exit` hook (already installed by `installCliLogging`) kills any
    live `rt-ui` child so a `process.exit()` mid-prompt cannot orphan one.
- A session's `intent` stream is an async iterator; the owning command runs
  its loop, mutates its own state, and pushes a full model back.

## Go side

```
ui/
  go.mod                         module rt-ui, Go 1.26, charm.land/*/v2
  cmd/rt-ui/main.go              verb dispatch, /dev/tty open, exit codes, SIGPIPE ignore
  internal/protocol/             types + NDJSON decoder/encoder
  internal/theme/                theme.go from the Tokens artboard; huh theme
  internal/prompt/               the four kinds on huh
  internal/steps/                one-step renderer (write-only tty)
  internal/session/              hello, open/model/close loop, intent emit
  internal/views/board/          the runner board (owned by the runner spec)
  internal/tty/                  raw mode, alt screen, restore on every path
  fixtures/                      protocol golden files (shared with TS tests)
  dist/rt-ui                     local build output (gitignored)
```

One `tea.Program` per verb invocation. Sessions are one Elm model whose
`Update` receives protocol messages as `tea.Msg`s alongside key and tick
messages; that is the whole integration.

## Lifecycle and failure

- Go owns the terminal for the life of the spawn (prompt and session:
  raw mode; steps: cooked, write-only). It restores on `Quit`, on `close`,
  on panic (deferred), on SIGINT/SIGTERM/SIGHUP, on stdin EOF, and on any
  stdout write error. TS never touches termios.
- TS treats stdout EOF or an unexpected exit as "the UI died": it kills the
  child if still alive, logs at `warn` through the existing CLI logging
  seam, and exits with a plain message. **The TS-dies-while-Go-holds-the-TTY
  path is a deliberate test**, not trust: close the child's stdin, assert
  the restore bytes reach the tty and the exit code is what the table says.
- In raw mode (prompt, session) Ctrl-C is a key, not a signal: Go emits
  cancel and exits `130`; TS maps that onto today's behavior. In cooked
  mode (steps) Ctrl-C is a signal to both. Same process group, no
  `detached`, so a scripted `kill -INT` to the group ends both.
- Timeouts: none on prompts (a human is thinking). Steps and sessions end on
  `done`/`fail`/`close` or EOF.

## Distribution: a first-party helper

`deps.lock` rows are downloaded third-party artifacts (url + sha256,
fetched by `scripts/fetch-deps.sh`, copied and signed by `rt-tray/build.sh`).
`rt-ui` is built from this repo, so it is a **first-party helper**, handled
like `rt` itself rather than like fzf:

- **One build command everywhere**: `bun run ui:build` (package.json script:
  `cd ui && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X
  main.version=$RT_VERSION" -o dist/rt-ui ./cmd/rt-ui`), output
  `ui/dist/rt-ui`. Developers, `build.sh dev|install`, and
  `.github/workflows/release.yml` (beside the `bun build --compile` step,
  `GOOS=darwin GOARCH=arm64`) all run that one script. `checks.yml` gains
  `go vet ./...` and `go test ./...` under `ui/`, plus the shared-fixture
  test on the TS side.
- **Bundle** (`build.sh`): copy `ui/dist/rt-ui` to `Contents/Helpers/rt-ui`
  and append it to `HELPER_ENTITLEMENTS` (entitlement `none`) so the
  existing `sign_helper_tree` pass signs it with `com.mattstack.helper.rt-ui`.
  `check-bundle.sh` asserts presence and signature. It is not a `deps.lock`
  row; `rt deps` does not list it.
- **Gatekeeper** is the real risk: an unsigned Go binary is blocked exactly
  like the app was. The helper signing pass is the proven path; it is
  verified in the VM clean room per `docs/release-and-distribution.md`, not
  locally.
- **Resolution** (`lib/ui/resolve.ts`), in order:
  1. `RT_UI_BIN` (an executable path; tests and power users).
  2. **Running from a source checkout** (`bundleRootFromExec()` is null,
     which is every `bun run cli.ts` and the dev-mode shim):
     `<repo>/ui/dist/rt-ui`, else a one-line "run `bun run ui:build`".
     Source must win here: in dev mode `appBundleRoot()` resolves to the
     blessed `mattstack-dev.app`, which is never rebuilt, so a bundle-first
     order would pin every source run to a permanently stale helper.
  3. Running from a bundle: `<bundle>/Contents/Helpers/rt-ui`.
  4. `rt-ui` on PATH.
  5. A one-line error listing every path tried.
- **Version drift** is the failure class rt has been burned by three times
  (`packages/rt-client/dist/`): `hello` carries `protocol` and `version`,
  prompt specs carry `protocol`, and a mismatch is a loud exit `2` on the
  first line, never a silently wrong screen.
- **Startup**: unaffected. `rt --version` and every non-interactive command
  never load `lib/ui/spawn.ts`; `scripts/bench-startup.ts` and
  `no-eager-tui.test.ts` keep gating (the banned-import set gains
  `lib/ui/spawn.ts`), and both tighten once Ink is gone.

## Performance budget, per screen

| moment | budget | how it is met |
|---|---|---|
| prompt appears after a command decides to ask | < 40 ms spawn-to-paint | one exec, no handshake round-trip (spec rides on line one), no terminal probe; re-benched on v2 in phase 1 |
| between two prompts in a wizard | one card clears, the next paints | each is its own spawn; the clear is the exiting card's own erase, the paint is the next spawn; no shared state, no flicker source in between |
| step spinner | starts before the work does | spawned first, then the task runs; the spinner is on screen within the same budget as a prompt |
| session open | first paint on `open` | alt screen entered at `open` with the model already in hand: one paint, no blank frame |
| session update | one repaint per push, never per poll tick | TS pushes only when the model changed; per-second display (uptime) is Go-local |
| session close → next tty user | no overlap | TS awaits child exit after `close` before spawning fzf or anything else |

## Migration

| phase | what | leaves the tree |
|---|---|---|
| **0** | delete `commands/status/`, its tree node, registry entry, and tests; delete the Ink/rezi parts of `lib/tui/` (`atoms/`, `molecules/`, `hooks/`, `theme.ts`, `index.ts`) and drop `@rezi-ui/*`. **Keep** `lib/tui/palette.ts` (fzf colors, and the theme source), `lib/tui/inline-spinner.ts`, `lib/tui/utils/label.ts`: they have live importers | rt status, the rezi kit |
| **1** | `ui/` module with theme, `prompt`, `steps`; `lib/ui/*`; re-point the six facade functions; the step-caller grep; fake-rt-ui tests; release + checks wiring; v2 bench recorded; then delete Ink | `ink`, `react`, `@inkjs/ui`, the Ink half of `lib/rt-render.tsx` |
| **2** | `session` verb + `board` view; `rt runner` as the first consumer (its own spec) | nothing |
| **3** (optional) | `rt-ui pick`: fzf spawned by Go instead of TS, so TS has one UI dependency | nothing; fzf stays the matcher |

Phases 0 and 1 ship together as one PR series; 2 follows. Nothing in 1
blocks on 2.

## Testing

- **Shared fixtures** (`ui/fixtures/*.json`): one file per message shape.
  Go tests decode every file into its typed struct and re-encode it
  identically; TS tests (`lib/ui/__tests__/protocol.test.ts`) do the same
  with `lib/ui/protocol.ts`. Shared files, no shared code: that is how a
  two-language contract stays honest.
- **`fake-rt-ui`** (`lib/ui/__tests__/fake-rt-ui.ts`, the `fake-herdr.ts`
  pattern): a Bun script with a `#!/usr/bin/env bun` shebang and the exec
  bit, speaking the protocol with scripted answers, injected via
  `RT_UI_BIN`. Every command test that hits a prompt becomes deterministic
  and headless. It also asserts the exact spec each call site sends.
- **Go**: `teatest` golden output per prompt kind and per view state
  (matching the artboards, including the collapse-to-one-line bytes), a
  headless-pty test for the steps verb, and the TS-dies-while-Go-holds-the-
  TTY test (close stdin, assert restore bytes and exit code).
- **Exit-code mapping**: unit tests on `lib/ui/spawn.ts` for 0/130/131/2/70
  against the fake, and the table above for sessions.
- **Bench**: `bench.py` from the spike, pointed at the real `rt-ui`, is
  re-run in phase 1 and its numbers recorded in the plan. The release job
  does not gate on it.

## Risks

1. **Terminal left broken after a crash.** Bubble Tea covers Go's own
   panics; the SIGPIPE rule and the TS-dies test cover the other side.
2. **Model creep into presentation.** The wire has no color field by
   design; `SelectOption.color` stays an fzf-side concern in
   `fzf-select.ts`. Review rule: model fields are domain nouns.
3. **Two-language drift.** Mitigated by the version handshake and the shared
   fixtures; a stale bundled helper fails loudly on its first line.
4. **v2 is unmeasured until phase 1.** The bench re-run is a phase gate,
   not a nice-to-have.
5. **Agents inside herdr panes are on TTYs.** They will hit `rt-ui` unless
   they set `RT_BATCH`, which is unchanged from today (they hit fzf), only
   more visible now that a prompt is a second process.
6. **Release complexity.** Go toolchain in two workflows and a second binary
   through the clean room. Accepted; the helper signing path is proven.
