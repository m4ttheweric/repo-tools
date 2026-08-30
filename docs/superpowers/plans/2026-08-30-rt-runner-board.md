# rt runner (phase 2: session verb + board) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `rt runner`: a full-screen board that launches long-running commands as headless herdr panes, rendered by a new `rt-ui session --view board` verb and driven by a TypeScript command that owns every entry and every herdr call.

**Architecture:** Go gets a third verb, `session`: it speaks a `hello` line first, receives `open`/`model`/`close` lines (full model replacement, never diffs), paints an alt-screen view, and emits `intent` lines for user actions; the `board` view is the first and only kind. TS gets `openSession()` in the spawn layer, an in-process `resolveRun()` extracted from `rt run`, a herdr socket engine (`lib/runner/engine.ts`), pure state derivation (`lib/runner/state.ts`), and the command loop (`lib/runner/runner.ts` + `commands/runner.ts`). The board is ephemeral and pane-owned: quitting it closes the whole herdr workspace it created.

**Tech Stack:** Bun 1.3.13 + TypeScript; Go 1.26 with `charm.land/bubbletea/v2` v2.0.9, `charm.land/lipgloss/v2` v2.0.6, `charm.land/bubbles/v2` v2.2.1 (spinner); herdr socket API protocol 19 over `lib/herdr/client.ts`; `github.com/creack/pty` + `github.com/charmbracelet/x/vt` (tests, already pinned).

**Spec:** `docs/superpowers/specs/2026-08-29-rt-runner-design.md` (this plan), which reads with `docs/superpowers/specs/2026-08-29-rt-ui-bridge-design.md` (the `session` verb's protocol, exit table, and rendering contract). Approved screens: https://claude.ai/code/artifact/a3c48e8f-03a9-4be5-be17-84a3988f39bb (Runner board page).

## Global Constraints

- Protocol version `1`. Session wire (NDJSON, one object per line): Go → TS `{"t":"hello","protocol":1,"version":"<v>","views":["board"]}` first, then `{"t":"intent","name":...,"entryId"?:...,"open"?:bool}` and finally `{"t":"closed","reason":"quit"|"cancel"|"closed"|"error","message"?:...}`; TS → Go `{"t":"open","view":"board","model":{...}}` (must follow hello), `{"t":"model","model":{...}}` (FULL replacement), `{"t":"close"}`.
- Session exit table: user chose quit in the view (`y`) → `closed{quit}`, exit `0`; TS sent `close` → `closed{closed}`, exit `0`; external SIGINT/SIGTERM/SIGHUP → `closed{cancel}`, exit `130`; bad/absent `open` or unknown view → `closed{error}`, exit `2`; stdin EOF (parent died) → `closed{error}`, exit `70`; any exit without a `closed` line is "the UI died". The board never emits `closed{cancel}` from a key (Ctrl-C is `q`).
- Models are domain nouns (entries, states, timestamps, labels); no `style`/`width`/`color`/`layout` on the wire. Intents carry stable entry ids, never row indices. UI state (cursor, tail panel open/closed, spinner frame, quit-confirm layer, uptime display) lives in Go and never crosses the pipe. Go enters the alt screen on `open`, not on spawn.
- `board` model: `{ workspace: string, entries: [{ id, name, command, pkg, repo, state: "running"|"stopped"|"crashed"|"starting"|"stopping", startedAt: ISO string|null, exitCode: number|null, error: string|null, tail: null | [{ ts, text }] }] }`; `tail` is non-null for exactly one entry (the selected one while the peek is open, whatever its state).
- Board keys: `j`/`k`/↑/↓ move (Go-local); `t` toggles the tail peek and emits `tail` `{entryId, open}` (also on selection change while open); `a` emits `add`; `s` `restart`; `x` `stop`; `f` `focus`; `q`/Ctrl-C show the y/n layer when any entry is running (else quit at once); `y` emits `quit` then quits; `n`/Esc dismisses. Uptime `m:ss` derives from `startedAt` on Go's own 1 s tick.
- Every command is launched wrapped: `cd <shellQuote(cwd)> && <cmd>; printf '\n__rt_exit %s\n' $?`; running iff `process_info.foreground_process_group_id != shell_pid` (both non-null); stopped when the last `__rt_exit N` line reads `0` or `130`, crashed otherwise; the sentinel line and a trailing shell-prompt line are filtered from pushed tails.
- herdr socket methods and shapes (verified against `herdr api schema --json`, protocol 19): `workspace.create {label, focus:false}` → `{type:"workspace_created", workspace:{workspace_id}, tab:{tab_id}, root_pane:{pane_id, tab_id}}`; `tab.create {workspace_id, label, focus:false}` → `{type:"tab_created", tab:{tab_id}, root_pane:{pane_id, tab_id}}`; `pane.list {workspace_id}` → `{panes:[{pane_id, tab_id}]}` (the fallback when a reply carries no `root_pane`); `tab.rename {tab_id, label}`; `tab.focus {tab_id}`; `pane.send_text {pane_id, text}`; `pane.send_keys {pane_id, keys:["enter"]}` / `["ctrl+c"]`; `pane.process_info {pane_id}` → `{process_info:{foreground_process_group_id, shell_pid, foreground_processes:[{pid,name,argv,cmdline}]}}`; `pane.read {pane_id, source:"recent_unwrapped", lines, strip_ansi:true, format:"text"}` → `{read:{text, truncated}}`; `workspace.close {workspace_id}`.
- `rt runner` runs only when `interactive()` (`lib/ui/gate.ts`) is true and `herdrAvailable()` (`lib/herdr/client.ts`) answers; otherwise one plain line and exit 1. The command never calls the daemon and never re-implements herdr logic outside `lib/runner/engine.ts`.
- Never use em dashes or en dashes anywhere. Never write the phrase "load bearing". Comments state constraints the code cannot show; never narrate the next line, never cite review findings or task numbers. Commit after every task with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Gates: `bunx tsc --noEmit`, `bun test lib commands packages scripts` (foreground, 10-minute timeout), `bun run docs:check`, `bun run picker:check`, `cd ui && go vet ./... && go test ./... -count=1`. Never run a compiled `dist/rt` outside `scripts/bench-startup.ts`; never touch `/Applications`; never restart the daemon; never run against the developer's live herdr from a test (tests use `lib/herdr/__tests__/fake-herdr.ts` and in-memory fakes).
- When a Charm symbol in this plan does not match the pinned module, `go doc charm.land/<module>/v2 <Symbol>` is the reference and the tests are the contract.

---

## File structure

**Go (`ui/`)**

| file | responsibility |
|---|---|
| `ui/internal/protocol/session.go` | Session wire types + decoders (`Hello`, `Open`, `Model`, `Close`, `Intent`, `Closed`); `DecodeSessionLine`. |
| `ui/fixtures/session-*.json` | Golden fixtures for every session message shape (shared with TS). |
| `ui/internal/session/session.go` | The verb's loop: hello, wait for `open`, run a `View` in an alt-screen `tea.Program`, feed `model`/`close`/EOF as messages, emit intents, write `closed`, map reasons to exit codes. |
| `ui/internal/views/board/model.go` | The `board` model types decoded from the wire. |
| `ui/internal/views/board/board.go` | The Bubble Tea model: rows, tail peek, quit layer, keys, intents, uptime tick, spinner. |
| `ui/internal/views/board/render.go` | Pure rendering of the board from model + UI state (lipgloss). |
| `ui/internal/testutil/session.go` | `StartSession`: bidirectional pty harness (write lines to stdin, read intent lines from stdout, type keys, capture tty, wait). |
| `ui/cmd/rt-ui/verbs.go`, `main.go` | `runSession()` + `session` dispatch. |

**TypeScript**

| file | responsibility |
|---|---|
| `lib/ui/protocol.ts` | Adds session types (`SessionHello`, `SessionIntent`, `SessionClosed`, `BoardModel`, `BoardEntry`) + `parseSessionLine`. |
| `lib/ui/spawn.ts` | Adds `openSession(view, model): Promise<SessionHandle>`. |
| `lib/ui/__tests__/fake-rt-ui.ts` | Adds a `session` mode (scripted intents, records models). |
| `commands/run.ts` | Extracts `resolveRun(args, ctx)`; picker cancellations throw `RunAborted` instead of `process.exit`. |
| `lib/runner/engine.ts` | `Engine` interface + `HerdrEngine` over `herdrRequest`. |
| `lib/runner/state.ts` | `Entry`, `deriveState`, `parseExitSentinel`, `filterTail`, `toModel`, `wrapCommand`. |
| `lib/runner/runner.ts` | `Runner` class: intents loop, polls, add flow, restart wait, teardown; every dependency injected. |
| `commands/runner.ts` | `runnerCommand`: gate, herdr probe, signal wiring, `new Runner(...)`. |
| `lib/command-tree-def.ts`, `lib/module-registry.ts`, `CLAUDE.md`, `website/docs/reference/` | Wiring + regenerated reference. |

---

### Task 1: Session wire types, fixtures, and both decoders

**Files:**
- Create: `ui/fixtures/session-hello.json`, `session-open-board.json`, `session-model-board.json`, `session-close.json`, `session-intent-stop.json`, `session-intent-tail.json`, `session-closed-quit.json`
- Create: `ui/internal/protocol/session.go`, `ui/internal/protocol/session_test.go`
- Modify: `lib/ui/protocol.ts`, `lib/ui/__tests__/protocol.test.ts`

**Interfaces:**
- Produces (Go): `type Hello{T,Protocol,Version string,Views []string}`, `type Open{T,View string,Model json.RawMessage}`, `type ModelMsg{T string,Model json.RawMessage}`, `type Intent{T,Name,EntryID string; Open *bool}`, `type Closed{T,Reason,Message string}`; `func DecodeSessionLine(b []byte) (kind string, raw []byte, err error)` where kind is the `t` value; `func EncodeIntent(Intent) []byte`, `func EncodeClosed(Closed) []byte`, `func EncodeHello(version string, views []string) []byte`.
- Produces (TS): `BoardEntry`, `BoardModel`, `SessionHello`, `SessionIntent`, `SessionClosed`, `SessionInbound = SessionHello | SessionIntent | SessionClosed`, `parseSessionLine(line): SessionInbound` (throws on junk with a message containing `rt-ui session`).

- [ ] **Step 1: Write the fixtures**

`ui/fixtures/session-hello.json`: `{ "t": "hello", "protocol": 1, "version": "0.1.0", "views": ["board"] }`

`ui/fixtures/session-open-board.json`:
```json
{ "t": "open", "view": "board", "model": { "workspace": "rt-runner-a3f9", "entries": [] } }
```

`ui/fixtures/session-model-board.json`:
```json
{ "t": "model", "model": { "workspace": "rt-runner-a3f9", "entries": [
  { "id": "e1", "name": "dev", "command": "bun run dev", "pkg": "web", "repo": "assured-dev",
    "state": "running", "startedAt": "2026-08-29T22:38:26.000Z", "exitCode": null, "error": null,
    "tail": [ { "ts": "22:41:07", "text": "VITE v5.4.2  ready in 412 ms" } ] },
  { "id": "e2", "name": "worker", "command": "bun run worker", "pkg": "backend", "repo": "assured-dev",
    "state": "crashed", "startedAt": "2026-08-29T22:38:40.000Z", "exitCode": 1, "error": null, "tail": null }
] } }
```

`ui/fixtures/session-close.json`: `{ "t": "close" }`
`ui/fixtures/session-intent-stop.json`: `{ "t": "intent", "name": "stop", "entryId": "e1" }`
`ui/fixtures/session-intent-tail.json`: `{ "t": "intent", "name": "tail", "entryId": "e1", "open": true }`
`ui/fixtures/session-closed-quit.json`: `{ "t": "closed", "reason": "quit" }`

- [ ] **Step 2: Write the failing Go test**

`ui/internal/protocol/session_test.go`:

```go
package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func sessionFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestDecodeSessionLineKinds(t *testing.T) {
	cases := map[string]string{
		"session-open-board.json":  "open",
		"session-model-board.json": "model",
		"session-close.json":       "close",
	}
	for name, want := range cases {
		kind, raw, err := DecodeSessionLine(sessionFixture(t, name))
		if err != nil || kind != want || len(raw) == 0 {
			t.Fatalf("%s: kind=%q err=%v", name, kind, err)
		}
	}
	if _, _, err := DecodeSessionLine([]byte(`{"nope":1}`)); err == nil {
		t.Fatal("line without t accepted")
	}
}

func TestOpenAndModelDecodeToRawModel(t *testing.T) {
	var o Open
	if err := json.Unmarshal(sessionFixture(t, "session-open-board.json"), &o); err != nil || o.View != "board" || len(o.Model) == 0 {
		t.Fatalf("open: %+v err=%v", o, err)
	}
	var m ModelMsg
	if err := json.Unmarshal(sessionFixture(t, "session-model-board.json"), &m); err != nil || len(m.Model) == 0 {
		t.Fatalf("model: err=%v", err)
	}
}

func TestEncodersMatchFixtures(t *testing.T) {
	canon := func(b []byte) string {
		var v any
		if err := json.Unmarshal(b, &v); err != nil {
			t.Fatal(err)
		}
		out, _ := json.Marshal(v)
		return string(out)
	}
	if got := EncodeHello("0.1.0", []string{"board"}); canon(got) != canon(sessionFixture(t, "session-hello.json")) {
		t.Fatalf("hello: %s", got)
	}
	if got := EncodeIntent(Intent{Name: "stop", EntryID: "e1"}); canon(got) != canon(sessionFixture(t, "session-intent-stop.json")) {
		t.Fatalf("intent stop: %s", got)
	}
	open := true
	if got := EncodeIntent(Intent{Name: "tail", EntryID: "e1", Open: &open}); canon(got) != canon(sessionFixture(t, "session-intent-tail.json")) {
		t.Fatalf("intent tail: %s", got)
	}
	if got := EncodeClosed(Closed{Reason: "quit"}); canon(got) != canon(sessionFixture(t, "session-closed-quit.json")) {
		t.Fatalf("closed: %s", got)
	}
	for _, b := range [][]byte{EncodeHello("x", nil), EncodeIntent(Intent{Name: "add"}), EncodeClosed(Closed{Reason: "closed"})} {
		if b[len(b)-1] != '\n' {
			t.Fatalf("encoder output must end with a newline: %q", b)
		}
	}
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ui && go test ./internal/protocol/`
Expected: FAIL to compile (undefined `DecodeSessionLine`, `Open`, ...).

- [ ] **Step 4: Write `ui/internal/protocol/session.go`**

```go
package protocol

import (
	"encoding/json"
	"fmt"
)

// Session messages. The wire is one JSON object per line; the view's model
// travels as raw JSON so this package never learns a view's shape.

type Hello struct {
	T        string   `json:"t"`
	Protocol int      `json:"protocol"`
	Version  string   `json:"version"`
	Views    []string `json:"views"`
}

type Open struct {
	T     string          `json:"t"`
	View  string          `json:"view"`
	Model json.RawMessage `json:"model"`
}

type ModelMsg struct {
	T     string          `json:"t"`
	Model json.RawMessage `json:"model"`
}

type Intent struct {
	T       string `json:"t"`
	Name    string `json:"name"`
	EntryID string `json:"entryId,omitempty"`
	Open    *bool  `json:"open,omitempty"`
}

type Closed struct {
	T       string `json:"t"`
	Reason  string `json:"reason"`
	Message string `json:"message,omitempty"`
}

// DecodeSessionLine returns the message kind (its "t") and the raw line for
// a second, typed decode by the caller.
func DecodeSessionLine(line []byte) (string, []byte, error) {
	var probe struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		return "", nil, fmt.Errorf("%w: %v", ErrBadSpec, err)
	}
	if probe.T == "" {
		return "", nil, fmt.Errorf("%w: session line without t", ErrBadSpec)
	}
	return probe.T, line, nil
}

func EncodeHello(version string, views []string) []byte {
	if views == nil {
		views = []string{}
	}
	b, _ := json.Marshal(Hello{T: "hello", Protocol: Version, Version: version, Views: views})
	return append(b, '\n')
}

func EncodeIntent(in Intent) []byte {
	in.T = "intent"
	b, _ := json.Marshal(in)
	return append(b, '\n')
}

func EncodeClosed(c Closed) []byte {
	c.T = "closed"
	b, _ := json.Marshal(c)
	return append(b, '\n')
}
```

- [ ] **Step 5: Run the Go tests**

Run: `cd ui && go test ./internal/protocol/`
Expected: PASS.

- [ ] **Step 6: Add the TS types and their fixture test**

Append to `lib/ui/protocol.ts`:

```ts
// ─── session ─────────────────────────────────────────────────────────────────

export type BoardState = "running" | "stopped" | "crashed" | "starting" | "stopping";

export interface BoardTailLine {
  ts: string;
  text: string;
}

export interface BoardEntry {
  id: string;
  name: string;
  command: string;
  pkg: string;
  repo: string;
  state: BoardState;
  startedAt: string | null;
  exitCode: number | null;
  error: string | null;
  tail: BoardTailLine[] | null;
}

export interface BoardModel {
  workspace: string;
  entries: BoardEntry[];
}

export interface SessionHello {
  t: "hello";
  protocol: number;
  version: string;
  views: string[];
}

export interface SessionIntent {
  t: "intent";
  name: "add" | "restart" | "stop" | "focus" | "tail" | "quit";
  entryId?: string;
  open?: boolean;
}

export interface SessionClosed {
  t: "closed";
  reason: "quit" | "cancel" | "closed" | "error";
  message?: string;
}

export type SessionInbound = SessionHello | SessionIntent | SessionClosed;

export function parseSessionLine(line: string): SessionInbound {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.trim());
  } catch {
    throw new Error(`rt-ui session: not JSON: ${line.slice(0, 120)}`);
  }
  const m = parsed as Record<string, unknown>;
  switch (m?.t) {
    case "hello":
      if (typeof m.protocol !== "number" || !Array.isArray(m.views)) break;
      return { t: "hello", protocol: m.protocol, version: String(m.version ?? ""), views: m.views.map(String) };
    case "intent":
      if (typeof m.name !== "string") break;
      return {
        t: "intent",
        name: m.name as SessionIntent["name"],
        ...(typeof m.entryId === "string" ? { entryId: m.entryId } : {}),
        ...(typeof m.open === "boolean" ? { open: m.open } : {}),
      };
    case "closed":
      if (typeof m.reason !== "string") break;
      return { t: "closed", reason: m.reason as SessionClosed["reason"], ...(typeof m.message === "string" ? { message: m.message } : {}) };
  }
  throw new Error(`rt-ui session: unexpected message ${line.slice(0, 120)}`);
}
```

Append to `lib/ui/__tests__/protocol.test.ts`:

```ts
import { parseSessionLine, type BoardModel } from "../protocol.ts";

test("session fixtures parse to typed inbound messages", () => {
  const hello = parseSessionLine(readFileSync(join(FIXTURES, "session-hello.json"), "utf8"));
  expect(hello).toEqual({ t: "hello", protocol: 1, version: "0.1.0", views: ["board"] });
  expect(parseSessionLine(readFileSync(join(FIXTURES, "session-intent-stop.json"), "utf8"))).toEqual({ t: "intent", name: "stop", entryId: "e1" });
  expect(parseSessionLine(readFileSync(join(FIXTURES, "session-intent-tail.json"), "utf8"))).toEqual({ t: "intent", name: "tail", entryId: "e1", open: true });
  expect(parseSessionLine(readFileSync(join(FIXTURES, "session-closed-quit.json"), "utf8"))).toEqual({ t: "closed", reason: "quit" });
  expect(() => parseSessionLine("{}")).toThrow(/rt-ui session/);
});

test("the board model fixture matches the BoardModel type shape", () => {
  const open = fixture("session-model-board.json") as { model: BoardModel };
  expect(open.model.workspace).toBe("rt-runner-a3f9");
  expect(open.model.entries[0]!.state).toBe("running");
  expect(open.model.entries[1]!.exitCode).toBe(1);
  expect(open.model.entries[1]!.tail).toBeNull();
});
```
(`FIXTURES`, `fixture`, `readFileSync`, `join` already exist in that test file.)

- [ ] **Step 7: Run the TS test and tsc**

Run: `bun test lib/ui/__tests__/protocol.test.ts && bunx tsc --noEmit`
Expected: PASS (6 tests), 0 errors.

- [ ] **Step 8: Commit**

```bash
git add ui/fixtures ui/internal/protocol/session.go ui/internal/protocol/session_test.go lib/ui/protocol.ts lib/ui/__tests__/protocol.test.ts
git commit -m "ui: session wire types and fixtures, both languages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2: The session loop and the pty session harness

**Files:**
- Create: `ui/internal/session/session.go`, `ui/internal/testutil/session.go`, `ui/internal/session/session_test.go`
- Modify: `ui/cmd/rt-ui/verbs.go` (add `runSession`), `ui/cmd/rt-ui/main.go` (dispatch `session`)

**Interfaces:**
- Produces (Go): `session.View` interface `{ tea.Model; SetModel(raw json.RawMessage) error; Reason() Reason }`; `session.Reason` with consts `ReasonQuit="quit"`, `ReasonCancel="cancel"`, `ReasonClosed="closed"`, `ReasonError="error"`; messages `session.ModelUpdate{Raw json.RawMessage}`, `session.CloseRequest{}`; `session.Emitter` with `Emit(protocol.Intent) tea.Cmd`; `session.Run(ctx, viewName string, views []string, mk func(*Emitter) View, in io.Reader, out io.Writer, term *os.File, version string) (reason Reason, stdinEOF bool, err error)`; `session.ExitCode(reason Reason, stdinEOF bool, err error) int`.
- Produces (tests): `testutil.StartSession(t, argv, env) *Session` with `Send(line string)`, `ReadLine(timeout) (string, bool)` (stdout), `Type(keys ...string)`, `Kill(sig)`, `Wait() (exit int)`, `TTY() string`, `Screen() string`, `CloseStdin()`.
- Consumes: Task 1's protocol types; `tty.Open`, `tty.WatchStdinEOF` (existing).

- [ ] **Step 1: Write the harness `ui/internal/testutil/session.go`**

```go
package testutil

import (
	"bufio"
	"bytes"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
)

// Session drives a long-lived rt-ui verb: lines go down stdin while it runs,
// stdout lines come back one at a time, keys go to the controlling pty.
type Session struct {
	t      *testing.T
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	lines  chan string
	ptmx   *os.File
	mu     sync.Mutex
	ttyBuf bytes.Buffer
	done   chan struct{}
}

func StartSession(t *testing.T, argv []string, env map[string]string) *Session {
	t.Helper()
	ptmx, pts, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	if err := pty.Setsize(ptmx, &pty.Winsize{Rows: 30, Cols: 100}); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = io.Discard
	cmd.ExtraFiles = []*os.File{pts}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 3}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pts.Close()

	s := &Session{t: t, cmd: cmd, stdin: stdin, lines: make(chan string, 64), ptmx: ptmx, done: make(chan struct{})}
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			s.lines <- sc.Text()
		}
		close(s.lines)
	}()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				s.mu.Lock()
				s.ttyBuf.Write(buf[:n])
				s.mu.Unlock()
			}
			if err != nil {
				close(s.done)
				return
			}
		}
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		ptmx.Close()
	})
	return s
}

