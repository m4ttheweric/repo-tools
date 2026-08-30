# rt-ui bridge: design

rt's UI moves into a Go TUI layer. Brains stay in TypeScript. One bundled
helper binary, `rt-ui` (Bubble Tea v2 + Lip Gloss v2 + huh), renders every
interactive screen rt owns; the Bun process drives it over a small NDJSON
protocol. Go is to rt what the native layer is to an Electron or Tauri app.

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

## Non-goals

- **fzf does not move.** The ~60 fzf sites (`filterableSelect`,
  `runNavPicker`, the dispatcher's `showPicker`, `collectArgs`) stay exactly
  as they are. fzf is already Go, already bundled and signed, and it is the
  one rt UI Matt already likes. Folding it under `rt-ui` is an optional
  later phase, never a prerequisite.
- **Go is not the entrypoint.** Every `--json`, `RT_BATCH`, and agent
  invocation keeps running the Bun binary alone with no Go process anywhere.
- **No generic widget tree over the pipe.** That is Ink rebuilt in Go and
  moves the look back into TS. Full-screen views are named kinds with typed
  models; Go owns their layout.
- `rt status` is deleted, not ported. Matt never uses it.

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
termios. `rt-ui` opens `/dev/tty` for Bubble Tea's input and output
(`tea.WithInput` / `tea.WithOutput`), so stdio stays free for the protocol.
Pipe EOF is the liveness signal in both directions; there are no heartbeats.

The one gate is the one rt already codifies: **`rt-ui` is never spawned unless
`process.stdin.isTTY && !json && !process.env.RT_BATCH`.** Every
non-interactive path stays byte-identical after the migration, which is what
makes it safe to migrate one call site at a time.

## Three verbs

| verb | lifetime | direction | screen | used by |
|---|---|---|---|---|
| `rt-ui prompt` | one call | JSON spec in, JSON result out, exit code carries cancel | inline card in the flow | `select`, `multiselect`, `confirm`, `textInput` |
| `rt-ui steps` | while TS works | write-only stream of step events | inline lines | `withSpinner`, `createStepRunner` |
| `rt-ui session --view <kind>` | while a board is open | bidirectional: models down, intents up | alt-screen | `rt runner` (V1's only kind: `board`) |

A prompt is the fzf model generalized: stateless, one spawn per call,
~25 ms. Steps need a process that lives while TS does work (a git fetch, a
push), so they get a streaming verb. Sessions are the only stateful,
bidirectional case, and the only alt-screen one.

## Protocol

NDJSON, one object per line, UTF-8. Every object carries `t` (type). The
protocol version is `1`; it is negotiated once per spawn, never mid-stream.

### `prompt`

TS writes exactly one spec object to stdin and closes it. `rt-ui` renders,
writes exactly one result object to stdout, and exits.

```jsonc
// spec (stdin)
{ "t": "prompt", "protocol": 1, "kind": "select",
  "title": "Access duration", "hint": "enter: select  ctrl-up: back  esc: cancel",
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

Exit codes: `0` answered · `130` cancelled (Esc, Ctrl-C) · `131` back
(ctrl-up or the ↩ row) · `2` bad or unsupported spec (message on stderr) ·
`70` internal failure (message on stderr). Nothing else is ever written to
stdout or stderr.

`validate.pattern` is the only validation Go does; anything richer stays in
TS, which re-prompts with a `hint` carrying the message.

### `steps`

TS writes events for as long as the flow runs; `rt-ui` renders them in the
normal flow and owns only the active line's cursor. No stdout.

```jsonc
{ "t": "hello", "protocol": 1 }                              // first line, from TS
{ "t": "start", "id": "fetch", "title": "fetching origin…" }
{ "t": "done",  "id": "fetch", "title": "origin fetched", "hint": "3 new commits" }
{ "t": "fail",  "id": "rebase", "title": "rebase stopped", "hint": "conflict in lib/state/db.ts" }
{ "t": "log",   "level": "info" | "warn" | "error" | "success", "text": "resolve, then rt sync --continue" }
{ "t": "end" }
```

Exit `0` on `end`. Stdin EOF without `end` means the brain died: the active
step is finalized as `✗ interrupted`, the cursor is restored, exit `0`.
Ctrl-C reaches both processes (same process group); `rt-ui` finalizes and
exits `130`, TS already handles its own SIGINT.

### `session`

Long-lived and bidirectional. `rt-ui` speaks first so a stale helper fails
on line one.

```jsonc
// rt-ui → TS
{ "t": "hello", "protocol": 1, "version": "0.1.0", "views": ["board"] }
{ "t": "intent", "name": "stop", "entryId": "e3" }        // any user action
{ "t": "closed", "reason": "quit" | "cancel" | "error", "message"?: "…" }  // then exit

// TS → rt-ui
{ "t": "open",  "view": "board", "model": { … } }         // must follow hello
{ "t": "model", "model": { … } }                          // FULL replacement, never a diff
{ "t": "close" }                                          // rt-ui leaves the alt screen, exits 0
```

Rules that keep the seam honest:

- **Models are domain nouns.** Entries, states, exit codes, labels. If a
  message ever needs `style`, `width`, `color`, or `layout`, the design has
  leaked; that is a review finding.
- **Intents carry stable ids**, never row indices, so a model update racing
  a keypress cannot target the wrong row.
- **UI state stays in Go**: cursor, scroll, filter text, spinner frame, tail
  scroll, open/closed panels, the quit-confirm layer. It never crosses the
  pipe. The test: if TS needs it to *act*, it rides on the intent; otherwise
  Go keeps it.
- **Full model replace** on every `model` message. Models are kilobytes;
  diffing would buy nothing and cost a class of sync bugs.
- Each view kind's model and intent vocabulary is documented by the feature
  that owns it (the runner spec owns `board`).

Exit codes: `0` after `closed` · `130` cancel · `2` protocol mismatch or
unknown view · `70` internal.

## Rendering contract

- **Inline for prompts and steps, alt-screen for sessions.** Ratified from the
  canvas. Inline cards clear themselves fully on exit (the answered confirm
  collapses to one `✓ question  answer` line); nothing is left in scrollback
  but that line.
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
- Truecolor always; `rt-ui` sets the color profile explicitly rather than
  probing (Bubble Tea's init-time terminal query stalls headless ptys).
- Resize: reflow, nothing else.

## TS side

- **The facade does not change.** `select()`, `multiselect()`, `confirm()`,
  `textInput()`, `withSpinner()`, `createStepRunner()` keep their signatures
  and their `BackNavigation` semantics; only their implementation becomes a
  spawn. The ~45 call sites are untouched. `lib/rt-render.tsx` becomes
  `lib/ui/prompts.ts` + `lib/ui/steps.ts` with a re-export shim at the old
  path until the last importer moves.
- The `stderr: true` option (used to keep stdout clean for JSON, e.g.
  `rt run --resolve-only`) becomes a no-op: `/dev/tty` rendering makes it
  automatic. Removed once no caller passes it.
- New modules:
  - `lib/ui/resolve.ts`: finds the binary (below).
  - `lib/ui/protocol.ts`: the message types, shared by the fixture tests.
  - `lib/ui/spawn.ts`: `runPrompt(spec)`, `openSteps()`, `openSession(view,
    model)`; each returns typed results and maps exit codes:
    `130 → process.exit(130)` (today's Ctrl-C behavior), `131 → throw
    BackNavigation`, `2`/`70`/anything else → a plain one-line error naming
    the failure and the binary path, then `process.exit(1)`. Never a hung
    prompt, never a silent fallback to a different picker (the
    `FZF_MISSING_MESSAGE` policy).
- A session's `intent` stream is an async iterator; the owning command runs
  its loop, mutates its own state, and pushes a full model back.

## Go side

```
ui/
  go.mod                         module rt-ui, Go 1.26
  cmd/rt-ui/main.go              verb dispatch, /dev/tty open, exit codes
  internal/protocol/             types + NDJSON decoder/encoder
  internal/theme/                theme.go from the Tokens artboard; huh theme
  internal/prompt/               the four kinds on huh
  internal/steps/                streaming step renderer
  internal/session/              hello, open/model/close loop, intent emit
  internal/views/board/          the runner board (owned by the runner spec)
  internal/tty/                  raw mode, alt screen, restore on every path
  fixtures/                      protocol golden files (shared with TS tests)
```

Bubble Tea v2, Lip Gloss v2, bubbles v2, huh v1 (all stable as of
2026-08-29). One `tea.Program` per verb invocation. Sessions are one Elm
model whose `Update` receives protocol messages as `tea.Msg`s alongside key
and tick messages; that is the whole integration.

## Lifecycle and failure

- Go owns the terminal for the life of the spawn: raw mode on, alt screen
  for sessions, restore on `Quit`, on `close`, on panic (deferred), on
  SIGTERM/SIGHUP, and on stdin EOF. TS never touches termios.
- TS treats stdout EOF or a non-zero exit as "the UI died": it kills the
  child from its own `exit` hook if still alive, logs at `warn` through the
  existing CLI logging seam, and exits with a plain message. The one path
  that needs a deliberate test, not trust: **TS dies while Go holds the
  TTY** (Go must see stdin EOF and restore before exiting).
- Ctrl-C in raw mode is a key, not a signal: Go emits cancel and exits
  `130`; TS maps that onto today's behavior. Same process group, no
  `detached`, so a real SIGINT from a script kills both.
- Timeouts: none on prompts (a human is thinking). Steps and sessions end on
  `end`/`close` or EOF.

## Distribution: a first-party helper

`deps.lock` rows are downloaded third-party artifacts (url + sha256,
fetched by `scripts/fetch-deps.sh`, copied and signed by `rt-tray/build.sh`).
`rt-ui` is built from this repo, so it is a **first-party helper**, handled
like `rt` itself rather than like fzf:

- **Build** (`.github/workflows/release.yml`, beside the `bun build
  --compile` step): `cd ui && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build
  -trimpath -ldflags "-s -w -X main.version=$TAG" -o ../dist/rt-ui ./cmd/rt-ui`.
  `checks.yml` gains `go vet ./...` and `go test ./...` under `ui/`, plus the
  shared-fixture test on the TS side.
- **Bundle** (`build.sh`): copy `dist/rt-ui` to `Contents/Helpers/rt-ui` and
  append it to `HELPER_ENTITLEMENTS` (entitlement `none`) so the existing
  `sign_helper_tree` pass signs it with `com.mattstack.helper.rt-ui`.
  `check-bundle.sh` asserts presence and signature. It is not a `deps.lock`
  row; `rt deps` does not list it.
- **Gatekeeper** is the real risk: an unsigned Go binary is blocked exactly
  like the app was. The helper signing pass is the proven path; it is
  verified in the VM clean room per `docs/release-and-distribution.md`, not
  locally.
- **Resolution** (`lib/ui/resolve.ts`), in order: `RT_UI_BIN` env (tests,
  power users) → `appBundleRoot()/Contents/Helpers/rt-ui` (installed) →
  `<repo>/ui/dist/rt-ui` when running from a source checkout (dev mode) →
  `rt-ui` on PATH → a one-line error listing every path tried.
- **Version drift** is the failure class rt has been burned by three times
  (`packages/rt-client/dist/`): `hello` carries `protocol` and `version`,
  prompt specs carry `protocol`, and a mismatch is a loud exit `2` on the
  first line, never a silently wrong screen. `rt doctor`-style health can
  spawn `rt-ui --version` to report the pair.
- **Startup**: unaffected. `rt --version` and every non-interactive command
  never load `lib/ui/spawn.ts`; `scripts/bench-startup.ts` and
  `no-eager-tui.test.ts` keep gating, and both tighten once Ink is gone.

## Migration

| phase | what | leaves the tree |
|---|---|---|
| **0** | delete `commands/status/`, `lib/tui/`, their tree node + registry entry + tests; drop `@rezi-ui/*` | rt status, the rezi kit |
| **1** | `ui/` module with theme, `prompt`, `steps`; `lib/ui/*`; re-point the six facade functions; fake-rt-ui tests; release + checks wiring; then delete Ink | `ink`, `react`, `@inkjs/ui`, `lib/rt-render.tsx` |
| **2** | `session` verb + `board` view; `rt runner` as the first consumer (its own spec) | nothing |
| **3** (optional) | `rt-ui pick`: fzf spawned by Go instead of TS, so TS has one UI dependency | nothing; fzf stays the matcher |

Phases 0 and 1 ship together as one PR series; 2 follows on the runner
branch. Nothing in 1 blocks on 2.

## Testing

- **Shared fixtures** (`ui/fixtures/*.json`): one file per message shape.
  Go tests decode every file into its typed struct and re-encode it
  identically; TS tests (`lib/ui/__tests__/protocol.test.ts`) do the same
  with `lib/ui/protocol.ts`. Shared files, no shared code: that is how a
  two-language contract stays honest.
- **`fake-rt-ui`** (`lib/ui/__tests__/fake-rt-ui.ts`, the `fake-herdr.ts`
  pattern): a Bun script speaking the protocol with scripted answers,
  injected via `RT_UI_BIN`. Every command test that hits a prompt becomes
  deterministic and headless, which is a straight upgrade over testing Ink.
  It also asserts the exact spec each call site sends.
- **Go**: `teatest` golden output per prompt kind and per view state
  (matching the artboards), a headless-pty test for the steps verb, and the
  TS-dies-while-Go-holds-the-TTY test (close stdin, assert restore bytes
  and exit code).
- **Exit-code mapping**: unit tests on `lib/ui/spawn.ts` for 0/130/131/2/70
  against the fake.
- **Bench**: `bench.py` from the spike stays as a tool; the release job does
  not gate on it.

## Risks

1. **Terminal left broken after a crash.** Bubble Tea covers Go's own
   panics; the TS-dies path is tested deliberately (above).
2. **Model creep into presentation.** `SelectOption.color` already exists in
   the facade and is exactly where a widget tree starts. It is dropped in
   phase 1; the fzf sites that used it keep their own fzf coloring.
3. **Two-language drift.** Mitigated by the version handshake and the shared
   fixtures; a stale bundled helper fails loudly on its first line.
4. **Agents inside herdr panes are on TTYs.** They will hit `rt-ui` unless
   they set `RT_BATCH`, which is unchanged from today (they hit fzf), only
   more visible now that a prompt is a second process.
5. **Release complexity.** Go toolchain in two workflows and a second binary
   through the clean room. Accepted; the helper signing path is proven.
