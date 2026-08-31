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
	for _, want := range []string{"rt runner", "rt-runner-a3f9", "1 running", "1 crashed", "dev", "bun run dev", "web · acme", "worker", "exited 1", "navigate", "process", "q quit", "o open"} {
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

func TestOpenKeyEmitsIntentOnlyWhenEntryHasUrl(t *testing.T) {
	s := open(t)
	// e1 (selected by default) carries url http://localhost:3000 in the fixture.
	s.Type("o")
	l, ok := s.ReadLine(2 * time.Second)
	if !ok || !strings.Contains(l, `"name":"open"`) || !strings.Contains(l, `"entryId":"e1"`) {
		t.Fatalf("open intent: %q", l)
	}
	s.Type("j")
	time.Sleep(50 * time.Millisecond)
	// e2 has no url; o must be a no-op.
	s.Type("o")
	if l, ok := s.ReadLine(200 * time.Millisecond); ok {
		t.Fatalf("o with no url must not emit: %q", l)
	}
	s.Send(`{"t":"close"}`)
	s.Wait()
}

func TestRowShowsHostPortWhenUrlDetected(t *testing.T) {
	s := open(t)
	// e1 carries url http://localhost:3000 in the fixture.
	if !strings.Contains(s.Screen(), "localhost:3000") {
		t.Fatalf("row url missing:\n%s", s.Screen())
	}
	s.Send(`{"t":"close"}`)
	s.Wait()
}

func TestTailHeaderShowsNoneFoundWhenUrlGivesUp(t *testing.T) {
	s := testutil.StartSession(t, []string{testutil.Binary(t), "session", "--view", "board"}, nil)
	s.ReadLine(2 * time.Second)
	old := time.Now().Add(-40 * time.Second).UTC().Format(time.RFC3339)
	model := `{"t":"open","view":"board","model":{"workspace":"rt-runner-a3f9","entries":[` +
		`{"id":"e1","name":"dev","command":"bun run dev","pkg":"web","repo":"acme","state":"running","startedAt":"` + old + `","exitCode":null,"error":null,"url":null,"tail":null}]}}`
	s.Send(model)
	s.WaitForPaint("rt runner")
	s.Type("t")
	s.WaitForPaint("tail · dev")
	if !strings.Contains(s.Screen(), "none found") {
		t.Fatalf("tail header missing none found:\n%s", s.Screen())
	}
	s.Send(`{"t":"close"}`)
	s.Wait()
}

func TestTailHeaderShowsDetectingWhenUrlPending(t *testing.T) {
	s := testutil.StartSession(t, []string{testutil.Binary(t), "session", "--view", "board"}, nil)
	s.ReadLine(2 * time.Second)
	recent := time.Now().Add(-5 * time.Second).UTC().Format(time.RFC3339)
	model := `{"t":"open","view":"board","model":{"workspace":"rt-runner-a3f9","entries":[` +
		`{"id":"e1","name":"dev","command":"bun run dev","pkg":"web","repo":"acme","state":"running","startedAt":"` + recent + `","exitCode":null,"error":null,"url":null,"tail":null}]}}`
	s.Send(model)
	s.WaitForPaint("rt runner")
	s.Type("t")
	s.WaitForPaint("tail · dev")
	if !strings.Contains(s.Screen(), "detecting") {
		t.Fatalf("tail header missing detecting:\n%s", s.Screen())
	}
	s.Send(`{"t":"close"}`)
	s.Wait()
}

// TestTailHeaderShowsNoLinkTextForATerminalEntryWithNoUrl locks in that a
// stopped/crashed entry that never found a url gets no link status at all,
// not the "detecting…"/"none found" text reserved for running/starting.
func TestTailHeaderShowsNoLinkTextForATerminalEntryWithNoUrl(t *testing.T) {
	s := testutil.StartSession(t, []string{testutil.Binary(t), "session", "--view", "board"}, nil)
	s.ReadLine(2 * time.Second)
	model := `{"t":"open","view":"board","model":{"workspace":"rt-runner-a3f9","entries":[` +
		`{"id":"e1","name":"dev","command":"bun run dev","pkg":"web","repo":"acme","state":"stopped","startedAt":null,"exitCode":0,"error":null,"url":null,"tail":null}]}}`
	s.Send(model)
	s.WaitForPaint("rt runner")
	s.Type("t")
	s.WaitForPaint("tail · dev")
	screen := s.Screen()
	for _, absent := range []string{"detecting", "none found", "link:"} {
		if strings.Contains(screen, absent) {
			t.Fatalf("stopped entry with no url must show no link text, found %q in:\n%s", absent, screen)
		}
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

// TestQuitConfirmsWhenOnlyStartingEntryExists locks in the widened gate: a
// launching entry is still active work, so it must confirm same as running.
func TestQuitConfirmsWhenOnlyStartingEntryExists(t *testing.T) {
	s := testutil.StartSession(t, []string{testutil.Binary(t), "session", "--view", "board"}, nil)
	s.ReadLine(2 * time.Second)
	startingOnly := `{"t":"open","view":"board","model":{"workspace":"rt-runner-a3f9","entries":[` +
		`{"id":"e1","name":"dev","command":"bun run dev","pkg":"web","repo":"acme","state":"starting","startedAt":null,"exitCode":null,"error":null,"tail":null}]}}`
	s.Send(startingOnly)
	s.WaitForPaint("rt runner")
	s.Type("q")
	s.WaitForPaint("Quit and stop")
	if l, ok := s.ReadLine(100 * time.Millisecond); ok {
		t.Fatalf("q against a starting-only board must not emit yet: %q", l)
	}
	s.Type("y")
	l, _ := s.ReadLine(2 * time.Second)
	if !strings.Contains(l, `"name":"quit"`) {
		t.Fatalf("quit intent: %q", l)
	}
	if exit := s.Wait(); exit != 0 {
		t.Fatalf("exit %d", exit)
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

// TestCrashedRowWithNilExitCodeShowsCrashedNotExitedZero locks in that a
// crashed entry launched without ever reaching a process (ExitCode nil)
// renders "crashed", not the misleading "exited 0".
func TestCrashedRowWithNilExitCodeShowsCrashedNotExitedZero(t *testing.T) {
	s := testutil.StartSession(t, []string{testutil.Binary(t), "session", "--view", "board"}, nil)
	s.ReadLine(2 * time.Second)
	crashedNoExit := `{"t":"open","view":"board","model":{"workspace":"rt-runner-a3f9","entries":[` +
		`{"id":"e1","name":"dev","command":"bun run dev","pkg":"web","repo":"acme","state":"crashed","startedAt":null,"exitCode":null,"error":null,"tail":null}]}}`
	s.Send(crashedNoExit)
	s.WaitForPaint("rt runner")
	screen := s.Screen()
	if !strings.Contains(screen, "crashed") {
		t.Fatalf("missing %q in\n%s", "crashed", screen)
	}
	if strings.Contains(screen, "exited 0") {
		t.Fatalf("nil exitCode must not render as \"exited 0\":\n%s", screen)
	}
	s.Send(`{"t":"close"}`)
	s.Wait()
}

const (
	keyEnter = "\r"
	keyEsc   = "\x1b"
)

func TestEditKeyEntersEditModeSeededWithTheCurrentCommand(t *testing.T) {
	s := open(t)
	s.Type("e")
	s.WaitForPaint("save")
	if !strings.Contains(s.Screen(), "bun run dev") {
		t.Fatalf("edit bar missing seeded command:\n%s", s.Screen())
	}
	s.Type(keyEsc)
	s.WaitForGone("save")
	s.Send(`{"t":"close"}`)
	s.Wait()
}

func TestEditEnterEmitsEditIntentWithTheNewCommand(t *testing.T) {
	s := open(t)
	s.Type("e")
	s.WaitForPaint("save")
	s.Type("2")
	s.Type(keyEnter)
	l, ok := s.ReadLine(2 * time.Second)
	if !ok || !strings.Contains(l, `"name":"edit"`) || !strings.Contains(l, `"entryId":"e1"`) || !strings.Contains(l, `"command":"bun run dev2"`) {
		t.Fatalf("edit intent: %q", l)
	}
	s.Send(`{"t":"close"}`)
	s.Wait()
}

func TestEditEscCancelsWithoutEmittingAnIntent(t *testing.T) {
	s := open(t)
	s.Type("e")
	s.WaitForPaint("save")
	s.Type("2")
	s.Type(keyEsc)
	s.WaitForGone("save")
	if l, ok := s.ReadLine(200 * time.Millisecond); ok {
		t.Fatalf("esc must not emit an edit intent: %q", l)
	}
	s.Send(`{"t":"close"}`)
	s.Wait()
}

func TestModelReplacementKeepsCursorByIdAndUptimeTicks(t *testing.T) {
	s := open(t)
	s.Type("j")
	// The reorder below races the keypress unless the cursor has visibly
	// moved: if the model lands first the cursor never left e1, and the
	// test then reads e1 back and reports it as a cursor that failed to
	// follow. Waiting on the selected-row marker is the synchronisation the
	// two other j-pressing tests approximate with a fixed sleep.
	s.WaitForPaint("\u258c \u2717  worker")
	reordered := `{"t":"model","model":{"workspace":"rt-runner-a3f9","entries":[` +
		`{"id":"e2","name":"worker","command":"bun run worker","pkg":"backend","repo":"acme","state":"starting","startedAt":null,"exitCode":null,"error":null,"tail":null},` +
		`{"id":"e1","name":"dev","command":"bun run dev","pkg":"web","repo":"acme","state":"running","startedAt":"` + time.Now().Add(-125*time.Second).UTC().Format(time.RFC3339) + `","exitCode":null,"error":null,"tail":null}]}}`
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