func (s *Session) Send(line string) {
	if _, err := io.WriteString(s.stdin, line+"\n"); err != nil {
		s.t.Fatalf("send: %v", err)
	}
}

func (s *Session) CloseStdin() { s.stdin.Close() }

// ReadLine returns the next stdout line, or ok=false when the child's stdout
// closed or the timeout passed.
func (s *Session) ReadLine(timeout time.Duration) (string, bool) {
	select {
	case l, ok := <-s.lines:
		return l, ok
	case <-time.After(timeout):
		return "", false
	}
}

// WaitForPaint blocks until the emulated screen shows text, so keys are
// never typed before the view is up. It reads the screen, not the raw
// stream: styled text arrives as several SGR-separated writes and a
// diffing renderer overwrites cells in place, so a substring match on the
// bytes would miss what a user plainly sees.
func (s *Session) WaitForPaint(text string) {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(s.Screen(), text) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.t.Fatalf("never painted %q:\n%s", text, s.Screen())
}

// WaitForGone is the negative of WaitForPaint: it returns once text has left
// the emulated screen, for asserting a dismissed layer without a fixed sleep.
func (s *Session) WaitForGone(text string) {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !strings.Contains(s.Screen(), text) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.t.Fatalf("still painted %q:\n%s", text, s.Screen())
}

func (s *Session) Type(keys ...string) {
	for _, k := range keys {
		time.Sleep(30 * time.Millisecond)
		io.WriteString(s.ptmx, k)
	}
}

func (s *Session) Kill(sig syscall.Signal) {
	if err := syscall.Kill(s.cmd.Process.Pid, sig); err != nil {
		s.t.Fatal(err)
	}
}

func (s *Session) Wait() int {
	err := s.cmd.Wait()
	select {
	case <-s.done:
	case <-time.After(time.Second):
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	if err != nil {
		s.t.Fatalf("wait: %v", err)
	}
	return 0
}

func (s *Session) TTY() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.ToValidUTF8(s.ttyBuf.String(), "")
}

func (s *Session) Screen() string { return Screen(s.TTY()) }
```

- [ ] **Step 2: Write the failing session tests**

`ui/internal/session/session_test.go` (uses a trivial test view registered only under a build-time hook; the real board arrives in Task 3):

```go
package session_test

import (
	"strings"
	"syscall"
	"testing"
	"time"

	"rt-ui/internal/testutil"
)

const openEcho = `{"t":"open","view":"echo","model":{"text":"hello board"}}`

func start(t *testing.T) *testutil.Session {
	return testutil.StartSession(t, []string{testutil.Binary(t), "session", "--view", "echo"}, map[string]string{"RT_UI_TEST_VIEWS": "1"})
}

func TestHelloIsTheFirstLineAndCarriesTheView(t *testing.T) {
	s := start(t)
	line, ok := s.ReadLine(2 * time.Second)
	if !ok || !strings.Contains(line, `"t":"hello"`) || !strings.Contains(line, `"protocol":1`) || !strings.Contains(line, `"echo"`) {
		t.Fatalf("hello: %q ok=%v", line, ok)
	}
	if s.TTY() != "" {
		t.Fatalf("painted before open: %q", s.TTY())
	}
	s.Send(`{"t":"close"}`)
	if exit := s.Wait(); exit != 2 {
		t.Fatalf("close before open should be a protocol error, exit %d", exit)
	}
}

func TestOpenPaintsAltScreenAndCloseLeavesIt(t *testing.T) {
	s := start(t)
	s.ReadLine(2 * time.Second)
	s.Send(openEcho)
	s.WaitForPaint("hello board")
	if !strings.Contains(s.TTY(), "\x1b[?1049h") {
		t.Fatalf("alt screen never entered: %q", s.TTY())
	}
	s.Send(`{"t":"model","model":{"text":"second model"}}`)
	s.WaitForPaint("second model")
	// The parent ends stdin right after close, exactly as spawn.ts does;
	// that EOF must read as a clean close, never as a dead parent.
	s.Send(`{"t":"close"}`)
	s.CloseStdin()
	line, ok := s.ReadLine(2 * time.Second)
	if !ok || !strings.Contains(line, `"reason":"closed"`) {
		t.Fatalf("closed line: %q", line)
	}
	if exit := s.Wait(); exit != 0 {
		t.Fatalf("exit %d", exit)
	}
	if !strings.Contains(s.TTY(), "\x1b[?1049l") || !strings.Contains(s.TTY(), "\x1b[?25h") {
		t.Fatalf("alt screen not left / cursor not shown: %q", s.TTY())
	}
}

func TestViewQuitEmitsClosedQuit(t *testing.T) {
	s := start(t)
	s.ReadLine(2 * time.Second)
	s.Send(openEcho)
	s.WaitForPaint("hello board")
	s.Type("q")
	line, _ := s.ReadLine(2 * time.Second)
	if !strings.Contains(line, `"t":"intent"`) || !strings.Contains(line, `"quit"`) {
		t.Fatalf("expected a quit intent first: %q", line)
	}
	line, _ = s.ReadLine(2 * time.Second)
	if !strings.Contains(line, `"reason":"quit"`) {
		t.Fatalf("closed: %q", line)
	}
	if exit := s.Wait(); exit != 0 {
		t.Fatalf("exit %d", exit)
	}
}

func TestParentDeathIsClosedErrorExit70(t *testing.T) {
	s := start(t)
	s.ReadLine(2 * time.Second)
	s.Send(openEcho)
	s.WaitForPaint("hello board")
	s.CloseStdin()
	line, _ := s.ReadLine(2 * time.Second)
	if !strings.Contains(line, `"reason":"error"`) {
		t.Fatalf("closed: %q", line)
	}
	if exit := s.Wait(); exit != 70 {
		t.Fatalf("exit %d", exit)
	}
	if !strings.Contains(s.TTY(), "\x1b[?1049l") || !strings.Contains(s.TTY(), "\x1b[?25h") {
		t.Fatalf("terminal not restored: %q", s.TTY())
	}
}

func TestExternalSignalIsClosedCancelExit130(t *testing.T) {
	s := start(t)
	s.ReadLine(2 * time.Second)
	s.Send(openEcho)
	s.WaitForPaint("hello board")
	s.Kill(syscall.SIGTERM)
	line, _ := s.ReadLine(2 * time.Second)
	if !strings.Contains(line, `"reason":"cancel"`) {
		t.Fatalf("closed: %q", line)
	}
	if exit := s.Wait(); exit != 130 {
		t.Fatalf("exit %d", exit)
	}
}

func TestUnknownViewIsExit2(t *testing.T) {
	s := testutil.StartSession(t, []string{testutil.Binary(t), "session", "--view", "nope"}, nil)
	line, _ := s.ReadLine(2 * time.Second)
	if !strings.Contains(line, `"t":"hello"`) {
		t.Fatalf("hello: %q", line)
	}
	s.Send(`{"t":"open","view":"nope","model":{}}`)
	line, _ = s.ReadLine(2 * time.Second)
	if !strings.Contains(line, `"reason":"error"`) {
		t.Fatalf("closed: %q", line)
	}
	if exit := s.Wait(); exit != 2 {
		t.Fatalf("exit %d", exit)
	}
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd ui && go test ./internal/session/ -count=1`
Expected: FAIL (the `session` verb does not exist; the binary prints usage and exits 2 before any hello).

- [ ] **Step 4: Write `ui/internal/session/session.go`**

```go
// Package session runs one alt-screen view for as long as the parent keeps
// the conversation open: hello first, then a view opened by the parent's
// first line, models replaced wholesale, intents emitted as the user acts.
package session

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/colorprofile"

	"rt-ui/internal/protocol"
)

type Reason string

const (
	ReasonQuit   Reason = "quit"
	ReasonCancel Reason = "cancel"
	ReasonClosed Reason = "closed"
	ReasonError  Reason = "error"
)

// ModelUpdate carries a full replacement model into the view.
type ModelUpdate struct{ Raw json.RawMessage }

// CloseRequest is the parent asking the view to leave the screen.
type CloseRequest struct{}

// View is what a view kind implements on top of tea.Model. Reason is read
// after the program returns to decide the closed line and exit code.
type View interface {
	tea.Model
	SetModel(raw json.RawMessage) error
	Reason() Reason
}

// Emitter serializes intent writes; Bubble Tea commands run concurrently.
type Emitter struct {
	mu sync.Mutex
	w  io.Writer
}

func (e *Emitter) Emit(in protocol.Intent) tea.Cmd {
	return func() tea.Msg {
		e.mu.Lock()
		defer e.mu.Unlock()
		_, _ = e.w.Write(protocol.EncodeIntent(in))
		return nil
	}
}

// ErrBadOpen is a protocol error before any view ran: exit 2.
var ErrBadOpen = errors.New("bad open")

// Run speaks the session protocol on in/out and paints the view on term.
// views is the list the hello advertises; viewName is the one this process
// was started for. The returned reason is what the closed line carried;
// stdinEOF says whether the loop ended because the parent went away.
func Run(ctx context.Context, viewName string, views []string, mk func(*Emitter) View, in io.Reader, out io.Writer, term *os.File, version string) (reason Reason, stdinEOF bool, err error) {
	em := &Emitter{w: out}
	closed := func(r Reason, msg string) {
		em.mu.Lock()
		defer em.mu.Unlock()
		_, _ = out.Write(protocol.EncodeClosed(protocol.Closed{Reason: string(r), Message: msg}))
	}

	if _, err := out.Write(protocol.EncodeHello(version, views)); err != nil {
		return ReasonError, false, err
	}

	r := bufio.NewReader(in)
	first, err := protocol.ReadLine(r)
	if err != nil {
		closed(ReasonError, "stdin closed before open")
		return ReasonError, true, err
	}
	kind, raw, err := protocol.DecodeSessionLine(first)
	if err != nil || kind != "open" {
		closed(ReasonError, "first line must be open")
		return ReasonError, false, ErrBadOpen
	}
	var open protocol.Open
	if err := json.Unmarshal(raw, &open); err != nil || open.View != viewName {
		closed(ReasonError, fmt.Sprintf("view %q is not %q", open.View, viewName))
		return ReasonError, false, ErrBadOpen
	}
	view := mk(em)
	if view == nil {
		closed(ReasonError, "unknown view "+viewName)
		return ReasonError, false, ErrBadOpen
	}
	if err := view.SetModel(open.Model); err != nil {
		closed(ReasonError, "bad model: "+err.Error())
		return ReasonError, false, ErrBadOpen
	}

	// Signals are ours (see WithoutSignalHandler): the parent's cancel and an
	// external kill both end the program through ctx, which restores termios.
	p := tea.NewProgram(view,
		tea.WithInput(term),
		tea.WithOutput(term),
		tea.WithContext(ctx),
		tea.WithColorProfile(colorprofile.TrueColor),
		tea.WithoutSignalHandler(),
	)

	// A close line ends the reader: the parent may end stdin right after it,
	// and that EOF must never be mistaken for a dead parent.
	var eof atomic.Bool
	go func() {
		for {
			line, err := protocol.ReadLine(r)
			if err != nil {
				eof.Store(true)
				p.Send(CloseRequest{})
				return
			}
			kind, raw, err := protocol.DecodeSessionLine(line)
			if err != nil {
				continue
			}
			switch kind {
			case "model":
				var m protocol.ModelMsg
				if json.Unmarshal(raw, &m) == nil {
					p.Send(ModelUpdate{Raw: m.Model})
				}
			case "close":
				p.Send(CloseRequest{})
				return
			}
		}
	}()

	_, runErr := p.Run()
	switch {
	case eof.Load():
		closed(ReasonError, "stdin closed")
		return ReasonError, true, nil
	case ctx.Err() != nil, errors.Is(runErr, tea.ErrInterrupted):
		closed(ReasonCancel, "")
		return ReasonCancel, false, nil
	case runErr != nil:
		closed(ReasonError, runErr.Error())
		return ReasonError, false, runErr
	}
	rs := view.Reason()
	closed(rs, "")
	return rs, false, nil
}

// ExitCode maps a reason to the contract: quit/closed 0, cancel 130, error 70
// for a dead parent and 2 for a protocol error.
func ExitCode(r Reason, stdinEOF bool, err error) int {
	switch {
	case errors.Is(err, ErrBadOpen):
		return 2
	case r == ReasonCancel:
		return 130
	case r == ReasonError:
		return 70
	}
	return 0
}
```

- [ ] **Step 5: Add the `echo` test view and `runSession` to the binary**

Create `ui/internal/session/echo.go` (a test-only view, enabled by `RT_UI_TEST_VIEWS=1`, kept tiny so the session loop can be tested before the board exists):

```go
package session

import (
	"encoding/json"

	tea "charm.land/bubbletea/v2"

	"rt-ui/internal/protocol"
)

// Echo paints its model's text and quits on q; it exists so the session
// loop can be tested without a real view.
type Echo struct {
	em     *Emitter
	text   string
	reason Reason
}

func NewEcho(em *Emitter) *Echo { return &Echo{em: em, reason: ReasonClosed} }

func (e *Echo) SetModel(raw json.RawMessage) error {
	var m struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return err
	}
	e.text = m.Text
	return nil
}

func (e *Echo) Reason() Reason { return e.reason }
func (e *Echo) Init() tea.Cmd  { return nil }

func (e *Echo) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch m := msg.(type) {
	case ModelUpdate:
		_ = e.SetModel(m.Raw)
	case CloseRequest:
		e.reason = ReasonClosed
		return e, tea.Quit
	case tea.KeyPressMsg:
		if m.String() == "q" {
			e.reason = ReasonQuit
			return e, tea.Sequence(e.em.Emit(protocol.Intent{Name: "quit"}), tea.Quit)
		}
	}
	return e, nil
}

func (e *Echo) View() tea.View {
	v := tea.NewView(e.text)
	v.AltScreen = true
	return v
}
```

Add to `ui/cmd/rt-ui/verbs.go`:

```go
func runSession(args []string) int {
	viewName := ""
	for i := 0; i < len(args); i++ {
		if args[i] == "--view" && i+1 < len(args) {
			viewName = args[i+1]
			i++
		}
	}
	if viewName == "" {
		fmt.Fprintln(os.Stderr, "rt-ui session: --view <kind> is required")
		return ExitBadSpec
	}
	term, err := tty.Open(tty.ReadWrite)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui session:", err)
		return ExitInternal
	}
	defer term.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	go func() {
		<-signals
		cancel()
	}()

	reason, eof, err := session.Run(ctx, viewName, advertisedViews(), viewFor(viewName), os.Stdin, os.Stdout, term, version)
	code := session.ExitCode(reason, eof, err)
	if code == ExitBadSpec || code == ExitInternal {
		if err != nil {
			fmt.Fprintln(os.Stderr, "rt-ui session:", err)
		}
	}
	return code
}

// advertisedViews is what the hello line offers; the echo view is a test
// fixture and only appears when the env asks for it.
func advertisedViews() []string {
	views := []string{"board"}
	if os.Getenv("RT_UI_TEST_VIEWS") == "1" {
		views = append(views, "echo")
	}
	return views
}

// viewFor maps a view name to its constructor; nil means unknown. The echo
// view only exists for the session tests and is hidden without the env.
func viewFor(name string) func(*session.Emitter) session.View {
	switch name {
	case "echo":
		if os.Getenv("RT_UI_TEST_VIEWS") != "1" {
			return func(*session.Emitter) session.View { return nil }
		}
		return func(em *session.Emitter) session.View { return session.NewEcho(em) }
	}
	return func(*session.Emitter) session.View { return nil }
}
```
(add `"rt-ui/internal/session"` to that file's imports). In `ui/cmd/rt-ui/main.go`'s switch add `case "session": os.Exit(runSession(os.Args[2:]))` and extend the usage string to `rt-ui prompt | rt-ui steps | rt-ui session --view <kind> | rt-ui --version`.

- [ ] **Step 6: Build, vet, run the session tests**

Run: `cd ui && gofmt -l . && go vet ./... && go test ./internal/session/ -count=1 && go test ./... -count=1`
Expected: PASS. The `closed{cancel}` on SIGTERM comes from `ctx.Err() != nil` after `cancel()`; if `p.Run` returns `tea.ErrProgramKilled` instead, the `ctx.Err()` case still catches it (it is checked first).

- [ ] **Step 7: Commit**

```bash
git add ui/internal/session ui/internal/testutil/session.go ui/cmd/rt-ui/verbs.go ui/cmd/rt-ui/main.go
git commit -m "ui: session verb (hello, open/model/close, intents, closed) with a pty session harness

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3: The `board` view

**Files:**
- Create: `ui/internal/views/board/model.go`, `ui/internal/views/board/board.go`, `ui/internal/views/board/render.go`, `ui/internal/views/board/board_test.go`
- Modify: `ui/cmd/rt-ui/verbs.go` (`viewFor` gains `"board"`)

**Interfaces:**
- Consumes: `session.View`, `session.Emitter`, `session.ModelUpdate`, `session.CloseRequest`, `protocol.Intent`; `theme.*`.
- Produces: `board.New(em *session.Emitter) *Board` implementing `session.View`.

- [ ] **Step 1: Write the model types `ui/internal/views/board/model.go`**

```go
package board

import (
	"encoding/json"
	"time"
)

type TailLine struct {
	TS   string `json:"ts"`
	Text string `json:"text"`
}

type Entry struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Command   string     `json:"command"`
	Pkg       string     `json:"pkg"`
	Repo      string     `json:"repo"`
	State     string     `json:"state"`
	StartedAt *string    `json:"startedAt"`
	ExitCode  *int       `json:"exitCode"`
	Error     *string    `json:"error"`
	Tail      []TailLine `json:"tail"`
}

type Model struct {
	Workspace string  `json:"workspace"`
	Entries   []Entry `json:"entries"`
}

func decode(raw json.RawMessage) (Model, error) {
	var m Model
	err := json.Unmarshal(raw, &m)
	return m, err
}

// uptime is derived here, never pushed: the parent pushes startedAt once and
// Go ticks the display itself so a slow poll can never make seconds skip.
func (e Entry) uptime(now time.Time) string {
	if e.State != "running" || e.StartedAt == nil {
		return ""
	}
	t, err := time.Parse(time.RFC3339Nano, *e.StartedAt)
	if err != nil {
		return ""
	}
	s := int(now.Sub(t).Seconds())
	if s < 0 {
		s = 0
	}
	return intString(s/60) + ":" + pad2(s%60)
}

func intString(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func pad2(n int) string {
	if n < 10 {
		return "0" + intString(n)
	}
	return intString(n)
}
```

- [ ] **Step 2: Write the failing board tests**

`ui/internal/views/board/board_test.go`:

```go
package board_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rt-ui/internal/testutil"
)

func fixture(t *testing.T, name string) string {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(b))
}

// fixtureLine compacts a pretty-printed fixture to the one line the wire
// carries.
func fixtureLine(t *testing.T, name string) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, []byte(fixture(t, name))); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}

func open(t *testing.T) *testutil.Session {
	s := testutil.StartSession(t, []string{testutil.Binary(t), "session", "--view", "board"}, nil)
	if l, ok := s.ReadLine(2 * time.Second); !ok || !strings.Contains(l, `"hello"`) {
		t.Fatalf("hello: %q", l)
	}
	model := strings.Replace(fixtureLine(t, "session-model-board.json"), `"t":"model"`, `"t":"open","view":"board"`, 1)
	s.Send(model)
	s.WaitForPaint("rt runner")
	return s
}

func TestPopulatedBoardPaintsRowsHeaderAndKeybar(t *testing.T) {
	s := open(t)
	screen := s.Screen()
	for _, want := range []string{"rt runner", "rt-runner-a3f9", "1 running", "1 crashed", "dev", "bun run dev", "web · assured-dev", "worker", "exited 1", "navigate", "process", "q quit"} {
		if !strings.Contains(screen, want) {
			t.Fatalf("missing %q in\n%s", want, screen)
		}
	}
	if !strings.Contains(screen, "●") || !strings.Contains(screen, "✗") {
		t.Fatalf("glyphs missing:\n%s", screen)
	}
	s.Send(`{"t":"close"}`)
	s.Wait()
}

func TestEmptyBoardShowsTheEmptyState(t *testing.T) {
	s := testutil.StartSession(t, []string{testutil.Binary(t), "session", "--view", "board"}, nil)
	s.ReadLine(2 * time.Second)
	s.Send(fixtureLine(t, "session-open-board.json"))
	s.WaitForPaint("Nothing running")
	if !strings.Contains(s.Screen(), "Press a to add a command") {
		t.Fatalf("empty state missing:\n%s", s.Screen())
	}
	s.Send(`{"t":"close"}`)
	s.Wait()
}

func TestNavigationStaysLocalAndTailEmitsIntent(t *testing.T) {
	s := open(t)
	s.Type("j")
	time.Sleep(50 * time.Millisecond)
	if l, ok := s.ReadLine(100 * time.Millisecond); ok {
		t.Fatalf("j must not cross the pipe: %q", l)
	}
	s.Type("t")
	l, ok := s.ReadLine(2 * time.Second)
	if !ok || !strings.Contains(l, `"name":"tail"`) || !strings.Contains(l, `"entryId":"e2"`) || !strings.Contains(l, `"open":true`) {
		t.Fatalf("tail intent: %q", l)
	}
	s.Type("k")
	l, _ = s.ReadLine(2 * time.Second)
	if !strings.Contains(l, `"entryId":"e1"`) || !strings.Contains(l, `"open":true`) {
		t.Fatalf("selection change while open must re-emit tail: %q", l)
	}
	s.WaitForPaint("tail · dev")
	if !strings.Contains(s.Screen(), "VITE v5.4.2") {
		t.Fatalf("tail body missing:\n%s", s.Screen())
	}
	s.Type("t")
	l, _ = s.ReadLine(2 * time.Second)
	if !strings.Contains(l, `"open":false`) {
		t.Fatalf("closing the peek must emit open:false: %q", l)
	}
	s.Send(`{"t":"close"}`)
	s.Wait()
}

func TestActionKeysEmitIntentsWithEntryIds(t *testing.T) {
	s := open(t)
	for _, tc := range []struct{ key, name string }{{"s", "restart"}, {"x", "stop"}, {"f", "focus"}} {
		s.Type(tc.key)
		l, _ := s.ReadLine(2 * time.Second)
		if !strings.Contains(l, `"name":"`+tc.name+`"`) || !strings.Contains(l, `"entryId":"e1"`) {
			t.Fatalf("%s: %q", tc.key, l)
		}
	}
	s.Type("a")
	if l, _ := s.ReadLine(2 * time.Second); !strings.Contains(l, `"name":"add"`) || strings.Contains(l, "entryId") {
		t.Fatalf("add: %q", l)
	}
	s.Send(`{"t":"close"}`)
	s.Wait()
}

func TestQuitConfirmsWhenRunningAndEmitsQuitOnY(t *testing.T) {
	s := open(t)
	s.Type("q")
	s.WaitForPaint("Quit and stop")
	if l, ok := s.ReadLine(100 * time.Millisecond); ok {
		t.Fatalf("q with running entries must not emit yet: %q", l)
	}
	s.Type("n")
	s.WaitForGone("Quit and stop")
	s.Type("q", "y")
	l, _ := s.ReadLine(2 * time.Second)
	if !strings.Contains(l, `"name":"quit"`) {
		t.Fatalf("quit intent: %q", l)
	}
	l, _ = s.ReadLine(2 * time.Second)
	if !strings.Contains(l, `"reason":"quit"`) {
		t.Fatalf("closed: %q", l)
	}
	if exit := s.Wait(); exit != 0 {
		t.Fatalf("exit %d", exit)
	}
	if strings.Contains(s.Screen(), "rt runner") {
		t.Fatalf("board still on screen after quit:\n%s", s.Screen())
	}
}

func TestQuitWithNothingRunningQuitsAtOnce(t *testing.T) {
	s := testutil.StartSession(t, []string{testutil.Binary(t), "session", "--view", "board"}, nil)
	s.ReadLine(2 * time.Second)
	s.Send(fixtureLine(t, "session-open-board.json"))
	s.WaitForPaint("Nothing running")
	s.Type("q")
	if l, _ := s.ReadLine(2 * time.Second); !strings.Contains(l, `"name":"quit"`) {
		t.Fatalf("quit intent: %q", l)
	}
	if exit := s.Wait(); exit != 0 {
		t.Fatalf("exit %d", exit)
	}
}

func TestModelReplacementKeepsCursorByIdAndUptimeTicks(t *testing.T) {
	s := open(t)
	s.Type("j")
	reordered := `{"t":"model","model":{"workspace":"rt-runner-a3f9","entries":[` +
		`{"id":"e2","name":"worker","command":"bun run worker","pkg":"backend","repo":"assured-dev","state":"starting","startedAt":null,"exitCode":null,"error":null,"tail":null},` +
		`{"id":"e1","name":"dev","command":"bun run dev","pkg":"web","repo":"assured-dev","state":"running","startedAt":"` + time.Now().Add(-125*time.Second).UTC().Format(time.RFC3339) + `","exitCode":null,"error":null,"tail":null}]}}`
	s.Send(reordered)
	time.Sleep(150 * time.Millisecond)
	s.Type("x")
	if l, _ := s.ReadLine(2 * time.Second); !strings.Contains(l, `"entryId":"e2"`) {
		t.Fatalf("cursor did not follow the entry id across the reorder: %q", l)
	}
	if !strings.Contains(s.Screen(), "2:0") {
		t.Fatalf("uptime not derived from startedAt (want 2:05 or so):\n%s", s.Screen())
	}
	s.Send(`{"t":"close"}`)
	s.Wait()
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd ui && go test ./internal/views/board/ -count=1`
Expected: FAIL (unknown view `board` → exit 2 / no paint).

- [ ] **Step 4: Write `ui/internal/views/board/board.go`**

```go
// Package board is the runner view: a flat list of headless commands with a
// tail peek and a quit-confirm layer. Everything here is UI state; the
// entries themselves arrive from the parent and are replaced wholesale.
package board

import (
	"encoding/json"
	"time"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"

	"rt-ui/internal/protocol"
	"rt-ui/internal/session"
	"rt-ui/internal/theme"
)

type tickMsg time.Time

type Board struct {
	em       *session.Emitter
	model    Model
	selected string
	tailOpen bool
	confirm  bool
	width    int
	height   int
	spin     spinner.Model
	now      time.Time
	reason   session.Reason
}

func New(em *session.Emitter) *Board {
	return &Board{
		em:     em,
		spin:   spinner.New(spinner.WithSpinner(spinner.Spinner{Frames: theme.SpinnerFrames, FPS: 80 * time.Millisecond})),
		now:    time.Now(),
		reason: session.ReasonClosed,
	}
}

func (b *Board) SetModel(raw json.RawMessage) error {
	m, err := decode(raw)
	if err != nil {
		return err
	}
	b.model = m
	b.clampSelection()
	return nil
}

func (b *Board) Reason() session.Reason { return b.reason }

func tick() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (b *Board) Init() tea.Cmd {
	return tea.Batch(tick(), b.spinCmd())
}

func (b *Board) spinCmd() tea.Cmd {
	if b.anyTransitional() {
		return b.spin.Tick
	}
	return nil
}

func (b *Board) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch m := msg.(type) {
	case tea.WindowSizeMsg:
		b.width, b.height = m.Width, m.Height
	case tickMsg:
		b.now = time.Time(m)
		return b, tick()
	case spinner.TickMsg:
		if !b.anyTransitional() {
			return b, nil
		}
		var cmd tea.Cmd
		b.spin, cmd = b.spin.Update(m)
		return b, cmd
	case session.ModelUpdate:
		prev := b.selected
		wasTransitional := b.anyTransitional()
		if err := b.SetModel(m.Raw); err != nil {
			return b, nil
		}
		var cmds []tea.Cmd
		if b.tailOpen && b.selected != prev {
			cmds = append(cmds, b.tailIntent(true))
		}
		if !wasTransitional && b.anyTransitional() {
			cmds = append(cmds, b.spin.Tick)
		}
		return b, tea.Batch(cmds...)
	case session.CloseRequest:
		b.reason = session.ReasonClosed
		return b, tea.Quit
	case tea.KeyPressMsg:
		return b.key(m.String())
	}
	return b, nil
}

func (b *Board) key(k string) (tea.Model, tea.Cmd) {
	if b.confirm {
		switch k {
		case "y":
			return b.quit()
		case "n", "esc":
			b.confirm = false
		}
		return b, nil
	}
	switch k {
	case "j", "down":
		b.move(1)
		if b.tailOpen {
			return b, b.tailIntent(true)
		}
	case "k", "up":
		b.move(-1)
		if b.tailOpen {
			return b, b.tailIntent(true)
		}
	case "t":
		if b.selected == "" {
			return b, nil
		}
		b.tailOpen = !b.tailOpen
		return b, b.tailIntent(b.tailOpen)
	case "a":
		return b, b.em.Emit(protocol.Intent{Name: "add"})
	case "s", "x", "f":
		if b.selected == "" {
			return b, nil
		}
		name := map[string]string{"s": "restart", "x": "stop", "f": "focus"}[k]
		return b, b.em.Emit(protocol.Intent{Name: name, EntryID: b.selected})
	case "q", "ctrl+c":
		if b.count("running")+b.count("starting") > 0 {
			b.confirm = true
			return b, nil
		}
		return b.quit()
	}
	return b, nil
}

func (b *Board) quit() (tea.Model, tea.Cmd) {
	b.reason = session.ReasonQuit
	return b, tea.Sequence(b.em.Emit(protocol.Intent{Name: "quit"}), tea.Quit)
}

func (b *Board) tailIntent(open bool) tea.Cmd {
	o := open
	return b.em.Emit(protocol.Intent{Name: "tail", EntryID: b.selected, Open: &o})
}

func (b *Board) index() int {
	for i, e := range b.model.Entries {
		if e.ID == b.selected {
			return i
		}
	}
	return -1
}

func (b *Board) move(delta int) {
	n := len(b.model.Entries)
	if n == 0 {
		return
	}
	i := b.index() + delta
	if i < 0 {
		i = 0
	}
	if i >= n {
		i = n - 1
	}
	b.selected = b.model.Entries[i].ID
}

// The cursor follows an entry id, not a row: a model that reorders or
// removes rows can never leave it pointing at the wrong command.
func (b *Board) clampSelection() {
	if len(b.model.Entries) == 0 {
		b.selected = ""
		b.tailOpen = false
		return
	}
	if b.index() < 0 {
		b.selected = b.model.Entries[0].ID
	}
}

func (b *Board) selectedEntry() *Entry {
	if i := b.index(); i >= 0 {
		return &b.model.Entries[i]
	}
	return nil
}

func (b *Board) count(state string) int {
	n := 0
	for _, e := range b.model.Entries {
		if e.State == state {
			n++
		}
	}
	return n
}

func (b *Board) anyTransitional() bool {
	return b.count("starting")+b.count("stopping") > 0
}

func (b *Board) View() tea.View {
	v := tea.NewView(render(b))
	v.AltScreen = true
	return v
}
```

- [ ] **Step 5: Write `ui/internal/views/board/render.go`**

```go
package board

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"

	"rt-ui/internal/theme"
)

const (
	nameW  = 10
	pkgW   = 24
	rightW = 9
	tailN  = 6
)

var onBg = lipgloss.NewStyle().Background(theme.Bg)

func fg(c interface{ RGBA() (r, g, b, a uint32) }) lipgloss.Style {
	return onBg.Foreground(c)
}

func render(b *Board) string {
	if b.width == 0 {
		return ""
	}
	top := []string{header(b), rule(b.width)}
	if len(b.model.Entries) == 0 {
		top = append(top, emptyState(b.width))
	}
	for i := range b.model.Entries {
		top = append(top, row(b, i))
	}
	if b.tailOpen {
		if e := b.selectedEntry(); e != nil {
			top = append(top, tailBox(b, e))
		}
	}
	var bottom string
	if b.confirm {
		bottom = confirmLayer(b)
	} else {
		bottom = lipgloss.JoinVertical(lipgloss.Left, rule(b.width), keybar(b))
	}
	body := lipgloss.Place(b.width, b.height-lipgloss.Height(bottom), lipgloss.Left, lipgloss.Top,
		lipgloss.JoinVertical(lipgloss.Left, top...), lipgloss.WithWhitespaceStyle(onBg))
	return lipgloss.JoinVertical(lipgloss.Left, body, bottom)
}

func header(b *Board) string {
	left := fg(theme.Text).Bold(true).Render("rt runner") + fg(theme.Faint).Render(" · ") + fg(theme.Dimmer).Render(b.model.Workspace)
	var counts []string
	if n := b.count("running"); n > 0 {
		counts = append(counts, fg(theme.Mint).Render(fmt.Sprintf("● %d running", n)))
	}
	if n := b.count("stopped"); n > 0 {
		counts = append(counts, fg(theme.Dim).Render(fmt.Sprintf("○ %d stopped", n)))
	}
	if n := b.count("crashed"); n > 0 {
		counts = append(counts, fg(theme.Coral).Render(fmt.Sprintf("✗ %d crashed", n)))
	}
	if len(b.model.Entries) == 0 {
		counts = append(counts, fg(theme.Faint).Render("0 commands"))
	}
	return justify(b.width, left, strings.Join(counts, fg(theme.Faint).Render(" · ")))
}

func rule(width int) string {
	return fg(theme.Rule).Render(strings.Repeat("─", width))
}

func emptyState(width int) string {
	lines := []string{
		"",
		fg(theme.TextSoft).Render("  Nothing running."),
		fg(theme.Dimmer).Render("  Press ") + fg(theme.PinkSoft).Render("a") + fg(theme.Dimmer).Render(" to add a command."),
	}
	return lipgloss.JoinVertical(lipgloss.Left, lines...)
}

func row(b *Board, i int) string {
	e := b.model.Entries[i]
	sel := e.ID == b.selected
	bg := theme.Bg
	nameC, cmdC := theme.Text, theme.Dim
	if sel {
		bg = theme.SelBg
		nameC, cmdC = theme.PinkSoft, theme.TextSoft
	}
	on := lipgloss.NewStyle().Background(bg)
	prefix := on.Render("  ")
	if sel {
		prefix = on.Foreground(theme.Pink).Render("▌ ")
	}
	glyph, glyphC := "●", theme.Mint
	right, rightC := e.uptime(b.now), theme.TextSoft
	switch e.State {
	case "stopped":
		glyph, glyphC = "○", theme.Dim
		right, rightC = "stopped", theme.Dimmer
	case "crashed":
		glyph, glyphC = "✗", theme.Coral
		right, rightC = fmt.Sprintf("exited %d", deref(e.ExitCode)), theme.Coral
	case "starting":
		glyph, glyphC = b.spin.View(), theme.Mint
		right, rightC = "starting", theme.Dimmer
	case "stopping":
		glyph, glyphC = b.spin.View(), theme.Coral
		right, rightC = "stopping", theme.Dimmer
	}
	if e.Error != nil {
		right, rightC = clip(*e.Error, rightW), theme.Coral
	}
	cmdW := b.width - (2 + 1 + 2 + nameW + 2 + 2 + pkgW + 2 + rightW + 1)
	if cmdW < 4 {
		cmdW = 4
	}
	return prefix +
		on.Foreground(glyphC).Render(glyph) + on.Render("  ") +
		on.Foreground(nameC).Width(nameW).Render(clip(e.Name, nameW)) + on.Render("  ") +
		on.Foreground(cmdC).Width(cmdW).Render(clip(e.Command, cmdW)) + on.Render("  ") +
		on.Foreground(theme.Faint).Width(pkgW).Render(clip(e.Pkg+" · "+e.Repo, pkgW)) + on.Render("  ") +
		on.Foreground(rightC).Width(rightW).Align(lipgloss.Right).Render(right) + on.Render(" ")
}

func tailBox(b *Board, e *Entry) string {
	title := fg(theme.Cyan).Render("tail") + fg(theme.Faint).Render(" · ") + fg(theme.TextSoft).Render(e.Name)
	rightT := fg(theme.Faint).Render("refreshing 1s")
	border := fg(theme.Panel)
	fill := b.width - 8 - lipgloss.Width(title) - lipgloss.Width(rightT)
	if fill < 0 {
		fill = 0
	}
	top := border.Render("╭─ ") + title + border.Render(" "+strings.Repeat("─", fill)+" ") + rightT + border.Render(" ─╮")
	lines := e.Tail
	if len(lines) > tailN {
		lines = lines[len(lines)-tailN:]
	}
	inner := b.width - 4
	var body []string
	for _, l := range lines {
		text := fg(theme.Faint).Render(l.TS+" ") + fg(theme.TextSoft).Render(l.Text)
		body = append(body, onBg.Width(inner).Render(clip(text, inner)))
	}
	for len(body) < tailN {
		body = append(body, onBg.Width(inner).Render(""))
	}
	boxed := onBg.Border(lipgloss.RoundedBorder()).BorderTop(false).BorderForeground(theme.Panel).BorderBackground(theme.Bg).Padding(0, 1).
		Render(strings.Join(body, "\n"))
	return lipgloss.JoinVertical(lipgloss.Left, top, boxed)
}

func keybar(b *Board) string {
	group := fg(theme.Lav)
	key := func(k, l string) string { return fg(theme.Faint).Render(k) + onBg.Render(" ") + fg(theme.Dim).Render(l) }
	left := group.Render("navigate") + onBg.Render(" ") + key("j/k", "up·down") + onBg.Render("   ") +
		group.Render("process") + onBg.Render(" ") + strings.Join([]string{key("a", "add"), key("s", "restart"), key("x", "stop"), key("f", "focus"), key("t", "tail")}, onBg.Render("  "))
	return justify(b.width, left, key("q", "quit"))
}

func confirmLayer(b *Board) string {
	on := lipgloss.NewStyle().Background(theme.WarnBg)
	n := b.count("running") + b.count("starting")
	left := on.Foreground(theme.Peach).Render("⚠ ") + on.Foreground(theme.Text).Render(fmt.Sprintf("Quit and stop %d running processes?", n))
	right := on.Foreground(theme.Pink).Bold(true).Render("y") + on.Render(" ") + on.Foreground(theme.Dim).Render("yes, stop all") + on.Render("   ") +
		on.Foreground(theme.Dim).Bold(true).Render("n") + on.Render(" ") + on.Foreground(theme.Dim).Render("keep running")
	inner := b.width - 4
	line := left + lipgloss.PlaceHorizontal(inner-lipgloss.Width(left), lipgloss.Right, right, lipgloss.WithWhitespaceStyle(on))
	return on.Border(lipgloss.RoundedBorder()).BorderForeground(theme.Peach).BorderBackground(theme.WarnBg).Padding(0, 1).Render(line)
}

func justify(width int, left, right string) string {
	avail := width - 3 - lipgloss.Width(left)
	if avail < 0 {
		avail = 0
	}
	return onBg.Render("  ") + left + lipgloss.PlaceHorizontal(avail, lipgloss.Right, right, lipgloss.WithWhitespaceStyle(onBg)) + onBg.Render(" ")
}

func clip(s string, w int) string {
	return lipgloss.NewStyle().Inline(true).MaxWidth(w).Render(s)
}

func deref(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}
```

`fg`'s parameter type is `color.Color`; import `image/color` and write `func fg(c color.Color) lipgloss.Style`.

- [ ] **Step 6: Register the view**

In `ui/cmd/rt-ui/verbs.go` `viewFor`, add before the `echo` case:
```go
	case "board":
		return func(em *session.Emitter) session.View { return board.New(em) }
```
and import `"rt-ui/internal/views/board"`.

- [ ] **Step 7: Build, vet, run**

Run: `cd ui && gofmt -l . && go vet ./... && go test ./internal/views/board/ -count=1 && go test ./... -count=1`
Expected: PASS. `lipgloss.WithWhitespaceStyle`, `Place`, `PlaceHorizontal`, and the `Style` setters used here exist in lipgloss v2.0.6; if a signature still differs, `go doc charm.land/lipgloss/v2 <Symbol>` is the reference and the screen assertions are the contract.

- [ ] **Step 8: Commit**

```bash
git add ui/internal/views ui/cmd/rt-ui/verbs.go
git commit -m "ui: board view (rows, tail peek, quit layer, intents, uptime tick)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4: `openSession` in the TS spawn layer, and the fake's session mode

**Files:**
- Modify: `lib/ui/spawn.ts`, `lib/ui/__tests__/fake-rt-ui.ts`
- Create: `lib/ui/__tests__/session.test.ts`

**Interfaces:**
- Produces: `openSession(view: string, model: unknown): Promise<SessionHandle>` with `interface SessionHandle { intents: AsyncIterable<SessionIntent>; push(model: unknown): void; close(): Promise<SessionEnd>; exited: Promise<number>; }` and `interface SessionEnd { reason: SessionClosed["reason"] | "died"; code: number; message?: string }`. `push` after the child died is a no-op. `close()` sends `close`, awaits exit, and resolves with the recorded `closed` reason (or `died`). A non-`hello` first line, a protocol other than 1, or a `views` list without `view` fails through `fail(bin, 2, ...)`.
- Produces (fake): `RT_UI_FAKE.intents: SessionIntent[]` played back after `open` (one per 20 ms), `record` receives every stdin line, `closedReason` overrides the reason sent on `close` (default `closed`), `exit` makes the fake die right after `open` with that code and no `closed` line.

- [ ] **Step 1: Extend the fake**

Append to `lib/ui/__tests__/fake-rt-ui.ts` before the final `unknown verb` lines:

```ts
if (verb === "session") {
  const viewIdx = process.argv.indexOf("--view");
  const view = viewIdx >= 0 ? process.argv[viewIdx + 1] : "";
  process.stdout.write(JSON.stringify({ t: "hello", protocol: cfg.protocol ?? 1, version: "fake", views: [view] }) + "\n");
  const intents = (cfg.intents ?? []) as object[];
  let closedSent = false;
  const sendClosed = (reason: string) => {
    if (closedSent) return;
    closedSent = true;
    process.stdout.write(JSON.stringify({ t: "closed", reason }) + "\n");
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
      sendClosed("error");
      process.exit(70);
    }
    buf += decoder.decode(value);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      lines.push(line);
      const t = (JSON.parse(line) as { t: string }).t;
      if (t === "open") {
        if (cfg.exit !== undefined) {
          if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
          process.exit(cfg.exit);
        }
        for (const it of intents) {
          await Bun.sleep(20);
          process.stdout.write(JSON.stringify({ t: "intent", ...it }) + "\n");
          if ((it as { name?: string }).name === "quit") {
            if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
            sendClosed("quit");
            process.exit(0);
          }
        }
      }
      if (t === "close") {
        if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
        sendClosed((cfg.closedReason as string | undefined) ?? "closed");
        process.exit(0);
      }
    }
  }
}
```
and extend the `cfg` type with `intents?: object[]; closedReason?: string; protocol?: number;`.

- [ ] **Step 2: Write the failing tests**

`lib/ui/__tests__/session.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { openSession, __test__ } from "../spawn.ts";
import { __test__ as gate } from "../gate.ts";

const FAKE = resolve(import.meta.dir, "fake-rt-ui.ts");
let dir: string;
let record: string;
const exits: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-ui-session-"));
  record = join(dir, "record.ndjson");
  process.env.RT_UI_BIN = FAKE;
  gate.setInteractive(() => true);
  exits.length = 0;
  __test__.setExit((code) => { exits.push(code); throw new Error(`exit ${code}`); });
});
afterEach(() => {
  gate.setInteractive(undefined);
  __test__.setExit(undefined);
  delete process.env.RT_UI_BIN;
  delete process.env.RT_UI_FAKE;
  rmSync(dir, { recursive: true, force: true });
});

const sent = () => readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("open sends the model after hello, intents stream in order, close resolves closed", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ record, intents: [{ name: "stop", entryId: "e1" }, { name: "tail", entryId: "e1", open: true }] });
  const s = await openSession("board", { workspace: "w", entries: [] });
  const got: unknown[] = [];
  for await (const it of s.intents) {
    got.push(it);
    if (got.length === 2) break;
  }
  expect(got).toEqual([{ t: "intent", name: "stop", entryId: "e1" }, { t: "intent", name: "tail", entryId: "e1", open: true }]);
  s.push({ workspace: "w", entries: [{ id: "e1" }] });
  const end = await s.close();
  expect(end).toEqual({ reason: "closed", code: 0 });
  expect(sent()).toEqual([
    { t: "open", view: "board", model: { workspace: "w", entries: [] } },
    { t: "model", model: { workspace: "w", entries: [{ id: "e1" }] } },
    { t: "close" },
  ]);
});

test("a quit intent ends the stream and close reports quit", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ record, intents: [{ name: "quit" }] });
  const s = await openSession("board", { workspace: "w", entries: [] });
  const got: unknown[] = [];
  for await (const it of s.intents) got.push(it);
  expect(got).toEqual([{ t: "intent", name: "quit" }]);
  expect(await s.close()).toEqual({ reason: "quit", code: 0 });
});

test("a child that dies after open surfaces as died with its code and push becomes a no-op", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ record, exit: 130 });
  const s = await openSession("board", { workspace: "w", entries: [] });
  const got: unknown[] = [];
  for await (const it of s.intents) got.push(it);
  expect(got).toEqual([]);
  s.push({ workspace: "w", entries: [] });
  expect(await s.close()).toEqual({ reason: "died", code: 130 });
});

test("a hello with the wrong protocol fails through the exit seam with code 1", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ record, protocol: 9 });
  await expect(openSession("board", {})).rejects.toThrow("exit 1");
  expect(exits).toEqual([1]);
});

test("a closed gate refuses to spawn", async () => {
  gate.setInteractive(() => false);
  process.env.RT_UI_FAKE = JSON.stringify({ record });
  await expect(openSession("board", {})).rejects.toThrow("exit 1");
  expect(() => readFileSync(record)).toThrow();
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `bun test lib/ui/__tests__/session.test.ts`
Expected: FAIL (`openSession` is not exported).

- [ ] **Step 4: Add `openSession` to `lib/ui/spawn.ts`**

Change `spawnVerb`'s signature to `spawnVerb(verb: "prompt" | "steps" | "session", extra: string[] = [])` and spawn `[bin, verb, ...extra]`. Add the imports `parseSessionLine, type SessionClosed, type SessionIntent` from `./protocol.ts` and `interactive` from `./gate.ts`, then append:

```ts
export interface SessionEnd {
  reason: SessionClosed["reason"] | "died";
  code: number;
  message?: string;
}

export interface SessionHandle {
  /** User actions, in order, until the child sends closed or dies. */
  intents: AsyncIterable<SessionIntent>;
  /** Full model replacement; a no-op once the child is gone. */
  push(model: unknown): void;
  /** Ask the view to leave the screen; resolves once the child has exited. */
  close(): Promise<SessionEnd>;
  exited: Promise<number>;
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) yield buf;
}

export async function openSession(view: string, model: unknown): Promise<SessionHandle> {
  if (!interactive()) {
    process.stderr.write("rt: this view needs an interactive terminal (set RT_BATCH to skip it in scripts)\n");
    return exit(1);
  }
  const { bin, proc } = spawnVerb("session", ["--view", view]);
  const reader = lines(proc.stdout);
  const first = await reader.next();
  let hello: ReturnType<typeof parseSessionLine> | undefined;
  try {
    hello = first.done ? undefined : parseSessionLine(first.value);
  } catch {
    hello = undefined;
  }
  if (!hello || hello.t !== "hello" || hello.protocol !== PROTOCOL_VERSION || !hello.views.includes(view)) {
    // The child is waiting for open and would wait forever: end its stdin so
    // it sees a dead parent and exits, then report.
    try { proc.stdin.end(); } catch { /* already closed */ }
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    return fail(bin, 2, stderr || `rt-ui session: bad hello ${first.done ? "(stdout closed)" : first.value}`);
  }

  let dead = false;
  let end: SessionEnd | undefined;
  const send = (msg: object): void => {
    if (dead) return;
    try {
      proc.stdin.write(encodeLine(msg));
      proc.stdin.flush();
    } catch {
      dead = true;
    }
  };
  send({ t: "open", view, model });

  // One eager reader owns stdout for the child's whole life: intents queue
  // up for whoever iterates, and the closed line is recorded whether or not
  // anyone is still pulling (a quit intent is usually the last thing the
  // consumer reads before it calls close()).
  const queue: SessionIntent[] = [];
  let wake: (() => void) | null = null;
  let stdoutDone = false;
  const drained = (async () => {
    for await (const line of reader) {
      let msg;
      try {
        msg = parseSessionLine(line);
      } catch {
        continue;
      }
      if (msg.t === "intent") queue.push(msg);
      if (msg.t === "closed") end = { reason: msg.reason, code: 0, ...(msg.message ? { message: msg.message } : {}) };
      wake?.();
    }
    stdoutDone = true;
    wake?.();
  })();
  const exited = proc.exited.then((code) => {
    dead = true;
    return code;
  });

  async function* intents(): AsyncGenerator<SessionIntent> {
    while (true) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (end || stdoutDone) return;
      await new Promise<void>((r) => { wake = r; });
      wake = null;
    }
  }

  return {
    intents: intents(),
    push: (m) => send({ t: "model", model: m }),
    exited,
    async close() {
      send({ t: "close" });
      const code = await exited;
      await drained;
      // stdin stays open until the child is gone: EOF is its parent-death signal.
      try { proc.stdin.end(); } catch { /* already closed */ }
      if (end) return { ...end, code };
      return { reason: "died", code };
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test lib/ui/__tests__/session.test.ts lib/ui/__tests__/spawn.test.ts && bunx tsc --noEmit`
Expected: PASS (5 + 8), 0 errors.

- [ ] **Step 6: Commit**

```bash
git add lib/ui/spawn.ts lib/ui/__tests__/fake-rt-ui.ts lib/ui/__tests__/session.test.ts
git commit -m "ui: openSession client for the rt-ui session verb, fake session mode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 5: Extract `resolveRun` from `rt run`

**Files:**
- Modify: `commands/run.ts`
- Create: `commands/__tests__/run-resolve.test.ts`

**Interfaces:**
- Produces: `export class RunAborted extends Error { constructor(public readonly code: number, message = "") }`; `export type RunResolution = { kind: "resolved"; result: RunResolveResult } | { kind: "launched" } | { kind: "cancelled"; code: number }`; `export async function resolveRun(args: string[], ctx: CommandContext): Promise<RunResolution>`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

`commands/__tests__/run-resolve.test.ts`:

```ts
import { test, expect } from "bun:test";
import { RunAborted, resolveRun } from "../run.ts";

test("RunAborted carries the exit code the picker would have used", () => {
  const e = new RunAborted(1, "cancelled");
  expect(e).toBeInstanceOf(Error);
  expect(e.code).toBe(1);
  expect(e.message).toBe("cancelled");
});

test("resolveRun with no known repos and no context resolves cancelled, never exits the process", async () => {
  // The picker chain's first gate is the repo index; with an empty index it
  // used to process.exit(1). Now it must come back as a cancellation.
  const res = await resolveRun([], { identity: undefined } as never);
  expect(res.kind).toBe("cancelled");
  if (res.kind === "cancelled") expect(res.code).toBe(1);
});
```
(The bunfig preload isolates `HOME`, so the repo index is empty under `bun test`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test commands/__tests__/run-resolve.test.ts`
Expected: FAIL (`RunAborted` / `resolveRun` not exported).

- [ ] **Step 3: Refactor `commands/run.ts`**

1. Add near the top (after the imports):
```ts
/** A picker cancellation or dead end. rt run exits with `code`; the runner treats it as "nothing chosen". */
export class RunAborted extends Error {
  constructor(public readonly code: number, message = "") {
    super(message);
    this.name = "RunAborted";
  }
}

export type RunResolution =
  | { kind: "resolved"; result: RunResolveResult }
  | { kind: "launched" }
  | { kind: "cancelled"; code: number };
```
2. Replace every `process.exit(n)` inside `selectPackageAndScript` and inside the picker chain of `runCommand` with `throw new RunAborted(n)`, keeping any `process.stderr.write` that precedes it. The sites, by their current text: `if (!pkgResult) process.exit(1);` → `throw new RunAborted(1)`; the "No scripts found" block's `process.exit(1)`; `if (!scriptResult) process.exit(1);`; `if (!varResult) process.exit(1);`; the two `if (!name) process.exit(1);` / `if (!command) process.exit(1);` in the add-variation branch; "No known repos" `process.exit(1)`; `if (knownRepos.length === 1) process.exit(0);` → `throw new RunAborted(0)`; `if (!repoResult) process.exit(1);`; `if (repoResult.key === "ctrl-up") process.exit(0);` → `throw new RunAborted(0)`; "No accessible worktrees" `process.exit(1)`; `if (!wtResult) process.exit(1);`.
3. Split `runCommand`: everything from `let worktreePath!: string;` through the `// ── Build result ──` section that assembles `result` moves into:
```ts
export async function resolveRun(args: string[], ctx: CommandContext): Promise<RunResolution> {
  try {
    // (the moved body; every early `return;` after a launch becomes `return { kind: "launched" };`)
    ...
    return { kind: "resolved", result };
  } catch (e) {
    if (e instanceof RunAborted) return { kind: "cancelled", code: e.code };
    throw e;
  }
}
```
   The `resolveOnly` flag is read by `runCommand`, not by `resolveRun`.
4. `runCommand` becomes:
```ts
export async function runCommand(args: string[], ctx: CommandContext): Promise<void> {
  const resolveOnly = args.includes("--resolve-only");
  try { ensureHistoryHook(); } catch { /* don't block on setup */ }
  const res = await resolveRun(args, ctx);
  if (res.kind === "launched") return;
  if (res.kind === "cancelled") process.exit(res.code);
  const result = res.result;
  if (resolveOnly) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  // (unchanged from here: the Running/in lines, last-run-command write, SIGINT no-op, Bun.spawn, history append, process.exit)
}
```
   The post-resolve code needs `packagePath`, `packageLabel`, `worktreePath`, `worktreeBranch`, `selectedScript`, `customCommand`, `pm`: derive them from `result` (`result.targetDir`, `result.packageLabel`, `result.worktree`, `result.branch`, `result.commandTemplate`) and keep `cmd = result.commandTemplate`. `appendRunHistory` needs `script`: add `script: string` to `RunResolveResult` (set to `selectedScript` in the resolver; `--resolve-only` consumers ignore extra fields).

- [ ] **Step 4: Run the tests and the run suite**

Run: `bun test commands/__tests__/run-resolve.test.ts && bun test commands lib/run-history* lib/variations* lib/run-presets* 2>&1 | tail -5 && bunx tsc --noEmit`
Expected: PASS; tsc 0 errors. `rt run`'s observable behavior is unchanged: the same messages, the same exit codes (now via `process.exit(res.code)` in one place).

- [ ] **Step 5: Commit**

```bash
git add commands/run.ts commands/__tests__/run-resolve.test.ts
git commit -m "run: extract resolveRun; picker dead ends throw RunAborted instead of exiting

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 6: The herdr engine over the socket

**Files:**
- Create: `lib/runner/engine.ts`, `lib/runner/__tests__/engine.test.ts`

**Interfaces:**
- Produces: `interface ProcessInfo { foregroundPgid: number | null; shellPid: number | null; foreground: { pid: number; name: string; cmdline: string | null }[] }`; `interface Engine { createWorkspace(label): Promise<{ workspaceId; tabId; paneId }>; createTab(workspaceId, label): Promise<{ tabId; paneId }>; renameTab(tabId, label): Promise<void>; focusTab(tabId): Promise<void>; run(paneId, cwd, command): Promise<void>; interrupt(paneId): Promise<void>; processInfo(paneId): Promise<ProcessInfo>; read(paneId, lines): Promise<string>; closeWorkspace(workspaceId): Promise<void> }`; `class HerdrEngine implements Engine` (constructor `(sockPath?: string)`); `export function wrapCommand(cwd, command): string`; `export class EngineError extends Error { code: string }`.
- Consumes: `herdrRequest` from `lib/herdr/client.ts`; `shellQuote` from `lib/herdr-launch.ts`.

- [ ] **Step 1: Write the failing tests**

`lib/runner/__tests__/engine.test.ts`:

```ts
import { test, expect, afterEach } from "bun:test";
import { fakeHerdr } from "../../herdr/__tests__/fake-herdr.ts";
import { HerdrEngine, EngineError, wrapCommand } from "../engine.ts";

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

function engineWith(handler: Parameters<typeof fakeHerdr>[0]) {
  const f = fakeHerdr(handler);
  stop = f.stop;
  return { engine: new HerdrEngine(f.sock), seen: f.seen };
}

test("wrapCommand cds, runs, and prints the exit sentinel", () => {
  expect(wrapCommand("/tmp/a b", "bun run dev")).toBe("cd '/tmp/a b' && bun run dev; printf '\\n__rt_exit %s\\n' $?");
});

test("createWorkspace creates unfocused and reads the root pane from the reply", async () => {
  const { engine, seen } = engineWith((method, params) => {
    if (method === "workspace.create") return { type: "workspace_created", workspace: { workspace_id: "wX", label: params.label }, tab: { tab_id: "wX:t1" }, root_pane: { pane_id: "wX:p1", tab_id: "wX:t1" } };
    throw new Error("unexpected " + method);
  });
  const ws = await engine.createWorkspace("rt-runner-a3f9");
  expect(ws).toEqual({ workspaceId: "wX", tabId: "wX:t1", paneId: "wX:p1" });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ method: "workspace.create", params: { label: "rt-runner-a3f9", focus: false } });
});

test("createWorkspace falls back to pane.list when the reply carries no root pane", async () => {
  const { engine, seen } = engineWith((method) => {
    if (method === "workspace.create") return { type: "workspace_created", workspace: { workspace_id: "wX" } };
    if (method === "pane.list") return { type: "pane_list", panes: [{ pane_id: "wX:p1", tab_id: "wX:t1", workspace_id: "wX" }] };
    throw new Error("unexpected " + method);
  });
  expect(await engine.createWorkspace("rt-runner-a3f9")).toEqual({ workspaceId: "wX", tabId: "wX:t1", paneId: "wX:p1" });
  expect(seen[1]).toMatchObject({ method: "pane.list", params: { workspace_id: "wX" } });
});

test("createTab creates unfocused and reads its root pane from the reply", async () => {
  const { engine, seen } = engineWith((method) => {
    if (method === "tab.create") return { type: "tab_created", tab: { tab_id: "wX:t2", workspace_id: "wX" }, root_pane: { pane_id: "wX:p2", tab_id: "wX:t2" } };
    throw new Error("unexpected " + method);
  });
  expect(await engine.createTab("wX", "api")).toEqual({ tabId: "wX:t2", paneId: "wX:p2" });
  expect(seen[0]).toMatchObject({ method: "tab.create", params: { workspace_id: "wX", label: "api", focus: false } });
});

test("createTab falls back to pane.list filtered by tab when the reply carries no root pane", async () => {
  const { engine } = engineWith((method) => {
    if (method === "tab.create") return { type: "tab_created", tab: { tab_id: "wX:t3", workspace_id: "wX" } };
    if (method === "pane.list") return { type: "pane_list", panes: [{ pane_id: "wX:p1", tab_id: "wX:t1" }, { pane_id: "wX:p3", tab_id: "wX:t3" }] };
    throw new Error("unexpected " + method);
  });
  expect(await engine.createTab("wX", "worker")).toEqual({ tabId: "wX:t3", paneId: "wX:p3" });
});

test("run sends the wrapped text then Enter; interrupt sends ctrl+c", async () => {
  const { engine, seen } = engineWith(() => ({ type: "ok" }));
  await engine.run("wX:p2", "/repo/web", "bun run dev");
  await engine.interrupt("wX:p2");
  expect(seen.map((s) => s.method)).toEqual(["pane.send_text", "pane.send_keys", "pane.send_keys"]);
  expect(seen[0]!.params).toEqual({ pane_id: "wX:p2", text: wrapCommand("/repo/web", "bun run dev") });
  expect(seen[1]!.params).toEqual({ pane_id: "wX:p2", keys: ["enter"] });
  expect(seen[2]!.params).toEqual({ pane_id: "wX:p2", keys: ["ctrl+c"] });
});

test("processInfo and read map the socket shapes", async () => {
  const { engine, seen } = engineWith((method) => {
    if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: "wX:p2", foreground_process_group_id: 4242, shell_pid: 4000, foreground_processes: [{ pid: 4242, name: "bun", cmdline: "bun run dev" }] } };
    if (method === "pane.read") return { type: "pane_read", read: { text: "line one\nline two\n", truncated: false } };
    throw new Error("unexpected " + method);
  });
  expect(await engine.processInfo("wX:p2")).toEqual({ foregroundPgid: 4242, shellPid: 4000, foreground: [{ pid: 4242, name: "bun", cmdline: "bun run dev" }] });
  expect(await engine.read("wX:p2", 200)).toBe("line one\nline two\n");
  expect(seen[1]!.params).toEqual({ pane_id: "wX:p2", source: "recent_unwrapped", lines: 200, strip_ansi: true, format: "text" });
});

test("a herdr error becomes an EngineError with the code and message", async () => {
  const { HerdrFakeError } = await import("../../herdr/__tests__/fake-herdr.ts");
  const { engine } = engineWith(() => new HerdrFakeError("not_found", "no such pane"));
  await expect(engine.focusTab("wX:t9")).rejects.toMatchObject({ name: "EngineError", code: "not_found", message: "no such pane" });
});

test("an unreachable socket is an EngineError too", async () => {
  const engine = new HerdrEngine("/nonexistent/herdr.sock");
  await expect(engine.closeWorkspace("wX")).rejects.toBeInstanceOf(EngineError);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/runner/__tests__/engine.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `lib/runner/engine.ts`**

```ts
/**
 * The runner's only door to herdr: the socket API, one request per
 * connection. No CLI spawns, no daemon. Every method throws EngineError on a
 * herdr error or an unreachable socket so the runner can pin the failure to
 * an entry instead of dying.
 */
import { herdrRequest, herdrSocketPath } from "../herdr/client.ts";
import { shellQuote } from "../herdr-launch.ts";

export class EngineError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "EngineError";
  }
}

export interface ProcessInfo {
  foregroundPgid: number | null;
  shellPid: number | null;
  foreground: { pid: number; name: string; cmdline: string | null }[];
}

export interface Engine {
  createWorkspace(label: string): Promise<{ workspaceId: string; tabId: string; paneId: string }>;
  createTab(workspaceId: string, label: string): Promise<{ tabId: string; paneId: string }>;
  renameTab(tabId: string, label: string): Promise<void>;
  focusTab(tabId: string): Promise<void>;
  run(paneId: string, cwd: string, command: string): Promise<void>;
  interrupt(paneId: string): Promise<void>;
  processInfo(paneId: string): Promise<ProcessInfo>;
  read(paneId: string, lines: number): Promise<string>;
  closeWorkspace(workspaceId: string): Promise<void>;
}

/** The exit sentinel is the only way to learn a pane command's exit code: process_info reports none. */
export const EXIT_SENTINEL = "__rt_exit";

export function wrapCommand(cwd: string, command: string): string {
  return `cd ${shellQuote(cwd)} && ${command}; printf '\\n${EXIT_SENTINEL} %s\\n' $?`;
}

export class HerdrEngine implements Engine {
  constructor(private readonly sockPath: string = herdrSocketPath()) {}

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await herdrRequest<T>(method, params, { sockPath: this.sockPath });
    if (!res.ok) throw new EngineError(res.code, res.message);
    return res.result;
  }

  private async paneOfTab(workspaceId: string, tabId: string): Promise<string> {
    const r = await this.call<{ panes?: { pane_id: string; tab_id: string }[] }>("pane.list", { workspace_id: workspaceId });
    const pane = (r.panes ?? []).find((p) => p.tab_id === tabId);
    if (!pane) throw new EngineError("no_pane", `tab ${tabId} has no pane`);
    return pane.pane_id;
  }

  async createWorkspace(label: string) {
    const r = await this.call<{ workspace?: { workspace_id: string }; tab?: { tab_id: string }; root_pane?: { pane_id: string; tab_id: string } }>("workspace.create", { label, focus: false });
    const workspaceId = r.workspace?.workspace_id;
    if (!workspaceId) throw new EngineError("bad_reply", "workspace.create returned no workspace_id");
    if (r.root_pane?.pane_id && r.root_pane.tab_id) {
      return { workspaceId, tabId: r.root_pane.tab_id, paneId: r.root_pane.pane_id };
    }
    const panes = await this.call<{ panes?: { pane_id: string; tab_id: string }[] }>("pane.list", { workspace_id: workspaceId });
    const first = panes.panes?.[0];
    if (!first) throw new EngineError("no_pane", `workspace ${workspaceId} has no pane`);
    return { workspaceId, tabId: first.tab_id, paneId: first.pane_id };
  }

  async createTab(workspaceId: string, label: string) {
    const r = await this.call<{ tab?: { tab_id: string }; root_pane?: { pane_id: string } }>("tab.create", { workspace_id: workspaceId, label, focus: false });
    const tabId = r.tab?.tab_id;
    if (!tabId) throw new EngineError("bad_reply", "tab.create returned no tab_id");
    if (r.root_pane?.pane_id) return { tabId, paneId: r.root_pane.pane_id };
    return { tabId, paneId: await this.paneOfTab(workspaceId, tabId) };
  }

  async renameTab(tabId: string, label: string) {
    await this.call("tab.rename", { tab_id: tabId, label });
  }

  async focusTab(tabId: string) {
    await this.call("tab.focus", { tab_id: tabId });
  }

  async run(paneId: string, cwd: string, command: string) {
    await this.call("pane.send_text", { pane_id: paneId, text: wrapCommand(cwd, command) });
    await this.call("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
  }

  async interrupt(paneId: string) {
    await this.call("pane.send_keys", { pane_id: paneId, keys: ["ctrl+c"] });
  }

  async processInfo(paneId: string): Promise<ProcessInfo> {
    const r = await this.call<{ process_info?: { foreground_process_group_id?: number | null; shell_pid?: number | null; foreground_processes?: { pid: number; name: string; cmdline?: string | null }[] } }>("pane.process_info", { pane_id: paneId });
    const p = r.process_info ?? {};
    return {
      foregroundPgid: p.foreground_process_group_id ?? null,
      shellPid: p.shell_pid ?? null,
      foreground: (p.foreground_processes ?? []).map((x) => ({ pid: x.pid, name: x.name, cmdline: x.cmdline ?? null })),
    };
  }

  async read(paneId: string, lines: number): Promise<string> {
    const r = await this.call<{ read?: { text?: string } }>("pane.read", { pane_id: paneId, source: "recent_unwrapped", lines, strip_ansi: true, format: "text" });
    return r.read?.text ?? "";
  }

  async closeWorkspace(workspaceId: string) {
    await this.call("workspace.close", { workspace_id: workspaceId });
  }
}
```

`herdrSocketPath` and `herdrRequest`'s `sockPath` option already exist in `lib/herdr/client.ts`.

- [ ] **Step 4: Run the tests**

Run: `bun test lib/runner/__tests__/engine.test.ts && bunx tsc --noEmit`
Expected: PASS (9 tests), 0 errors. If `herdrRequest`'s unreachable-socket reply comes back as `{ ok: false, code: "unreachable" }`, the last test passes as written.

- [ ] **Step 5: Commit**

```bash
git add lib/runner/engine.ts lib/runner/__tests__/engine.test.ts
git commit -m "runner: herdr engine over the socket (workspace, tabs, panes, sentinel wrap)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 7: Runner state derivation

**Files:**
- Create: `lib/runner/state.ts`, `lib/runner/__tests__/state.test.ts`

**Interfaces:**
- Produces: `interface Entry { id; name; command; cwd; pkg; repo; tabId: string | null; paneId: string | null; state: BoardState; startedAt: Date | null; exitCode: number | null; error: string | null; tail: BoardTailLine[] | null }`; `newEntry(seq: number, name, command, cwd, pkg, repo): Entry`; `isRunning(info: ProcessInfo): boolean`; `parseExitSentinel(text): number | null`; `filterTail(text): BoardTailLine[]`; `deriveState(entry, info, paneText): Pick<Entry, "state" | "exitCode">`; `toModel(workspace: string, entries: Entry[]): BoardModel`.

- [ ] **Step 1: Write the failing tests**

`lib/runner/__tests__/state.test.ts`:

```ts
import { test, expect } from "bun:test";
import { deriveState, filterTail, isRunning, newEntry, parseExitSentinel, toModel } from "../state.ts";

const info = (fg: number | null, shell: number | null) => ({ foregroundPgid: fg, shellPid: shell, foreground: [] });

test("isRunning: the foreground group differs from the shell's", () => {
  expect(isRunning(info(4242, 4000))).toBe(true);
  expect(isRunning(info(4000, 4000))).toBe(false);
  expect(isRunning(info(null, 4000))).toBe(false);
  expect(isRunning(info(4242, null))).toBe(false);
});

test("parseExitSentinel reads the last sentinel line only", () => {
  expect(parseExitSentinel("noise\n__rt_exit 0\n")).toBe(0);
  expect(parseExitSentinel("__rt_exit 1\nmore\n__rt_exit 130\n% ")).toBe(130);
  expect(parseExitSentinel("no sentinel here")).toBeNull();
});

test("filterTail drops the sentinel, trailing blanks and a trailing prompt, and stamps lines", () => {
  const lines = filterTail("VITE ready\n➜ Local: http://localhost:5173/\n__rt_exit 0\n\nmatt@mbp web % \n");
  expect(lines.map((l) => l.text)).toEqual(["VITE ready", "➜ Local: http://localhost:5173/"]);
  expect(lines[0]!.ts).toMatch(/^\d\d:\d\d:\d\d$/);
});

test("deriveState: running beats everything; stopped on 0/130; crashed otherwise; starting holds until the shell has left", () => {
  const e = newEntry(1, "dev", "bun run dev", "/repo/web", "web", "assured-dev");
  expect(deriveState({ ...e, state: "starting" }, info(4242, 4000), "")).toEqual({ state: "running", exitCode: null });
  expect(deriveState({ ...e, state: "running" }, info(4000, 4000), "x\n__rt_exit 0\n")).toEqual({ state: "stopped", exitCode: 0 });
  expect(deriveState({ ...e, state: "stopping" }, info(4000, 4000), "__rt_exit 130\n")).toEqual({ state: "stopped", exitCode: 130 });
  expect(deriveState({ ...e, state: "running" }, info(4000, 4000), "__rt_exit 1\n")).toEqual({ state: "crashed", exitCode: 1 });
  expect(deriveState({ ...e, state: "starting" }, info(4000, 4000), "")).toEqual({ state: "starting", exitCode: null });
  expect(deriveState({ ...e, state: "running" }, info(4000, 4000), "")).toEqual({ state: "stopped", exitCode: null });
});

test("toModel emits domain fields only, ISO startedAt, and tail for the one entry that has it", () => {
  const a = { ...newEntry(1, "dev", "bun run dev", "/r/web", "web", "assured-dev"), state: "running" as const, startedAt: new Date("2026-08-29T22:38:26Z"), tail: [{ ts: "22:41:07", text: "hi" }] };
  const b = newEntry(2, "api", "bun run api", "/r/api", "backend", "assured-dev");
  const m = toModel("rt-runner-a3f9", [a, b]);
  expect(m).toEqual({
    workspace: "rt-runner-a3f9",
    entries: [
      { id: "e1", name: "dev", command: "bun run dev", pkg: "web", repo: "assured-dev", state: "running", startedAt: "2026-08-29T22:38:26.000Z", exitCode: null, error: null, tail: [{ ts: "22:41:07", text: "hi" }] },
      { id: "e2", name: "api", command: "bun run api", pkg: "backend", repo: "assured-dev", state: "starting", startedAt: null, exitCode: null, error: null, tail: null },
    ],
  });
  expect(JSON.stringify(m)).not.toContain("paneId");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/runner/__tests__/state.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `lib/runner/state.ts`**

```ts
/**
 * Pure state for the runner: what an entry is, how a pane's process info and
 * text turn into a board state, and the wire model. No I/O here.
 */
import type { BoardModel, BoardState, BoardTailLine } from "../ui/protocol.ts";
import { EXIT_SENTINEL, type ProcessInfo } from "./engine.ts";

export interface Entry {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pkg: string;
  repo: string;
  tabId: string | null;
  paneId: string | null;
  state: BoardState;
  startedAt: Date | null;
  exitCode: number | null;
  error: string | null;
  tail: BoardTailLine[] | null;
}

export function newEntry(seq: number, name: string, command: string, cwd: string, pkg: string, repo: string): Entry {
  return { id: `e${seq}`, name, command, cwd, pkg, repo, tabId: null, paneId: null, state: "starting", startedAt: null, exitCode: null, error: null, tail: null };
}

/** A pane is running a command when its foreground process group is not the shell's own. */
export function isRunning(info: ProcessInfo): boolean {
  return info.foregroundPgid !== null && info.shellPid !== null && info.foregroundPgid !== info.shellPid;
}

const SENTINEL_RE = new RegExp(`^${EXIT_SENTINEL} (\\d+)\\s*$`);

export function parseExitSentinel(text: string): number | null {
  let code: number | null = null;
  for (const line of text.split("\n")) {
    const m = SENTINEL_RE.exec(line);
    if (m) code = Number(m[1]);
  }
  return code;
}

const PROMPT_RE = /[$%❯>]\s*$/;

function stamp(now: Date): string {
  return now.toTimeString().slice(0, 8);
}

export function filterTail(text: string, now: Date = new Date()): BoardTailLine[] {
  const lines = text.split("\n").filter((l) => !SENTINEL_RE.test(l));
  // The sentinel's leading newline leaves a blank above the prompt; strip
  // blanks, the prompt, then blanks again until nothing changes.
  let n = -1;
  while (n !== lines.length) {
    n = lines.length;
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    if (lines.length && PROMPT_RE.test(lines[lines.length - 1]!)) lines.pop();
  }
  const ts = stamp(now);
  return lines.map((text) => ({ ts, text }));
}

/**
 * The optimistic states hold until the pane proves otherwise: a starting
 * entry stays starting until the command owns the foreground, a stopping one
 * until the shell has it back.
 */
export function deriveState(entry: Entry, info: ProcessInfo, paneText: string): Pick<Entry, "state" | "exitCode"> {
  if (isRunning(info)) return { state: "running", exitCode: null };
  const code = parseExitSentinel(paneText);
  if (code === null) {
    if (entry.state === "starting") return { state: "starting", exitCode: null };
    return { state: "stopped", exitCode: null };
  }
  if (code === 0 || code === 130) return { state: "stopped", exitCode: code };
  return { state: "crashed", exitCode: code };
}

export function toModel(workspace: string, entries: Entry[]): BoardModel {
  return {
    workspace,
    entries: entries.map((e) => ({
      id: e.id,
      name: e.name,
      command: e.command,
      pkg: e.pkg,
      repo: e.repo,
      state: e.state,
      startedAt: e.startedAt ? e.startedAt.toISOString() : null,
      exitCode: e.exitCode,
      error: e.error,
      tail: e.tail,
    })),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test lib/runner/__tests__/state.test.ts && bunx tsc --noEmit`
Expected: PASS (5 tests), 0 errors.

- [ ] **Step 5: Commit**

```bash
git add lib/runner/state.ts lib/runner/__tests__/state.test.ts
git commit -m "runner: pure state derivation (running rule, exit sentinel, tail filter, wire model)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 8: The runner loop

**Files:**
- Create: `lib/runner/runner.ts`, `lib/runner/__tests__/runner.test.ts`

**Interfaces:**
- Produces: `interface RunnerDeps { engine: Engine; openSession: (view: string, model: unknown) => Promise<SessionHandle>; resolve: () => Promise<RunResolution>; now: () => Date; sleep: (ms: number) => Promise<void>; workspaceLabel: string }`; `class Runner { constructor(deps: RunnerDeps); run(): Promise<void>; teardown(): Promise<void>; readonly entries: Entry[] }`. `run()` resolves after the session ends and teardown ran; it never calls `process.exit`.
- Consumes: Tasks 4-7.

- [ ] **Step 1: Write the failing tests (in-memory fakes, no processes)**

`lib/runner/__tests__/runner.test.ts`:

```ts
import { test, expect } from "bun:test";
import { Runner, type RunnerDeps } from "../runner.ts";
import type { Engine, ProcessInfo } from "../engine.ts";
import type { SessionHandle } from "../../ui/spawn.ts";
import type { SessionIntent } from "../../ui/protocol.ts";
import type { RunResolution } from "../../../commands/run.ts";

class FakeEngine implements Engine {
  calls: string[] = [];
  running = new Set<string>();
  text = new Map<string, string>();
  fail: string | null = null;
  async createWorkspace(label: string) { this.calls.push(`ws:${label}`); return { workspaceId: "wX", tabId: "wX:t1", paneId: "wX:p1" }; }
  async createTab(_ws: string, label: string) { this.calls.push(`tab:${label}`); const n = this.calls.filter((c) => c.startsWith("tab:")).length + 1; return { tabId: `wX:t${n}`, paneId: `wX:p${n}` }; }
  async renameTab(tabId: string, label: string) { this.calls.push(`rename:${tabId}:${label}`); }
  async focusTab(tabId: string) { if (this.fail === "focus") throw new Error("boom"); this.calls.push(`focus:${tabId}`); }
  async run(paneId: string, _cwd: string, command: string) { this.calls.push(`run:${paneId}:${command}`); this.running.add(paneId); }
  async interrupt(paneId: string) { this.calls.push(`int:${paneId}`); this.running.delete(paneId); this.text.set(paneId, "__rt_exit 130\n"); }
  async processInfo(paneId: string): Promise<ProcessInfo> { return { foregroundPgid: this.running.has(paneId) ? 9 : 1, shellPid: 1, foreground: [] }; }
  async read(paneId: string) { return this.text.get(paneId) ?? "line a\nline b\n"; }
  async closeWorkspace(ws: string) { this.calls.push(`close:${ws}`); }
}

class FakeSession implements SessionHandle {
  pushed: unknown[] = [];
  closedCalls = 0;
  private queue: SessionIntent[];
  private resolveNext: ((v: IteratorResult<SessionIntent>) => void) | null = null;
  exited: Promise<number>;
  private finish!: (code: number) => void;
  constructor(intents: SessionIntent[]) {
    this.queue = [...intents];
    this.exited = new Promise((r) => { this.finish = r; });
  }
  get intents(): AsyncIterable<SessionIntent> {
    const self = this;
    return { [Symbol.asyncIterator]() { return { next: () => self.next() }; } };
  }
  private next(): Promise<IteratorResult<SessionIntent>> {
    const it = this.queue.shift();
    if (it) return Promise.resolve({ value: it, done: false });
    return Promise.resolve({ value: undefined as never, done: true });
  }
  push(m: unknown) { this.pushed.push(m); }
  async close() { this.closedCalls++; this.finish(0); return { reason: "closed" as const, code: 0 }; }
}

function deps(over: Partial<RunnerDeps> & { sessions: FakeSession[]; engine?: FakeEngine }): RunnerDeps & { engine: FakeEngine } {
  const engine = over.engine ?? new FakeEngine();
  let i = 0;
  return {
    engine,
    openSession: async () => over.sessions[i++] ?? new FakeSession([]),
    resolve: over.resolve ?? (async () => ({ kind: "cancelled", code: 1 }) as RunResolution),
    // A frozen clock keeps every launched entry inside LAUNCH_GRACE_MS, so
    // pollLiveness skips them; a test that asserts on a poll needs an
    // advancing `now` override.
    now: over.now ?? (() => new Date("2026-08-30T00:00:00Z")),
    sleep: async () => {},
    workspaceLabel: "rt-runner-test",
  };
}

test("quit with nothing launched: opens the session, tears nothing down, closes cleanly", async () => {
  const s = new FakeSession([{ t: "intent", name: "quit" }]);
  const d = deps({ sessions: [s] });
  await new Runner(d).run();
  expect(d.engine.calls).toEqual([]);
});

test("add: closes the session, resolves in-process, reopens with an optimistic starting row, then launches", async () => {
  const first = new FakeSession([{ t: "intent", name: "add" }]);
  const second = new FakeSession([{ t: "intent", name: "quit" }]);
  const d = deps({
    sessions: [first, second],
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
  });
  const r = new Runner(d);
  await r.run();
  expect(first.closedCalls).toBe(1);
  expect(second.pushed.length).toBeGreaterThanOrEqual(0);
  expect(r.entries.map((e) => [e.name, e.pkg, e.repo])).toEqual([["dev", "web", "repo"]]);
  expect(d.engine.calls.slice(0, 3)).toEqual(["ws:rt-runner-test", "rename:wX:t1:dev", "run:wX:p1:bun run dev"]);
  expect(d.engine.calls.at(-1)).toBe("close:wX");
});

test("a cancelled picker reopens the board unchanged", async () => {
  const first = new FakeSession([{ t: "intent", name: "add" }]);
  const second = new FakeSession([{ t: "intent", name: "quit" }]);
  const d = deps({ sessions: [first, second] });
  const r = new Runner(d);
  await r.run();
  expect(r.entries).toEqual([]);
  expect(d.engine.calls).toEqual([]);
});

test("restart on a running entry interrupts, waits for the shell, and re-runs; stop then interrupts once more", async () => {
  const s = new FakeSession([{ t: "intent", name: "add" }]);
  const s2 = new FakeSession([{ t: "intent", name: "restart", entryId: "e1" }, { t: "intent", name: "stop", entryId: "e1" }, { t: "intent", name: "quit" }]);
  const d = deps({
    sessions: [s, s2],
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
  });
  const r = new Runner(d);
  await r.run();
  const e = r.entries[0]!;
  expect(d.engine.calls.filter((c) => c.startsWith("int:"))).toHaveLength(2);
  expect(d.engine.calls.filter((c) => c.startsWith("run:"))).toHaveLength(2);
  expect(e.state).toBe("stopping");
});

test("restart on a stopped entry skips the interrupt and just re-runs", async () => {
  const s = new FakeSession([{ t: "intent", name: "add" }]);
  const s2 = new FakeSession([{ t: "intent", name: "stop", entryId: "e1" }, { t: "intent", name: "restart", entryId: "e1" }, { t: "intent", name: "quit" }]);
  const d = deps({
    sessions: [s, s2],
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
  });
  const r = new Runner(d);
  await r.run();
  expect(d.engine.calls.filter((c) => c.startsWith("int:"))).toHaveLength(1);
  expect(d.engine.calls.filter((c) => c.startsWith("run:"))).toHaveLength(2);
  expect(r.entries[0]!.state).toBe("starting");
});

test("focus failure pins an error on the entry and the board stays up", async () => {
  const s = new FakeSession([{ t: "intent", name: "add" }]);
  const s2 = new FakeSession([{ t: "intent", name: "focus", entryId: "e1" }, { t: "intent", name: "quit" }]);
  const engine = new FakeEngine();
  engine.fail = "focus";
  const d = deps({ sessions: [s, s2], engine, resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }) });
  const r = new Runner(d);
  await r.run();
  expect(r.entries[0]!.error).toContain("boom");
});

test("tail intent reads immediately and pushes a model with tail for that entry only", async () => {
  const s = new FakeSession([{ t: "intent", name: "add" }]);
  const s2 = new FakeSession([{ t: "intent", name: "tail", entryId: "e1", open: true }, { t: "intent", name: "quit" }]);
  const d = deps({ sessions: [s, s2], resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }) });
  await new Runner(d).run();
  const withTail = s2.pushed.find((m) => (m as { entries: { tail: unknown }[] }).entries[0]?.tail);
  expect(withTail).toBeDefined();
  expect((withTail as { entries: { tail: { text: string }[] }[] }).entries[0]!.tail.map((l) => l.text)).toEqual(["line a", "line b"]);
});

test("a session that ends with reason error is treated as died", async () => {
  class Errored extends FakeSession {
    async close() { this.closedCalls++; return { reason: "error" as const, code: 70, message: "stdin closed" }; }
  }
  const s = new Errored([]);
  const d = deps({ sessions: [s] });
  await expect(new Runner(d).run()).rejects.toThrow(/rt-ui/);
});

test("a picker that throws reopens the board unchanged and warns", async () => {
  const first = new FakeSession([{ t: "intent", name: "add" }]);
  const second = new FakeSession([{ t: "intent", name: "quit" }]);
  const errs: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((c: string | Uint8Array) => { errs.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    const d = deps({ sessions: [first, second], resolve: async () => { throw new Error("picker exploded"); } });
    const r = new Runner(d);
    await r.run();
    expect(r.entries).toEqual([]);
  } finally {
    process.stderr.write = real;
  }
  expect(errs.join("")).toContain("picker exploded");
});

test("a session that dies tears the workspace down", async () => {
  class Dying extends FakeSession {
    async close() { this.closedCalls++; return { reason: "died" as const, code: 70 }; }
  }
  const s = new FakeSession([{ t: "intent", name: "add" }]);
  const s2 = new Dying([]);
  const d = deps({ sessions: [s, s2], resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }) });
  const r = new Runner(d);
  await expect(r.run()).rejects.toThrow(/rt-ui/);
  expect(d.engine.calls.at(-1)).toBe("close:wX");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/runner/__tests__/runner.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `lib/runner/runner.ts`**

```ts
/**
 * The runner's brain. Owns every entry, every herdr call, and the poll
 * timers; the view owns nothing but pixels. Every dependency is injected so
 * the loop runs under test with no herdr, no rt-ui, and no clock.
 */
import { basename } from "path";
import type { RunResolution } from "../../commands/run.ts";
import type { SessionHandle } from "../ui/spawn.ts";
import type { SessionIntent } from "../ui/protocol.ts";
import { EngineError, type Engine } from "./engine.ts";
import { deriveState, filterTail, isRunning, newEntry, toModel, type Entry } from "./state.ts";

export interface RunnerDeps {
  engine: Engine;
  openSession: (view: string, model: unknown) => Promise<SessionHandle>;
  resolve: () => Promise<RunResolution>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  workspaceLabel: string;
}

const LIVENESS_MS = 1500;
const TAIL_MS = 1000;
const TAIL_LINES = 200;
const RESTART_WAIT_MS = 5000;
const LAUNCH_GRACE_MS = 500;

export class SessionDied extends Error {
  constructor(code: number) {
    super(`rt-ui session died (exit ${code})`);
    this.name = "SessionDied";
  }
}

export class Runner {
  readonly entries: Entry[] = [];
  private workspaceId: string | null = null;
  private seq = 0;
  private session: SessionHandle | null = null;
  private tailFor: string | null = null;
  private lastPushed = "";
  private timers: ReturnType<typeof setInterval>[] = [];
  private tornDown = false;

  constructor(private readonly deps: RunnerDeps) {}

  async run(): Promise<void> {
    try {
      await this.openBoard();
      while (this.session) {
        const s = this.session;
        for await (const intent of s.intents) {
          const again = await this.handle(intent);
          if (again === "reopen") break;
          if (again === "done") {
            await this.closeSession(s);
            return;
          }
        }
        if (this.session === s) {
          const end = await this.closeSession(s);
          if (end.reason === "quit" || end.reason === "closed") return;
        }
      }
    } finally {
      await this.teardown();
    }
  }

  // died and error are the same thing to the runner: the view is gone for a
  // reason that was not ours, so the board ends with a message, not silently.
  private async closeSession(s: SessionHandle) {
    this.stopTimers();
    const end = await s.close();
    this.session = null;
    if (end.reason === "died" || end.reason === "error") throw new SessionDied(end.code);
    return end;
  }

  private async openBoard(): Promise<void> {
    this.session = await this.deps.openSession("board", this.model());
    this.lastPushed = JSON.stringify(this.model());
    this.startTimers();
  }

  private model() {
    return toModel(this.deps.workspaceLabel, this.entries);
  }

  private push(): void {
    if (!this.session) return;
    const m = this.model();
    const json = JSON.stringify(m);
    if (json === this.lastPushed) return;
    this.lastPushed = json;
    this.session.push(m);
  }

  private startTimers(): void {
    this.timers.push(setInterval(() => void this.pollLiveness(), LIVENESS_MS));
    this.timers.push(setInterval(() => void this.pollTail(), TAIL_MS));
  }

  private stopTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private async handle(intent: SessionIntent): Promise<"reopen" | "done" | "continue"> {
    switch (intent.name) {
      case "quit":
        return "done";
      case "add":
        await this.add();
        return "reopen";
      case "stop":
        await this.stop(intent.entryId);
        break;
      case "restart":
        await this.restart(intent.entryId);
        break;
      case "focus":
        await this.focus(intent.entryId);
        break;
      case "tail":
        this.tailFor = intent.open ? intent.entryId ?? null : null;
        for (const e of this.entries) if (e.id !== this.tailFor) e.tail = null;
        await this.pollTail();
        break;
    }
    this.push();
    return "continue";
  }

  private find(id: string | undefined): Entry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  private pin(e: Entry, err: unknown): void {
    e.error = err instanceof EngineError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
  }

  private async add(): Promise<void> {
    const s = this.session;
    if (!s) return;
    await this.closeSession(s);

    // The picker runs in this process with the terminal to itself. A
    // "launched" result means the user picked a preset or queue, which
    // rt run launched into their own herdr panes; the board reopens
    // unchanged either way, as it does when the picker throws.
    let res: RunResolution;
    try {
      res = await this.deps.resolve();
    } catch (err) {
      process.stderr.write(`  rt runner: picker failed (${err instanceof Error ? err.message : String(err)})\n`);
      await this.openBoard();
      return;
    }
    if (res.kind !== "resolved") {
      await this.openBoard();
      return;
    }
    const r = res.result;
    const entry = newEntry(++this.seq, r.script || basename(r.targetDir), r.commandTemplate, r.targetDir, r.packageLabel, basename(r.worktree));
    this.entries.push(entry);
    await this.openBoard();
    await this.launch(entry);
    this.push();
  }

  private async launch(entry: Entry): Promise<void> {
    try {
      if (!this.workspaceId) {
        const ws = await this.deps.engine.createWorkspace(this.deps.workspaceLabel);
        this.workspaceId = ws.workspaceId;
        await this.deps.engine.renameTab(ws.tabId, entry.name);
        entry.tabId = ws.tabId;
        entry.paneId = ws.paneId;
      } else {
        const tab = await this.deps.engine.createTab(this.workspaceId, entry.name);
        entry.tabId = tab.tabId;
        entry.paneId = tab.paneId;
      }
      await this.deps.engine.run(entry.paneId, entry.cwd, entry.command);
      entry.startedAt = this.deps.now();
      entry.state = "starting";
    } catch (err) {
      this.pin(entry, err);
      entry.state = "crashed";
    }
  }

  private async stop(id: string | undefined): Promise<void> {
    const e = this.find(id);
    if (!e?.paneId) return;
    e.state = "stopping";
    try {
      await this.deps.engine.interrupt(e.paneId);
    } catch (err) {
      this.pin(e, err);
    }
  }

  private async restart(id: string | undefined): Promise<void> {
    const e = this.find(id);
    if (!e?.paneId) return;
    e.state = "starting";
    e.error = null;
    try {
      if (isRunning(await this.deps.engine.processInfo(e.paneId))) {
        await this.deps.engine.interrupt(e.paneId);
        const until = this.deps.now().getTime() + RESTART_WAIT_MS;
        while (isRunning(await this.deps.engine.processInfo(e.paneId))) {
          if (this.deps.now().getTime() >= until) {
            e.error = "did not stop";
            e.state = "running";
            return;
          }
          await this.deps.sleep(150);
        }
      }
      await this.deps.engine.run(e.paneId, e.cwd, e.command);
      e.startedAt = this.deps.now();
      e.exitCode = null;
    } catch (err) {
      this.pin(e, err);
    }
  }

  private async focus(id: string | undefined): Promise<void> {
    const e = this.find(id);
    if (!e?.tabId) return;
    try {
      await this.deps.engine.focusTab(e.tabId);
    } catch (err) {
      this.pin(e, err);
    }
  }

  private async pollLiveness(): Promise<void> {
    if (!this.session) return;
    for (const e of this.entries) {
      if (!e.paneId) continue;
      // The previous run's exit sentinel is still in the pane text until the
      // shell forks the new command; give a fresh launch a moment before
      // reading the sentinel as this run's verdict.
      if (e.startedAt && this.deps.now().getTime() - e.startedAt.getTime() < LAUNCH_GRACE_MS) continue;
      try {
        const info = await this.deps.engine.processInfo(e.paneId);
        const text = isRunning(info) ? "" : await this.deps.engine.read(e.paneId, 50);
        const next = deriveState(e, info, text);
        e.state = next.state;
        e.exitCode = next.exitCode;
      } catch (err) {
        this.pin(e, err);
      }
    }
    this.push();
  }

  private async pollTail(): Promise<void> {
    if (!this.session || !this.tailFor) return;
    const e = this.find(this.tailFor);
    if (!e?.paneId) return;
    try {
      e.tail = filterTail(await this.deps.engine.read(e.paneId, TAIL_LINES), this.deps.now());
    } catch (err) {
      this.pin(e, err);
    }
    this.push();
  }

  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    this.stopTimers();
    if (this.workspaceId) {
      try {
        await this.deps.engine.closeWorkspace(this.workspaceId);
      } catch {
        /* herdr already gone: nothing left to close */
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test lib/runner/__tests__/runner.test.ts && bunx tsc --noEmit`
Expected: PASS (10 tests), 0 errors. The intents loop in `run()` is written so a `quit` closes and returns, an `add` breaks out to reopen, and a stream that ends without `quit` (a died child) closes and either returns or throws `SessionDied`; if a test hangs, the `FakeSession.next()` is returning `done: false` with no value. The restart tests rely on `FakeEngine`'s `running` set: `run` adds the pane, `interrupt` removes it, so `restart` on a running entry sees `isRunning` true once and then false.

- [ ] **Step 5: Commit**

```bash
git add lib/runner/runner.ts lib/runner/__tests__/runner.test.ts
git commit -m "runner: the intent loop (add via resolveRun, stop/restart/focus/tail, polls, teardown)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 9: `rt runner` command, wiring, docs

**Files:**
- Create: `commands/runner.ts`, `commands/__tests__/runner-command.test.ts`
- Modify: `lib/command-tree-def.ts`, `lib/module-registry.ts`, `CLAUDE.md`, `website/docs/reference/` (regenerated)

**Interfaces:**
- Produces: `runnerCommand(args: string[], ctx: CommandContext): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`commands/__tests__/runner-command.test.ts`:

```ts
import { test, expect, afterEach } from "bun:test";
import { __test__ as gate } from "../../lib/ui/gate.ts";
import { __test__ as spawnTest } from "../../lib/ui/spawn.ts";
import { runnerCommand } from "../runner.ts";

afterEach(() => {
  gate.setInteractive(undefined);
  spawnTest.setExit(undefined);
  delete process.env.HERDR_SOCKET_PATH;
});

test("off a TTY the command prints one line and exits 1 without touching herdr", async () => {
  gate.setInteractive(() => false);
  const exits: number[] = [];
  spawnTest.setExit((code) => { exits.push(code); throw new Error(`exit ${code}`); });
  const errs: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((c: string | Uint8Array) => { errs.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    await expect(runnerCommand([], {} as never)).rejects.toThrow("exit 1");
  } finally {
    process.stderr.write = real;
  }
  expect(exits).toEqual([1]);
  expect(errs.join("")).toContain("interactive terminal");
});

test("with herdr unreachable the command names the socket and exits 1", async () => {
  gate.setInteractive(() => true);
  process.env.HERDR_SOCKET_PATH = "/nonexistent/herdr.sock";
  const exits: number[] = [];
  spawnTest.setExit((code) => { exits.push(code); throw new Error(`exit ${code}`); });
  const errs: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((c: string | Uint8Array) => { errs.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    await expect(runnerCommand([], {} as never)).rejects.toThrow("exit 1");
  } finally {
    process.stderr.write = real;
  }
  expect(errs.join("")).toContain("/nonexistent/herdr.sock");
  expect(exits).toEqual([1]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test commands/__tests__/runner-command.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write `commands/runner.ts`**

```ts
/**
 * rt runner: a board of headless herdr panes. The command is the gate and
 * the wiring; the loop lives in lib/runner/runner.ts and the herdr calls in
 * lib/runner/engine.ts.
 */
import { randomBytes } from "crypto";
import type { CommandContext } from "../lib/command-tree.ts";
import { herdrAvailable, herdrSocketPath } from "../lib/herdr/client.ts";
import { HerdrEngine } from "../lib/runner/engine.ts";
import { Runner, SessionDied } from "../lib/runner/runner.ts";
import { interactive } from "../lib/ui/gate.ts";
import { exit, openSession } from "../lib/ui/spawn.ts";
import { resolveRun } from "./run.ts";

export async function runnerCommand(args: string[], ctx: CommandContext): Promise<void> {
  if (!interactive()) {
    process.stderr.write("rt runner needs an interactive terminal (it drives herdr panes from the one you are in)\n");
    return exit(1);
  }
  const sock = herdrSocketPath();
  if (!(await herdrAvailable(sock))) {
    process.stderr.write(`herdr is not answering at ${sock}; start herdr and run rt runner from one of its panes\n`);
    return exit(1);
  }

  const runner = new Runner({
    engine: new HerdrEngine(sock),
    openSession,
    resolve: () => resolveRun(args.filter((a) => a !== "--resolve-only"), ctx),
    now: () => new Date(),
    sleep: (ms) => Bun.sleep(ms),
    workspaceLabel: `rt-runner-${randomBytes(2).toString("hex")}`,
  });

  // The board dies with this process: a signal tears the workspace down
  // before exit so no headless pane outlives its board.
  const onSignal = () => {
    void runner.teardown().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await runner.run();
  } catch (err) {
    if (err instanceof SessionDied) {
      process.stderr.write(`\n  ${err.message}; the workspace was closed\n\n`);
      return exit(1);
    }
    throw err;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
```

- [ ] **Step 4: Wire the command**

In `lib/command-tree-def.ts`, after the `run` node add:

```ts
  runner: {
    description: "Board of long-running commands in headless herdr panes (add, tail, restart, stop, focus)",
    module: "./commands/runner.ts",
    fn: "runnerCommand",
    context: "worktree",
    requiresTTY: true,
    fullscreen: true,
    args: [],
  },
```
(`context: "worktree"` makes the dispatcher resolve the repo the way `rt run` does, so the add flow's picker starts at the package step when run from inside a repo; verify the field name against the `run` node.)

In `lib/module-registry.ts` add `"./commands/runner.ts": () => import("../commands/runner.ts"),` beside the `run.ts` line.

In `CLAUDE.md`'s `## rt-ui` section, append one paragraph:

```markdown
`rt runner` is the first `session` view: `commands/runner.ts` gates and
wires, `lib/runner/runner.ts` owns the entries and the intent loop,
`lib/runner/engine.ts` is the only herdr door (socket API, no CLI spawns),
and `ui/internal/views/board/` paints. Read
`docs/superpowers/specs/2026-08-29-rt-runner-design.md` before touching any
of them: the board is ephemeral and pane-owned (quit closes the workspace),
the exit code of a pane command comes only from the `__rt_exit` sentinel,
and the add flow closes and reopens the session around the fzf picker.
```

- [ ] **Step 5: Regenerate docs and run every gate**

Run: `bun run docs:gen && bun test commands/__tests__/runner-command.test.ts && bunx tsc --noEmit && bun test lib commands packages scripts && bun run docs:check && bun run picker:check && cd ui && go vet ./... && go test ./... -count=1`
Expected: all green; a new `website/docs/reference/runner.mdx` appears. `picker:check` passes because the node has no required positional.

- [ ] **Step 6: Commit**

```bash
git add commands/runner.ts commands/__tests__/runner-command.test.ts lib/command-tree-def.ts lib/module-registry.ts CLAUDE.md website/docs/reference
git commit -m "add rt runner: board of headless herdr panes on the rt-ui session verb

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 10: Live smoke against a real herdr (manual, documented)

**Files:**
- Create: `docs/runner-smoke.md`

This task runs only with the developer present, from a herdr pane, and is the one place the plan touches the live herdr; it is not a CI gate.

- [ ] **Step 1: Write the checklist `docs/runner-smoke.md`**

```markdown
# rt runner smoke

Run from a herdr pane, on a source checkout with `bun run ui:build` done.

1. `bun run cli.ts runner` in a repo with package scripts. Expect the empty
   board (`Nothing running.`) on the alt screen, keybar at the bottom.
2. `a`: the board drops to the normal screen, the `rt run` picker appears;
   pick a dev server. Expect the board back within a blink with the row
   `starting`, flipping to `running` inside 2 s and the uptime ticking
   every second without skips.
3. `t`: the tail box opens and refreshes each second; `j`/`k` with it open
   re-targets the tail immediately. `t` again closes it.
4. `x`: the row spins `stopping`, then shows `stopped`; `s`: `starting`,
   then `running` with uptime reset. `f`: herdr focuses the pane; come back.
5. Add a second command with `a`; the header counts update.
6. `q`: the y/n layer; `n` keeps it; `q` then `y` closes the board and the
   whole `rt-runner-<id>` workspace disappears from herdr.
7. Reopen the board, add one, then `kill -TERM` the rt process from another
   pane: the terminal must come back cooked and the workspace must be gone.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runner-smoke.md
git commit -m "docs: rt runner live smoke checklist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage (runner spec + the bridge spec's `session` section):**
- Session protocol (hello first, open/model/close, intents, closed, exit table): Task 2 (`session.Run`, `ExitCode`), tested per row (closed 0, quit 0, EOF 70, signal 130, bad open 2).
- Board model, intents, keys, tail semantics, quit layer, uptime derived in Go, cursor by id: Task 3 (`board.go`, `render.go`, tests for each key, reorder, empty state).
- Add flow (close, in-process resolve, reopen with optimistic row, then launch; cancelled reopens unchanged): Tasks 5 (`resolveRun`, `RunAborted`) and 8 (`Runner.add`).
- Engine over the socket with the verified shapes, `root_pane` from the create replies with `pane.list` as the fallback, wrapped command, ctrl+c, sentinel read: Task 6.
- State rules (running via pgid vs shell, sentinel 0/130 → stopped, else crashed, optimistic holds; tail filter incl. sentinel and prompt line): Task 7.
- Polling (1.5 s liveness, 1 s tail, push on change only, gated on an open session; immediate read on tail intent): Task 8.
- Restart waits for the shell (5 s) then re-runs; `did not stop` error: Task 8.
- Die with the TUI (teardown on quit, on session death, on SIGINT/SIGTERM): Tasks 8 and 9.
- Gate (`interactive()`), herdr probe naming the socket, no daemon: Task 9.
- Wiring (`runner` node with `fullscreen`/`requiresTTY`, registry, docs, CLAUDE.md): Task 9.
- Error handling table: herdr down → probe; herdr call fails → entry error (`pin`); resolve null → reopen unchanged; session dies → teardown + message + exit 1: Tasks 8 and 9.
- Live verification: Task 10 (manual, since tests never touch the developer's herdr).

**Placeholder scan:** none. Task 1 Step 6's `fixture`/`FIXTURES` helpers exist in the target test file from phase 1. Every fixture sent down the wire in a Go test goes through `fixtureLine` (compacted), since the pretty-printed fixtures span several lines. `openSession`'s single eager stdout reader records `closed` even when the consumer has stopped pulling (a `quit` is usually the last intent read), and `close()` awaits both the child and the reader before ending stdin; the Go reader goroutine returns on a `close` line so the parent's later EOF can never be read as a dead parent.

**Type consistency:** `protocol.Intent{Name, EntryID, Open}` (Task 1) is what `board.go` emits (Task 3) and `parseSessionLine` reads (Task 1 TS). `session.View{SetModel, Reason}` (Task 2) is what `board.New` implements (Task 3). `SessionHandle{intents, push, close, exited}` (Task 4) is what `Runner` consumes (Task 8) and `FakeSession` implements. `Engine`/`ProcessInfo` (Task 6) are what `state.ts` (Task 7) and `runner.ts` (Task 8) use. `RunResolution` (Task 5) is `Runner.deps.resolve`'s return (Task 8) and `runnerCommand` wires `resolveRun` to it (Task 9). `RunResolveResult` gains `script` in Task 5 and Task 8 reads it.
