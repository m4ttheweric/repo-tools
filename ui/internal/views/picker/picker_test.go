package picker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"rt-ui/internal/protocol"
	"rt-ui/internal/theme"
)

// mustNotQuit fails t if cmd is the program's own quit signal. A non-nil cmd
// no longer means "the session is ending" on its own -- an overlay
// open/close now rides a tea.ClearScreen cmd while staying open -- so every
// "must not end the session" assertion has to check the cmd's actual kind,
// not merely whether one was returned.
func mustNotQuit(t *testing.T, cmd tea.Cmd) {
	t.Helper()
	if isQuitCmd(cmd) {
		t.Fatal("expected the session to stay open, got a quit cmd")
	}
}

func TestDownThenEnterSelectsTheSecondRow(t *testing.T) {
	req := protocol.PickRequest{
		T:        "pick",
		Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{Value: "a"},
			{Value: "b"},
		},
	}
	m := New(req)

	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	m = next.(*Model)
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(*Model)

	if m.result == nil {
		t.Fatal("no result produced")
	}
	if m.result.Action != "select" || m.result.Value == nil || *m.result.Value != "b" || m.result.Query != "" {
		t.Fatalf("got %+v", m.result)
	}
}

// TestTypedRuneInputAndBackspaceFilterAtTheKeyDecodeSeam is the regression
// guard for the seam every other filter test bypassed: those all seed
// InitialQuery and never drive typing through Update at all. This one
// feeds tea.KeyPressMsg values the way bubbletea's own decoder actually
// delivers them -- a printable key carries the rune in both Code and
// Text (ultraviolet's decoder.go: "KeyPressEvent{Code: code, Text:
// string(code)}"), while backspace carries only a Code and an empty
// Text -- so it exercises the msg.Text branch a msg.String()-only test
// would never reach.
func TestTypedRuneInputAndBackspaceFilterAtTheKeyDecodeSeam(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{Value: "bin", Left: []protocol.PickSegment{{Text: "bin", Tone: "text"}}},
			{Value: "bill", Left: []protocol.PickSegment{{Text: "bill", Tone: "text"}}},
			{Value: "other", Left: []protocol.PickSegment{{Text: "other", Tone: "text"}}},
		},
	}
	m := New(req)
	if len(m.matches) != 3 {
		t.Fatalf("want all 3 rows to match the empty query, got %d", len(m.matches))
	}
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	m = next.(*Model)
	if m.cursor != 1 {
		t.Fatalf("setup: cursor should be 1 before typing, got %d", m.cursor)
	}

	typeRune := func(r rune) {
		next, _ := m.Update(tea.KeyPressMsg{Code: r, Text: string(r)})
		m = next.(*Model)
	}
	typeRune('b')
	typeRune('i')
	typeRune('l')

	if m.query != "bil" {
		t.Fatalf("query = %q, want %q", m.query, "bil")
	}
	if m.cursor != 0 {
		t.Fatalf("typing must rebind the cursor to the top, got cursor=%d", m.cursor)
	}
	if len(m.matches) != 1 {
		t.Fatalf("typing %q should narrow to the one row containing it in order, got %d matches: %+v", "bil", len(m.matches), m.matches)
	}
	if got := m.req.Rows[m.matches[0].Index].Value; got != "bill" {
		t.Fatalf("the surviving match should be %q, got %q", "bill", got)
	}

	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyBackspace})
	m = next.(*Model)

	if m.query != "bi" {
		t.Fatalf("backspace should drop the last rune: query = %q, want %q", m.query, "bi")
	}
	if m.cursor != 0 {
		t.Fatalf("backspace must also rebind the cursor to the top, got cursor=%d", m.cursor)
	}
	if len(m.matches) != 2 {
		t.Fatalf("backspacing to %q should re-widen the match set, got %d matches", "bi", len(m.matches))
	}
}

// TestUpdateReplacesRowsAndPreservesCursorByValue is the golden for
// applyUpdate's row-patch path: the cursor sits on a value before the
// replacement, that value survives (at a different index -- "z" is now
// sorted ahead of it), and the cursor must still land on it rather than on
// whatever row now occupies the old numeric slot.
func TestUpdateReplacesRowsAndPreservesCursorByValue(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a"}, {Value: "b"}, {Value: "c"}},
	}
	m := New(req)
	m.cursor = 1 // sits on "b"

	next, _ := m.Update(UpdateMsg{Update: protocol.PickUpdate{
		Rows: []protocol.PickRow{{Value: "z"}, {Value: "b"}},
	}})
	m = next.(*Model)

	if len(m.matches) != 2 {
		t.Fatalf("want 2 matches after replace, got %d", len(m.matches))
	}
	got := m.req.Rows[m.matches[m.cursor].Index].Value
	if got != "b" {
		t.Fatalf("cursor should still track value b, landed on %q", got)
	}
}

// TestUpdateClampsCursorWhenItsValueIsGone covers the other half of the
// same contract: the row the cursor was on is absent from the replacement,
// so the numeric position clamps into the new (shorter) range instead of
// resetting to the top or panicking out of bounds.
func TestUpdateClampsCursorWhenItsValueIsGone(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a"}, {Value: "b"}, {Value: "c"}},
	}
	m := New(req)
	m.cursor = 2 // sits on "c"

	next, _ := m.Update(UpdateMsg{Update: protocol.PickUpdate{
		Rows: []protocol.PickRow{{Value: "x"}, {Value: "y"}},
	}})
	m = next.(*Model)

	if m.cursor != 1 {
		t.Fatalf("cursor should clamp to the last valid index (1), got %d", m.cursor)
	}
}

func TestUpdateReplacesMessageAndActions(t *testing.T) {
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Message: "old", Rows: []protocol.PickRow{{Value: "a"}}}
	m := New(req)

	next, _ := m.Update(UpdateMsg{Update: protocol.PickUpdate{
		Message: "new",
		Actions: []protocol.PickAction{{ID: "x", Label: "X", Scope: "item"}},
	}})
	m = next.(*Model)

	if m.req.Message != "new" {
		t.Fatalf("message not replaced: %q", m.req.Message)
	}
	if len(m.req.Actions) != 1 || m.req.Actions[0].ID != "x" {
		t.Fatalf("actions not replaced: %+v", m.req.Actions)
	}
}

// TestUpdateResetQueryClearsFilterReranksAndResetsCursor is the golden for
// ResetQuery's own patch path (nav's descend/up): a query typed against the
// parent directory must not survive into the child's row set.
func TestUpdateResetQueryClearsFilterReranksAndResetsCursor(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{Value: "bin", Left: []protocol.PickSegment{{Text: "bin"}}},
			{Value: "bill", Left: []protocol.PickSegment{{Text: "bill"}}},
			{Value: "other", Left: []protocol.PickSegment{{Text: "other"}}},
		},
	}
	m := New(req)
	m.setQuery("bil")
	if len(m.matches) != 1 {
		t.Fatalf("setup: want 1 match for query %q, got %d", m.query, len(m.matches))
	}

	next, _ := m.Update(UpdateMsg{Update: protocol.PickUpdate{ResetQuery: true}})
	m = next.(*Model)

	if m.query != "" {
		t.Fatalf("query not cleared: %q", m.query)
	}
	if len(m.matches) != 3 {
		t.Fatalf("want all 3 rows to match after reset, got %d", len(m.matches))
	}
	if m.cursor != 0 {
		t.Fatalf("cursor should reset to top, got %d", m.cursor)
	}
}

// TestUpdateResetQueryOverridesCursorPreservationFromRowSwap covers
// ResetQuery combined with a row patch in the same message (nav sends both
// together on descend): the row patch's own by-value cursor tracking would
// otherwise keep the cursor on "b" since it survives into the new set, but a
// query reset means a fresh directory, where that continuity is wrong.
func TestUpdateResetQueryOverridesCursorPreservationFromRowSwap(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a"}, {Value: "b"}, {Value: "c"}},
	}
	m := New(req)
	m.cursor = 1 // sits on "b"

	next, _ := m.Update(UpdateMsg{Update: protocol.PickUpdate{
		Rows:       []protocol.PickRow{{Value: "z"}, {Value: "b"}},
		ResetQuery: true,
	}})
	m = next.(*Model)

	if m.cursor != 0 {
		t.Fatalf("resetQuery must pin the cursor to the top even though row b survived into the new set, got cursor=%d", m.cursor)
	}
}

// TestUpdateBreadcrumbReplacesRenderedHeader: render.go's breadcrumbLine reads
// m.req.Breadcrumb, so a PickUpdate carrying a new one must change what View()
// actually paints, not just what the model stores.
func TestUpdateBreadcrumbReplacesRenderedHeader(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb: []string{"rt", "nav"},
		Rows:       []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
	}
	m := New(req)
	m.width = 60

	before := ansi.Strip(render(m))
	if !strings.Contains(before, "rt › nav") {
		t.Fatalf("setup: initial breadcrumb missing:\n%s", before)
	}
	if strings.Contains(before, "assured-dev") {
		t.Fatalf("setup: unexpected breadcrumb content:\n%s", before)
	}

	next, _ := m.Update(UpdateMsg{Update: protocol.PickUpdate{Breadcrumb: []string{"assured-dev", "worktrees"}}})
	m = next.(*Model)

	after := ansi.Strip(render(m))
	if !strings.Contains(after, "assured-dev › worktrees") {
		t.Fatalf("header did not update to the new breadcrumb:\n%s", after)
	}
	if strings.Contains(after, "rt › nav") {
		t.Fatalf("old breadcrumb still present after update:\n%s", after)
	}
}

// TestEventActionKeyEnqueuesEventAndStaysOpen is the golden for the
// event:true dispatch path: the key is matched against the registry (not
// the hardcoded enter/select path), the encoded line is enqueued onto
// m.events synchronously inside Update itself (no returned cmd carries it),
// and the model produces no terminal result.
func TestEventActionKeyEnqueuesEventAndStaysOpen(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a"}, {Value: "b"}},
		Actions: []protocol.PickAction{
			{ID: "refresh", Label: "refresh", Key: "ctrl-r", Scope: "global", Event: true},
		},
	}
	m := New(req)
	m.events = make(chan []byte, 4)
	m.cursor = 1 // sits on "b"

	next, cmd := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'r'})
	m = next.(*Model)

	if m.result != nil {
		t.Fatalf("event action must not terminate the session: %+v", m.result)
	}
	if cmd != nil {
		t.Fatalf("event dispatch enqueues synchronously and returns no cmd, got %#v", cmd)
	}

	var line []byte
	select {
	case line = <-m.events:
	default:
		t.Fatal("expected an event enqueued onto m.events")
	}

	var ev protocol.PickEvent
	if err := json.Unmarshal(line, &ev); err != nil {
		t.Fatalf("event line not valid JSON: %v (%s)", err, line)
	}
	if ev.T != "event" || ev.Action != "refresh" || ev.Value == nil || *ev.Value != "b" || ev.Query != "" {
		t.Fatalf("got %+v", ev)
	}
}

// TestEventActionWithNoEventsChannelDoesNotBlock covers the bare-model case
// (m.events left nil, as every other test in this file that never presses
// an event key constructs the model): emitEvent must not block forever
// trying to send on a channel nobody is reading.
func TestEventActionWithNoEventsChannelDoesNotBlock(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a"}},
		Actions: []protocol.PickAction{
			{ID: "refresh", Label: "refresh", Key: "ctrl-r", Scope: "global", Event: true},
		},
	}
	m := New(req)

	next, _ := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'r'})
	m = next.(*Model)

	if m.result != nil {
		t.Fatalf("event action must not terminate the session: %+v", m.result)
	}
}

// TestEventLinesLandBeforeTheTerminalResult is the ordering regression
// guard: Bubble Tea leaks a still-running Cmd's goroutine on shutdown
// rather than waiting for it, so a write left inside a returned Cmd has no
// guaranteed order against a result write that runs after the program
// exits. drainEvents closes m.events and blocks until the writer goroutine
// has drained everything buffered before the close, so the ordering here
// holds deterministically -- not just usually -- which is what makes this
// safe to run under -count=N without flaking.
func TestEventLinesLandBeforeTheTerminalResult(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a"}},
		Actions: []protocol.PickAction{
			{ID: "refresh", Label: "refresh", Key: "ctrl-r", Scope: "global", Event: true},
		},
	}
	m := New(req)
	var buf bytes.Buffer
	m.events = make(chan []byte, 4)
	writerDone := m.startEventWriter(&buf)

	next, _ := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'r'}) // the event action
	m = next.(*Model)
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter}) // the terminal action
	m = next.(*Model)

	m.drainEvents(writerDone)
	if err := m.writeResult(&buf); err != nil {
		t.Fatal(err)
	}

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("want exactly 2 lines (event then result), got %d: %q", len(lines), buf.String())
	}
	var first, second struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil || first.T != "event" {
		t.Fatalf("first line should be the event, got %q (err=%v)", lines[0], err)
	}
	if err := json.Unmarshal([]byte(lines[1]), &second); err != nil || second.T != "result" {
		t.Fatalf("second line should be the result, got %q (err=%v)", lines[1], err)
	}
}

// TestNonEventActionKeyProducesTerminalResult covers the opposite branch: a
// registry action without event:true ends the session, exactly as the
// hardcoded "enter" path does for the built-in select, but carrying the
// action's own id rather than "select".
func TestNonEventActionKeyProducesTerminalResult(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a"}, {Value: "b"}},
		Actions: []protocol.PickAction{
			{ID: "dispose", Label: "dispose", Key: "ctrl-x", Scope: "item"},
		},
	}
	m := New(req)
	m.cursor = 0 // sits on "a"

	next, cmd := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'x'})
	m = next.(*Model)

	if m.result == nil || m.result.Action != "dispose" || m.result.Value == nil || *m.result.Value != "a" {
		t.Fatalf("got %+v", m.result)
	}
	if cmd == nil {
		t.Fatal("expected a cmd to end the session")
	}
	if !isQuitCmd(cmd) {
		t.Fatalf("expected the cmd to quit the program")
	}
}

// TestEscCancelsABareRequest covers the keybar's own promise: a request
// that declares nothing still shows "esc quit" in its footer, so esc has to
// actually be reachable from the keyboard, not just advertised.
func TestEscCancelsABareRequest(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a"}},
	}
	m := New(req)

	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	m = next.(*Model)

	if m.result == nil || m.result.Action != "cancel" || m.result.Value != nil {
		t.Fatalf("got %+v", m.result)
	}
	if cmd == nil {
		t.Fatal("expected a cmd to end the session")
	}
	if !isQuitCmd(cmd) {
		t.Fatal("expected the cmd to quit the program")
	}
}

// TestDeclaredEscActionWinsOverTheBuiltinCancel covers the override: a
// caller that declares its own esc-keyed action gets that action dispatched
// instead of the built-in cancel.
func TestDeclaredEscActionWinsOverTheBuiltinCancel(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a"}},
		Actions: []protocol.PickAction{
			{ID: "back", Label: "back", Key: "esc", Scope: "global"},
		},
	}
	m := New(req)

	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	m = next.(*Model)

	if m.result == nil || m.result.Action != "back" {
		t.Fatalf("declared esc action should have fired instead of the built-in cancel: %+v", m.result)
	}
	if cmd == nil {
		t.Fatal("expected a cmd to end the session")
	}
	if !isQuitCmd(cmd) {
		t.Fatal("expected the cmd to quit the program")
	}
}

// TestEscWithModalOpenClosesTheModalNotThePicker covers the ordering: the
// modal-open check runs ahead of the base esc case, so esc while an overlay
// is open dismisses the overlay and leaves the picker running.
func TestEscWithModalOpenClosesTheModalNotThePicker(t *testing.T) {
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: []protocol.PickRow{{Value: "a"}}}
	m := New(req)
	m.events = make(chan []byte, 4)
	m.openTSModal(protocol.PickModal{
		Message: "Sort by",
		Rows:    []protocol.PickRow{{Value: "size", Left: []protocol.PickSegment{{Text: "Size"}}}},
	})

	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	m = next.(*Model)

	if m.modal != nil {
		t.Fatal("esc should close the modal")
	}
	if m.result != nil {
		t.Fatalf("esc closing a modal must not produce a terminal result: %+v", m.result)
	}
	mustNotQuit(t, cmd)
}

func TestFilteredListBreadcrumbCountAndHighlight(t *testing.T) {
	req := protocol.PickRequest{
		T:            "pick",
		Protocol:     protocol.Version,
		Breadcrumb:   []string{"rt", "worktree"},
		InitialQuery: "re",
		Rows: []protocol.PickRow{
			{
				Value: "restore",
				Left: []protocol.PickSegment{
					{Text: "restore", Tone: "text", Bold: true},
					{Text: " Restore a disposed worktree", Tone: "dim"},
				},
				Right: []protocol.PickSegment{{Text: "wt", Tone: "faint"}},
			},
			{
				Value: "ready-approve",
				Left: []protocol.PickSegment{
					{Text: "ready-approve", Tone: "textsoft"},
					{Text: " Approve a repo's ready shell", Tone: "dimmer"},
				},
			},
			{
				Value: "list",
				Left: []protocol.PickSegment{
					{Text: "list", Tone: "textsoft"},
					{Text: " List commands", Tone: "dimmer"},
				},
			},
		},
	}
	m := New(req)
	m.width = 92

	plain := ansi.Strip(render(m))

	if !strings.Contains(plain, "rt › worktree") {
		t.Fatalf("breadcrumb missing:\n%s", plain)
	}
	if !strings.Contains(plain, "2/3") {
		t.Fatalf("filtered count missing (want a 2/3-style count):\n%s", plain)
	}
	if strings.Contains(plain, "list") {
		t.Fatalf("non-matching row must be filtered out of the render:\n%s", plain)
	}

	var cursorLine string
	for _, l := range strings.Split(plain, "\n") {
		if strings.Contains(l, "restore") {
			cursorLine = l
			break
		}
	}
	if cursorLine == "" {
		t.Fatalf("cursor row missing:\n%s", plain)
	}
	if !strings.Contains(cursorLine, "▌") {
		t.Fatalf("cursor gutter missing: %q", cursorLine)
	}
	if !strings.HasSuffix(strings.TrimRight(cursorLine, " "), "wt") {
		t.Fatalf("right segment not pinned at the line end: %q", cursorLine)
	}
}

// TestNavHeaderIdleCountShowsFoldersFilesWhenQueryEmpty is the golden for
// RULING #2's idle state (Nav.dc.html): an empty query paints the caller's
// faint "N folders · M files" in the count slot in place of the generic
// match fraction.
func TestNavHeaderIdleCountShowsFoldersFilesWhenQueryEmpty(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb: []string{"~/Documents/GitHub"},
		IdleCount:  "10 folders · 2 files",
		Rows: []protocol.PickRow{
			{Value: "d:repo-tools", Left: []protocol.PickSegment{{Text: "repo-tools", Tone: "text", Bold: true}}},
			{Value: "f:notes.md", Left: []protocol.PickSegment{{Text: "notes.md", Tone: "text"}}},
		},
	}
	m := New(req)
	m.width = 86

	out := render(m)
	header := strings.Split(out, "\n")[0]
	plain := ansi.Strip(header)

	if !strings.Contains(plain, "10 folders · 2 files") {
		t.Fatalf("idle count missing from the header: %q", plain)
	}
	// The idle count stands in for the fraction: no "2/2" reaches the header.
	if strings.Contains(plain, "2/2") {
		t.Fatalf("idle header must not also show the generic fraction: %q", plain)
	}
	// It reads faint, not cyan.
	if !strings.Contains(header, fg(theme.Faint).Render("10 folders · 2 files")) {
		t.Fatalf("idle count should render as a faint run: %q", header)
	}
	if strings.Contains(header, cyanSGR) {
		t.Fatalf("the idle count must not read cyan (that is the filtering state): %q", header)
	}
}

// TestNavHeaderFilteringShowsCyanMatchedCountNotIdleCount is the golden for
// RULING #2's filtering state: a non-empty query falls back to the universal
// cyan matched-count, never the idle folders/files string, even when an idle
// count is supplied.
func TestNavHeaderFilteringShowsCyanMatchedCountNotIdleCount(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb:   []string{"~/Documents/GitHub"},
		IdleCount:    "10 folders · 2 files",
		InitialQuery: "al",
		Rows: []protocol.PickRow{
			{Value: "d:alpha", Left: []protocol.PickSegment{{Text: "alpha", Tone: "text", Bold: true}}},
			{Value: "f:beta", Left: []protocol.PickSegment{{Text: "beta", Tone: "text"}}},
		},
	}
	m := New(req)
	m.width = 86

	out := render(m)
	header := strings.Split(out, "\n")[0]
	plain := ansi.Strip(header)

	if strings.Contains(plain, "folders") {
		t.Fatalf("filtering header must fall back to the fraction, not the idle count: %q", plain)
	}
	if !strings.Contains(plain, "1/2") {
		t.Fatalf("filtering header should show the matched fraction 1/2: %q", plain)
	}
	if !strings.Contains(header, cyanSGR) {
		t.Fatalf("the matched count should read cyan while filtering: %q", header)
	}
}

// TestNavHeaderSortSuffixRendersFaintNotBold is the golden for RULING #3
// (Nav.dc.html): the non-default sort suffix reads faint, never inheriting
// the breadcrumb's uniform bold, and is absent entirely on the default sort.
func TestNavHeaderSortSuffixRendersFaintNotBold(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb:  []string{"~/Documents/GitHub"},
		CrumbSuffix: " (Size, largest first)",
		IdleCount:   "10 folders · 2 files",
		Rows:        []protocol.PickRow{{Value: "d:repo-tools", Left: []protocol.PickSegment{{Text: "repo-tools", Tone: "text", Bold: true}}}},
	}
	m := New(req)
	m.width = 86

	out := render(m)
	header := strings.Split(out, "\n")[0]

	if !strings.Contains(ansi.Strip(header), "~/Documents/GitHub (Size, largest first)") {
		t.Fatalf("header should carry the cwd and the sort suffix: %q", ansi.Strip(header))
	}
	// The suffix must render as a faint run, and must NOT be wrapped in the
	// breadcrumb's bold Text -- that bold treatment is exactly RULING #3.
	if !strings.Contains(header, fg(theme.Faint).Render(" (Size, largest first)")) {
		t.Fatalf("sort suffix must render faint: %q", header)
	}
	if strings.Contains(header, fg(theme.Text).Bold(true).Render(" (Size, largest first)")) {
		t.Fatalf("sort suffix must not inherit the breadcrumb's bold: %q", header)
	}

	// Default sort (no suffix supplied): nothing but the bold cwd.
	def := req
	def.CrumbSuffix = ""
	md := New(def)
	md.width = 86
	if strings.Contains(ansi.Strip(render(md)), "(Size") {
		t.Fatalf("the default sort must render no suffix at all")
	}
}

// cyanSGR is theme.Cyan's (#5AAAFF) truecolor SGR fragment, as lipgloss
// actually renders it; presence/absence of this substring is how the two
// tests below tell a highlighted rune from a plain one without needing a
// terminal to interpret the escape codes.
const cyanSGR = "38;2;90;170;255"

func TestHighlightAppliesCyanWhenPositionsIndexTheVisibleLeftText(t *testing.T) {
	req := protocol.PickRequest{
		T:            "pick",
		Protocol:     protocol.Version,
		InitialQuery: "re",
		Rows: []protocol.PickRow{
			{Value: "restore", Left: []protocol.PickSegment{{Text: "restore", Tone: "text"}}},
		},
	}
	m := New(req)
	m.width = 40

	if !strings.Contains(rowLine(m, 0), cyanSGR) {
		t.Fatalf("matched runes of the visible left text should carry the cyan highlight: %q", rowLine(m, 0))
	}
}

// TestHighlightMatchesVisibleTextEvenWhenMatchFieldDiverges replaces the
// old "diverges => always suppress" contract: reusing the filter's own
// match.Positions (which index matchText -- row.Match when the caller set
// one) meant ANY row with an overriding Match field lost its highlight
// entirely, even when the query plainly appeared in what's on screen.
// Highlighting is now recomputed per row against its own visible leftPlain
// text, so a diverging Match field only suppresses highlight when the
// query genuinely isn't present in the visible text (the alias-only case),
// not merely because the two strings differ.
func TestHighlightMatchesVisibleTextEvenWhenMatchFieldDiverges(t *testing.T) {
	req := protocol.PickRequest{
		T:            "pick",
		Protocol:     protocol.Version,
		InitialQuery: "pro",
		Rows: []protocol.PickRow{
			{
				Value: "provincial",
				Left:  []protocol.PickSegment{{Text: "provincial", Tone: "text"}},
				Match: "provincial (region)",
			},
			{
				Value: "district",
				Left:  []protocol.PickSegment{{Text: "district", Tone: "text"}},
				Match: "province office",
			},
		},
	}
	m := New(req)
	m.width = 40

	if len(m.matches) != 2 {
		t.Fatalf("both rows should match via their (possibly overriding) match text, got %d: %+v", len(m.matches), m.matches)
	}

	var provincialLine, districtLine string
	for i := range m.matches {
		switch m.req.Rows[m.matches[i].Index].Value {
		case "provincial":
			provincialLine = rowLine(m, i)
		case "district":
			districtLine = rowLine(m, i)
		}
	}

	if !strings.Contains(provincialLine, cyanSGR) {
		t.Fatalf("visible text %q contains the query and must highlight cyan: %q", "provincial", provincialLine)
	}
	if strings.Contains(districtLine, cyanSGR) {
		t.Fatalf("%q only matched via its alias Match field -- the query isn't in its visible text, so it must not highlight: %q", "district", districtLine)
	}
	if !strings.Contains(ansi.Strip(districtLine), "district") {
		t.Fatalf("the left text should still render, just unhighlighted: %q", districtLine)
	}
}

// TestTypedQueryHighlightsAgainstVisibleTextIntegration is the integration
// golden for the same bug: it builds a fixture-shaped row (bold label,
// faint separator, dim branch name, with Match set to the same
// separator-stripped form pick.ts sends), drives a REAL typed query
// through Update -- not a seeded InitialQuery -- and asserts the cyan
// highlight lands on the visible "o" inside "on-deck". This is the path
// that actually shipped broken: the guarded code suppressed every
// highlight on this row because Match ("bill on-deck/bill") never equals
// the visible leftPlain ("bill · on-deck/bill").
func TestTypedQueryHighlightsAgainstVisibleTextIntegration(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{
				Value: "/repo/.worktrees/on-deck/bill",
				Left: []protocol.PickSegment{
					{Text: "bill", Tone: "text", Bold: true},
					{Text: " · ", Tone: "faint"},
					{Text: "on-deck/bill", Tone: "dim"},
				},
				Match: "bill on-deck/bill",
			},
		},
	}
	m := New(req)
	m.width = 92

	next, _ := m.Update(tea.KeyPressMsg{Code: 'o', Text: "o"})
	m = next.(*Model)

	if m.query != "o" {
		t.Fatalf("setup: query should be %q after typing, got %q", "o", m.query)
	}

	raw := rowLine(m, 0)
	if !strings.Contains(raw, cyanSGR) {
		t.Fatalf("typed query %q should highlight the visible %q in on-deck: %q", "o", "o", raw)
	}
}

// textSGR/textSoftSGR/dimSGR/dimmerSGR are theme.Text/TextSoft/Dim/Dimmer's
// truecolor SGR fragments, as lipgloss actually renders them -- the same
// way cyanSGR above pins the highlight color without needing a terminal to
// interpret the escape codes.
const (
	textSGR     = "38;2;230;224;255"
	textSoftSGR = "38;2;210;205;235"
	dimSGR      = "38;2;168;160;198"
	dimmerSGR   = "38;2;139;132;168"
)

// TestFocusDimsNonCursorRowsButNotTheCursorRow is the golden for row-level
// focus: the cursor row keeps today's bold Text label / Dim hint, while
// every other row steps its default text/dim tones down a shade (and
// drops the label's bold) so focus reads from contrast rather than every
// row painting at the cursor row's own weight.
func TestFocusDimsNonCursorRowsButNotTheCursorRow(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{
				Value: "bill",
				Left: []protocol.PickSegment{
					{Text: "bill", Tone: "text", Bold: true},
					{Text: " · ", Tone: "faint"},
					{Text: "on-deck/bill", Tone: "dim"},
				},
			},
			{
				Value: "cho",
				Left: []protocol.PickSegment{
					{Text: "cho", Tone: "text", Bold: true},
					{Text: " · ", Tone: "faint"},
					{Text: "on-deck/cho", Tone: "dim"},
				},
			},
		},
	}
	m := New(req)
	m.width = 92

	cursorRow := rowLine(m, 0)
	if !strings.Contains(cursorRow, "1;"+textSGR) {
		t.Fatalf("cursor row label should stay bold Text: %q", cursorRow)
	}
	if !strings.Contains(cursorRow, dimSGR) {
		t.Fatalf("cursor row hint should stay Dim: %q", cursorRow)
	}
	if strings.Contains(cursorRow, textSoftSGR) || strings.Contains(cursorRow, dimmerSGR) {
		t.Fatalf("cursor row must not carry the non-cursor dimmed tones: %q", cursorRow)
	}

	nonCursorRow := rowLine(m, 1)
	if strings.Contains(nonCursorRow, "1;"+textSGR) {
		t.Fatalf("non-cursor row label must lose bold Text: %q", nonCursorRow)
	}
	if !strings.Contains(nonCursorRow, textSoftSGR) {
		t.Fatalf("non-cursor row label should step down to TextSoft: %q", nonCursorRow)
	}
	if !strings.Contains(nonCursorRow, dimmerSGR) {
		t.Fatalf("non-cursor row hint should step down to Dimmer: %q", nonCursorRow)
	}
	if strings.Contains(nonCursorRow, dimSGR) {
		t.Fatalf("non-cursor row hint must not keep the cursor row's Dim: %q", nonCursorRow)
	}
	// The faint separator is an explicit semantic tone, not a default
	// text/dim tone, so focus must leave it exactly as segColor would
	// render it on either row.
	const faintSGR = "38;2;110;102;140"
	if !strings.Contains(cursorRow, faintSGR) || !strings.Contains(nonCursorRow, faintSGR) {
		t.Fatalf("the faint separator must render identically on both rows:\ncursor: %q\nnon-cursor: %q", cursorRow, nonCursorRow)
	}
}

func TestViewportHeight(t *testing.T) {
	cases := []struct {
		name                               string
		cursor, top, n, cap_, pane, chrome int
		wantH                              int
	}{
		{"cap default, big list, roomy pane", 0, 0, 118, 14, 50, 5, 14},
		{"short list is content-anchored", 0, 0, 5, 0, 50, 5, 5},
		{"pane is the hard ceiling under a bigger cap", 0, 0, 118, 40, 20, 6, 14},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, h := Viewport(c.cursor, c.top, c.n, c.cap_, c.pane, c.chrome)
			if h != c.wantH {
				t.Fatalf("h = %d, want %d", h, c.wantH)
			}
		})
	}
}

func TestViewportResizeRecomputesHeight(t *testing.T) {
	_, hTall := Viewport(0, 0, 118, 14, 50, 5)
	if hTall != 14 {
		t.Fatalf("tall pane h = %d, want 14", hTall)
	}
	_, hShort := Viewport(0, 0, 118, 14, 10, 5)
	if hShort != 5 {
		t.Fatalf("short pane h = %d, want 5 (ceiling = pane 10 - chrome 5)", hShort)
	}
}

// TestViewportCursorFollowsWithScrolloff walks the cursor across a long
// list, feeding each call's returned top back in as the next call's top --
// the same way the caller re-derives the window every frame -- and checks
// the scrolloff invariant holds everywhere except the two places it can't:
// the very start of the list (nothing to show above) and the very end
// (nothing to show below).
func TestViewportCursorFollowsWithScrolloff(t *testing.T) {
	const n, cap_, pane, chrome = 118, 14, 50, 5
	top := 0
	for cursor := 0; cursor < n; cursor++ {
		newTop, h := Viewport(cursor, top, n, cap_, pane, chrome)
		if h != 14 {
			t.Fatalf("cursor=%d: h = %d, want 14", cursor, h)
		}
		if cursor-newTop < scrolloff && newTop > 0 {
			t.Fatalf("cursor=%d top=%d: only %d rows of margin above, want >= %d", cursor, newTop, cursor-newTop, scrolloff)
		}
		if (newTop+h-1)-cursor < scrolloff && newTop+h < n {
			t.Fatalf("cursor=%d top=%d h=%d: only %d rows of margin below, want >= %d", cursor, newTop, h, (newTop+h-1)-cursor, scrolloff)
		}
		top = newTop
	}
	if top+13 != n-1 {
		t.Fatalf("final top = %d, want the window pinned to the list end (top+13=%d, n-1=%d)", top, top+13, n-1)
	}
}

func TestViewportContentAnchoredListNeedsNoScrolloffClamp(t *testing.T) {
	// n=5 fits entirely inside h=5: cursor can walk end to end with top
	// staying at 0 the whole way, exercising the small-window clamp branch
	// (2*scrolloff+1 > h) without it ever needing to move the window.
	for cursor := 0; cursor < 5; cursor++ {
		newTop, h := Viewport(cursor, 0, 5, 0, 50, 5)
		if newTop != 0 || h != 5 {
			t.Fatalf("cursor=%d: got top=%d h=%d, want top=0 h=5", cursor, newTop, h)
		}
	}
}

// TestLongListWindowsWithThumbRailAndFooterRange is the render-integration
// golden: a 118-row list at the default cap of 14 shows only the first
// window, a thumb rail cell on the one row proportional to it (14*14/118
// floors to 1), and a footer range using a plain hyphen -- never the
// en-dash the design board renders with, which is CSS the board owns, not a
// wire or rendering contract.
func TestLongListWindowsWithThumbRailAndFooterRange(t *testing.T) {
	rows := make([]protocol.PickRow, 118)
	for i := range rows {
		v := fmt.Sprintf("repo%03d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v, Tone: "text"}}}
	}
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: rows}
	m := New(req)
	m.width = 60

	out := render(m)
	plain := ansi.Strip(out)
	lines := strings.Split(plain, "\n")
	rawLines := strings.Split(out, "\n")

	const wantLines = 3 + 14 + 2 // breadcrumb+filter+rule, 14 windowed rows, rule+footer
	if len(lines) != wantLines {
		t.Fatalf("got %d lines, want %d:\n%s", len(lines), wantLines, plain)
	}
	if !strings.Contains(lines[3], "repo000") {
		t.Fatalf("first visible row should be repo000:\n%s", plain)
	}
	if strings.Contains(plain, "repo014") {
		t.Fatalf("row 14 is outside the [0,14) window and must not render:\n%s", plain)
	}

	footer := lines[len(lines)-1]
	if !strings.Contains(footer, "1-14 of 118") {
		t.Fatalf("footer range missing 1-14 of 118: %q", footer)
	}
	if strings.ContainsRune(footer, '\u2013') || strings.ContainsRune(footer, '\u2014') {
		t.Fatalf("footer range must use an ASCII hyphen, never an en/em dash: %q", footer)
	}

	// theme.Panel (#34304E) as a lipgloss truecolor background SGR.
	const panelSGR = "48;2;52;48;78"
	if !strings.Contains(rawLines[3], panelSGR) {
		t.Fatalf("expected the thumb rail on the first visible row: %q", rawLines[3])
	}
	for _, l := range rawLines[4:17] {
		if strings.Contains(l, panelSGR) {
			t.Fatalf("thumb rail should cover exactly 1 row (h*h/n=1): %q", l)
		}
	}
}

// TestNoMatchState is the golden for the Filtering board's zero-match frame:
// the breadcrumb count reads 0/N (N total rows, not 0/0), the row area
// collapses to a single inline faint "no matches" line, and the footer
// swaps its whole legend to the edit-filter/quit pair since nothing below
// enter/tab/ctrl-up applies when there is nothing to act on.
func TestNoMatchState(t *testing.T) {
	req := protocol.PickRequest{
		T:            "pick",
		Protocol:     protocol.Version,
		Breadcrumb:   []string{"rt", "worktree"},
		InitialQuery: "zzz",
		Rows: []protocol.PickRow{
			{Value: "restore", Left: []protocol.PickSegment{{Text: "restore", Tone: "text"}}},
			{Value: "list", Left: []protocol.PickSegment{{Text: "list", Tone: "text"}}},
		},
	}
	m := New(req)
	m.width = 60

	plain := ansi.Strip(render(m))

	if !strings.Contains(plain, "0/2") {
		t.Fatalf("breadcrumb count should read 0/2 (0 matches of 2 total rows):\n%s", plain)
	}
	if strings.Contains(plain, "restore") || strings.Contains(plain, "list") {
		t.Fatalf("no row should render once the query matches nothing:\n%s", plain)
	}
	if !strings.Contains(plain, "backspace edit filter · esc quit") {
		t.Fatalf("footer should swap to the no-match legend:\n%s", plain)
	}

	lines := strings.Split(plain, "\n")
	noMatchLines := 0
	for _, l := range lines {
		if strings.Contains(l, "no matches") {
			noMatchLines++
		}
	}
	if noMatchLines != 1 {
		t.Fatalf("want exactly one inline no-matches row, got %d:\n%s", noMatchLines, plain)
	}
}

// TestGroupHeadersRenderAboveFirstRowOfEachGroup is the golden for the
// RunChain board's group headers: a faint uppercase label prints once above
// each group's first row, never repeats for the group's later rows, and the
// cursor -- which indexes m.matches, not the printed lines -- still lands on
// the first real row rather than a header.
func TestGroupHeadersRenderAboveFirstRowOfEachGroup(t *testing.T) {
	req := protocol.PickRequest{
		T:        "pick",
		Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{Value: "adjuster+backend", Group: "presets", Left: []protocol.PickSegment{{Text: "adjuster + backend", Tone: "text"}}},
			{Value: "backend", Group: "packages", Left: []protocol.PickSegment{{Text: "backend", Tone: "text"}}},
			{Value: "adjuster", Group: "packages", Left: []protocol.PickSegment{{Text: "adjuster", Tone: "text"}}},
		},
	}
	m := New(req)
	m.width = 60

	plain := ansi.Strip(render(m))
	lines := strings.Split(plain, "\n")

	// breadcrumb(0), filter(1), rule(2) precede the row area.
	if !strings.Contains(lines[3], "PRESETS") {
		t.Fatalf("expected a PRESETS header above the first row:\n%s", plain)
	}
	if !strings.Contains(lines[4], "adjuster + backend") {
		t.Fatalf("first real row should follow its header:\n%s", plain)
	}
	if !strings.Contains(lines[5], "PACKAGES") {
		t.Fatalf("expected a PACKAGES header once the group changes:\n%s", plain)
	}
	if !strings.Contains(lines[6], "backend") {
		t.Fatalf("first packages row should follow its header:\n%s", plain)
	}
	if strings.Contains(lines[7], "PACKAGES") {
		t.Fatalf("second packages row must not repeat the header:\n%s", plain)
	}

	if m.cursor != 0 {
		t.Fatalf("cursor should start on match index 0, not a header: %d", m.cursor)
	}
	var cursorLine string
	for _, l := range strings.Split(render(m), "\n") {
		if strings.Contains(l, "▌") {
			cursorLine = l
			break
		}
	}
	if !strings.Contains(ansi.Strip(cursorLine), "adjuster + backend") {
		t.Fatalf("cursor gutter should mark the first real row, not a header: %q", cursorLine)
	}
}

// TestZeroRowModelDoesNotPanic covers the defensive guard only: pick.ts
// never spawns the picker for a zero-row request, so this is not the
// no-match UI, just insurance against a nil/empty-slice panic if that
// invariant is ever violated.
// TestKeybarRendersGroupedLegendWithBackAndQuitPinnedRight is the golden for
// the Branch board's footer: a caller-declared group ("pick", holding
// select/enter and with-args/alt-enter) renders lav-labeled on the left, and
// back/cancel -- back caller-declared here, cancel injected, both ungrouped
// since this request never claims a group for them -- pin to the right with
// no group label.
func TestKeybarRendersGroupedLegendWithBackAndQuitPinnedRight(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb: []string{"rt", "worktree"},
		Rows:       []protocol.PickRow{{Value: "provision"}},
		Actions: []protocol.PickAction{
			{ID: "select", Label: "select", Key: "enter", Scope: "item", Group: "pick", Primary: true},
			{ID: "with-args", Label: "with args", Key: "alt-enter", Scope: "item", Group: "pick"},
			{ID: "back", Label: "back", Key: "ctrl-up", Scope: "global"},
		},
	}
	m := New(req)
	m.width = 92

	lines := strings.Split(render(m), "\n")
	footer := lines[len(lines)-1]
	plain := ansi.Strip(footer)

	if !strings.HasPrefix(strings.TrimLeft(plain, " "), "pick enter select  alt-enter with args") {
		t.Fatalf("left legend mismatch: %q", plain)
	}
	if !strings.HasSuffix(strings.TrimRight(plain, " "), "ctrl-up back  esc quit") {
		t.Fatalf("right legend mismatch: %q", plain)
	}

	const lavSGR = "38;2;189;147;249"
	const faintSGR = "38;2;110;102;140"
	if !strings.Contains(footer, lavSGR) {
		t.Fatalf("group label should be lav-colored: %q", footer)
	}
	if !strings.Contains(footer, faintSGR) {
		t.Fatalf("keys should be faint-colored: %q", footer)
	}
	if !strings.Contains(footer, dimSGR) {
		t.Fatalf("labels should be dim-colored: %q", footer)
	}
}

// TestKeybarLegendIntegratesWithTheScrollRangeOnTheSameFooterLine mirrors
// the Scrolling board: when the list overflows the viewport, the range
// indicator sits between the (empty, here) grouped legend and the pinned
// action run, joined by a faint middle dot -- never a second footer line.
func TestKeybarLegendIntegratesWithTheScrollRangeOnTheSameFooterLine(t *testing.T) {
	rows := make([]protocol.PickRow, 20)
	for i := range rows {
		v := fmt.Sprintf("row%02d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v, Tone: "text"}}}
	}
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: rows, Cap: 5}
	m := New(req)
	m.width = 60

	lines := strings.Split(render(m), "\n")
	footer := ansi.Strip(lines[len(lines)-1])

	if !strings.Contains(footer, "1-5 of 20") {
		t.Fatalf("range missing from footer: %q", footer)
	}
	if !strings.Contains(footer, "1-5 of 20  ·  enter select") {
		t.Fatalf("range and action legend should join on a faint middle dot: %q", footer)
	}
}

// TestKeybarTruncatesAtGroupBoundaryNeverMidWord covers a width too narrow
// for every declared group to fit: the right-pinned esc/quit cluster still
// renders in full, and the left legend gives up whole trailing groups
// rather than clipping a key or a label mid-word.
func TestKeybarTruncatesAtGroupBoundaryNeverMidWord(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a"}},
		Actions: []protocol.PickAction{
			{ID: "select", Label: "select", Key: "enter", Scope: "item", Group: "pick"},
			{ID: "all", Label: "all/none", Key: "ctrl-a", Scope: "global", Group: "mark"},
			{ID: "sort", Label: "sort by name", Key: "ctrl-s", Scope: "global", Group: "view"},
		},
	}
	m := New(req)
	m.width = 45 // budget is 34 once "esc quit" is reserved; only "pick" (17) fits, "mark" and "view" both drop

	lines := strings.Split(render(m), "\n")
	footer := ansi.Strip(lines[len(lines)-1])
	trimmed := strings.TrimRight(footer, " ")

	if lipgloss.Width(footer) > m.width {
		t.Fatalf("footer must fit the pane width (%d), got width %d: %q", m.width, lipgloss.Width(footer), footer)
	}
	if !strings.HasSuffix(trimmed, "esc quit") {
		t.Fatalf("esc/quit must always survive intact: %q", footer)
	}
	if !strings.Contains(footer, "pick enter select") {
		t.Fatalf("the first group should still fit and render whole: %q", footer)
	}
	if strings.Contains(footer, "view") || strings.Contains(footer, "sort") {
		t.Fatalf("a group that does not fit must be dropped whole, not partially rendered: %q", footer)
	}
	if strings.Contains(footer, "…") {
		t.Fatalf("group-boundary truncation drops whole groups, never an ellipsis: %q", footer)
	}
}

// TestDefaultActionsCoverTheBareRequest pins the case a request declares no
// registry at all: select and cancel always exist, and back is never
// synthesized from breadcrumb depth -- only a caller declaring it puts it in
// effectiveActions, at any depth.
func TestDefaultActionsCoverTheBareRequest(t *testing.T) {
	flat := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: []protocol.PickRow{{Value: "a"}}}
	actions := effectiveActions(flat)
	byID := map[string]protocol.PickAction{}
	for _, a := range actions {
		byID[a.ID] = a
	}
	if a, ok := byID["select"]; !ok || a.Key != "enter" {
		t.Fatalf("want a default select bound to enter, got %+v (ok=%v)", a, ok)
	}
	if a, ok := byID["cancel"]; !ok || a.Key != "esc" {
		t.Fatalf("want a default cancel bound to esc, got %+v (ok=%v)", a, ok)
	}
	if _, ok := byID["back"]; ok {
		t.Fatalf("a bare request must not get a back default: %+v", actions)
	}

	nested := flat
	nested.Breadcrumb = []string{"rt", "worktree"}
	nestedActions := effectiveActions(nested)
	for _, a := range nestedActions {
		if a.ID == "back" {
			t.Fatalf("breadcrumb depth must never synthesize a back default: %+v", nestedActions)
		}
	}

	declared := nested
	declared.Actions = []protocol.PickAction{
		{ID: "back", Label: "back", Key: "ctrl-up", Scope: "global"},
	}
	declaredActions := effectiveActions(declared)
	var backCount int
	for _, a := range declaredActions {
		if a.ID == "back" {
			backCount++
		}
	}
	if backCount != 1 {
		t.Fatalf("a caller-declared back must survive effectiveActions exactly once, got %d: %+v", backCount, declaredActions)
	}
}

// TestDeclaredSelectIsNotDuplicatedByTheDefault covers the dedupe half of
// injection: a request that already claims the "select" id (or the "enter"
// key under a different id) must not also get the generic default.
func TestDeclaredSelectIsNotDuplicatedByTheDefault(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a"}},
		Actions: []protocol.PickAction{
			{ID: "select", Label: "select", Key: "enter", Scope: "item", Group: "pick"},
		},
	}
	actions := effectiveActions(req)
	var enterCount int
	for _, a := range actions {
		if a.Key == "enter" {
			enterCount++
		}
	}
	if enterCount != 1 {
		t.Fatalf("declared select must not be duplicated by the default: %+v", actions)
	}
}

// TestDeriveMenuOrdersItemAboveRuleAboveGlobal is the golden for the
// Actions board's ctrl-k/right-click menu: item-scope rows (including a
// keyless, menu-only action) come first in declaration order, then a rule,
// then global-scope rows.
func TestDeriveMenuOrdersItemAboveRuleAboveGlobal(t *testing.T) {
	actions := []protocol.PickAction{
		{ID: "open", Label: "open", Key: "enter", Scope: "item", Primary: true},
		{ID: "cd-sel", Label: "cd selected", Key: "ctrl-space", Scope: "item"},
		{ID: "editor", Label: "open in editor", Key: "ctrl-o", Scope: "item", Group: "act"},
		{ID: "reveal", Label: "reveal in finder", Scope: "item", Group: "act"},
		{ID: "cd-here", Label: "cd here", Key: "ctrl-h", Scope: "global"},
		{ID: "sort", Label: "sort", Key: "ctrl-s", Scope: "global", Group: "view"},
	}

	rows := deriveMenu(actions, 0)

	wantIDs := []string{"open", "cd-sel", "editor", "reveal", "", "cd-here", "sort"}
	if len(rows) != len(wantIDs) {
		t.Fatalf("got %d rows, want %d: %+v", len(rows), len(wantIDs), rows)
	}
	for i, want := range wantIDs {
		if want == "" {
			if !rows[i].Rule {
				t.Fatalf("row %d should be the item/global rule, got %+v", i, rows[i])
			}
			continue
		}
		if rows[i].Rule || rows[i].ActionID != want {
			t.Fatalf("row %d = %+v, want action %q", i, rows[i], want)
		}
	}
	if rows[3].ActionID != "reveal" || rows[3].Key != "" {
		t.Fatalf("the keyless action must still appear, menu-only: %+v", rows[3])
	}
}

// TestDeriveMenuDropsItemScopeWithNoCursorRow covers ctrl-k with nothing
// under the cursor (an empty list): item-scope actions have no row to act
// on, so only the global half survives, with no dangling rule.
func TestDeriveMenuDropsItemScopeWithNoCursorRow(t *testing.T) {
	actions := []protocol.PickAction{
		{ID: "open", Label: "open", Key: "enter", Scope: "item"},
		{ID: "cd-here", Label: "cd here", Key: "ctrl-h", Scope: "global"},
	}
	rows := deriveMenu(actions, -1)
	if len(rows) != 1 || rows[0].ActionID != "cd-here" {
		t.Fatalf("want only the global row with no cursor row, got %+v", rows)
	}
}

// TestDeriveMenuSkipsMenuHiddenActions covers the ctrl-k mis-dispatch fix
// directly: an action flagged MenuHidden (the multi mark-cluster's own
// synthesized toggle/toggle-all entries, in practice) never becomes a menu
// row, in either scope, while an ordinary action right next to it still
// does -- so the exclusion is a per-action flag, not a wholesale drop of
// its scope or group.
func TestDeriveMenuSkipsMenuHiddenActions(t *testing.T) {
	actions := []protocol.PickAction{
		{ID: "toggle", Label: "toggle", Key: "space", Scope: "item", Group: "mark", MenuHidden: true},
		{ID: "dispose", Label: "dispose", Scope: "item"},
		{ID: "toggle-all", Label: "all/none", Key: "ctrl-a", Scope: "global", Group: "mark", MenuHidden: true},
		{ID: "refresh", Label: "refresh", Scope: "global"},
	}

	rows := deriveMenu(actions, 0)

	wantIDs := []string{"dispose", "", "refresh"}
	if len(rows) != len(wantIDs) {
		t.Fatalf("got %d rows, want %d: %+v", len(rows), len(wantIDs), rows)
	}
	for i, want := range wantIDs {
		if want == "" {
			if !rows[i].Rule {
				t.Fatalf("row %d should be the item/global rule, got %+v", i, rows[i])
			}
			continue
		}
		if rows[i].Rule || rows[i].ActionID != want {
			t.Fatalf("row %d = %+v, want action %q", i, rows[i], want)
		}
	}
}

// TestCtrlKMenuShowsOnlyDeclaredActionsNeverInjectedDefaults covers opening
// the overlay from a live model: it must build the menu from the request's
// own declared Actions only, never from effectiveActions' injected
// select/cancel/back -- even when the breadcrumb is deep enough that back
// would once have been synthesized into the keybar right alongside it.
func TestCtrlKMenuShowsOnlyDeclaredActionsNeverInjectedDefaults(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb: []string{"rt", "worktree"},
		Rows:       []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
		Actions: []protocol.PickAction{
			{ID: "editor", Label: "open in editor", Scope: "item"},
		},
	}
	m := New(req)

	next, _ := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'k'})
	m = next.(*Model)
	if m.modal == nil {
		t.Fatal("ctrl-k should open the registry menu")
	}

	var ids []string
	for _, r := range m.modal.rows {
		ids = append(ids, r.actionID)
	}
	if len(ids) != 1 || ids[0] != "editor" {
		t.Fatalf("menu must show only the declared action, got %+v", ids)
	}
}

// TestCtrlKMenuOpensNothingWithNoDeclaredActions covers the other half: a
// request that declares no registry at all has nothing for ctrl-k to show,
// so it must leave the picker untouched rather than opening a menu of
// nothing but injected defaults.
func TestCtrlKMenuOpensNothingWithNoDeclaredActions(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
	}
	m := New(req)

	next, _ := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'k'})
	m = next.(*Model)
	if m.modal != nil {
		t.Fatalf("ctrl-k with no declared actions must open nothing, got %+v", m.modal)
	}
}

func TestZeroRowModelDoesNotPanic(t *testing.T) {
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: []protocol.PickRow{}}
	m := New(req)
	m.width = 60

	_ = render(m)
}

// TestUngroupedListEmitsNoHeaderLines pins the zero-header case explicitly
// rather than leaving it only inferable from the Task 5/6 goldens still
// passing: a list where no row carries a Group must render exactly the
// row count the rest of the chrome already expects, with nothing extra
// interleaved.
func TestUngroupedListEmitsNoHeaderLines(t *testing.T) {
	rows := make([]protocol.PickRow, 5)
	for i := range rows {
		v := fmt.Sprintf("row%d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v, Tone: "text"}}}
	}
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: rows}
	m := New(req)
	m.width = 40

	plain := ansi.Strip(render(m))
	lines := strings.Split(plain, "\n")

	const wantLines = 3 + 5 + 2 // breadcrumb+filter+rule, 5 rows, rule+footer
	if len(lines) != wantLines {
		t.Fatalf("an ungrouped list must not interleave header lines: got %d lines, want %d:\n%s", len(lines), wantLines, plain)
	}
}

// TestGroupHeadersRespectPaneBudgetWhenWindowed is the golden for the
// overflow this task's review caught: 20 rows in groups of 2 give a header
// every other row, so the [top, top+h) window Viewport hands back on its
// own row ceiling (h=14 for a 20-row pane) still doesn't leave room for the
// ~7 headers that land inside it. The fix has to trim rows -- not headers,
// there's nothing optional about those -- until rows+headers fits the
// pane, while keeping the cursor's own row on screen, a header still
// directly above whichever row ends up as the window's first line if that
// row is genuinely its group's first, and (once trimming has room to spare)
// the cursor's usual scrolloff margin on both visible edges rather than
// pinned to whichever edge a naive shrink happened to leave it on.
func TestGroupHeadersRespectPaneBudgetWhenWindowed(t *testing.T) {
	const n = 20
	rows := make([]protocol.PickRow, n)
	for i := range rows {
		v := fmt.Sprintf("row%02d", i)
		rows[i] = protocol.PickRow{
			Value: v,
			Group: fmt.Sprintf("group%d", i/2),
			Left:  []protocol.PickSegment{{Text: v, Tone: "text"}},
		}
	}
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: rows}
	m := New(req)
	m.width = 60
	m.height = 20
	m.cursor = 10

	const budget = 20 - chromeRows // paneRows - chromeRows, the same ceiling Viewport enforces for rows alone

	top, h := m.viewport()
	topMargin := m.cursor - top
	bottomMargin := (top + h - 1) - m.cursor
	// h=10 here easily affords 2+2 scrolloff (2*scrolloff+1=5 <= 10), so a
	// window that shrank purely to fit the header budget still owes the
	// cursor its full margin on both edges -- unlike Task 6's own goldens,
	// which walk a window too short to promise more than the symmetric-clamp
	// case, this one is deliberately roomy enough that scrolloff has no
	// excuse to be dropped.
	if topMargin < scrolloff || bottomMargin < scrolloff {
		t.Fatalf("header-budget trim dropped scrolloff even though h=%d affords it: top=%d h=%d cursor=%d (topMargin=%d, bottomMargin=%d, want >= %d both)",
			h, top, h, m.cursor, topMargin, bottomMargin, scrolloff)
	}

	plain := ansi.Strip(render(m))
	lines := strings.Split(plain, "\n")
	rowsArea := lines[3 : len(lines)-2] // between the top rule and the bottom rule/footer

	if len(rowsArea) > budget {
		t.Fatalf("rows-area overflowed the pane budget: got %d lines (rows+headers), budget %d:\n%s", len(rowsArea), budget, plain)
	}

	var sawCursorRow bool
	for _, l := range rowsArea {
		if strings.Contains(l, "▌") && strings.Contains(l, "row10") {
			sawCursorRow = true
		}
	}
	if !sawCursorRow {
		t.Fatalf("cursor row row10 must stay visible once the window is trimmed for headers:\n%s", plain)
	}

	// rowRe finds the row number anywhere on the line rather than requiring
	// it at the start: the cursor row carries a leading gutter glyph
	// (theme.GlyphBar) that a strict prefix match would otherwise trip on.
	rowRe := regexp.MustCompile(`row(\d+)`)
	rowNum := func(l string) (int, bool) {
		m := rowRe.FindStringSubmatch(l)
		if m == nil {
			return 0, false
		}
		var i int
		fmt.Sscanf(m[1], "%d", &i)
		return i, true
	}
	for i, l := range rowsArea {
		trimmed := strings.TrimSpace(l)
		if !strings.HasPrefix(trimmed, "GROUP") {
			continue
		}
		if i+1 >= len(rowsArea) {
			t.Fatalf("header with no row rendered beneath it: %q", l)
		}
		num, ok := rowNum(rowsArea[i+1])
		if !ok || num%2 != 0 {
			t.Fatalf("header %q must sit directly above its group's first row, got %q", l, rowsArea[i+1])
		}
	}
}

// surfaceBgSGR is theme.Surface's (#221A35) truecolor SGR fragment as a
// background parameter -- the overlay box's own fill, distinct from the
// foreground fragments the other consts above pin.
const surfaceBgSGR = "48;2;34;26;53"

// TestModalMessageDimsTheParentAndPaintsASurfaceOverlay is the golden for
// the composite itself: dimForeground steps the parent's Text tone down to
// Dim (the same transform renderModal runs over the parent before
// compositing), and the composited frame carries the overlay's Surface
// background -- present only once a modal is actually open, per the base
// goldens elsewhere in this file staying unchanged with m.modal nil.
func TestModalMessageDimsTheParentAndPaintsASurfaceOverlay(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a", Tone: "text"}}}},
	}
	m := New(req)
	m.width = 60

	base := render(m)
	if !strings.Contains(base, textSGR) {
		t.Fatalf("setup: the lone (cursor) row should render full Text before dimming: %q", base)
	}

	m.openTSModal(protocol.PickModal{
		Message: "Sort by",
		Rows: []protocol.PickRow{
			{Value: "size", Left: []protocol.PickSegment{{Text: "Size", Tone: "text"}}},
			{Value: "name", Left: []protocol.PickSegment{{Text: "Name", Tone: "text"}}},
		},
	})
	if m.modal == nil {
		t.Fatal("a modal message should open the overlay")
	}

	dimmed := dimForeground(base)
	if strings.Contains(dimmed, textSGR) {
		t.Fatalf("dimForeground must remove every undimmed Text fragment: %q", dimmed)
	}
	if !strings.Contains(dimmed, dimSGR) {
		t.Fatalf("dimForeground should step the cursor row's Text down to Dim: %q", dimmed)
	}

	composited := renderView(m)
	if !strings.Contains(composited, surfaceBgSGR) {
		t.Fatalf("composited frame should paint the overlay's Surface background: %q", ansi.Strip(composited))
	}
}

// TestModalRowSelectionWritesModalResultAndClosesOverlay covers the
// TS-driven modal's happy path: selecting a row answers modal-result with
// that row's value (not the terminal PickResult -- the picker is still
// running) and the overlay closes, leaving the parent picker resumed.
func TestModalRowSelectionWritesModalResultAndClosesOverlay(t *testing.T) {
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: []protocol.PickRow{{Value: "a"}}}
	m := New(req)
	m.events = make(chan []byte, 4)

	m.openTSModal(protocol.PickModal{
		Message: "Sort by",
		Rows: []protocol.PickRow{
			{Value: "size", Left: []protocol.PickSegment{{Text: "Size"}}},
			{Value: "name", Left: []protocol.PickSegment{{Text: "Name"}}},
		},
	})

	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	m = next.(*Model)
	next, cmd = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(*Model)

	mustNotQuit(t, cmd)
	if m.modal != nil {
		t.Fatal("the overlay should close once a row is selected")
	}
	if m.result != nil {
		t.Fatalf("a modal selection must not produce a terminal result: %+v", m.result)
	}

	var line []byte
	select {
	case line = <-m.events:
	default:
		t.Fatal("expected a modal-result line enqueued onto m.events")
	}
	var mr protocol.PickModalResult
	if err := json.Unmarshal(line, &mr); err != nil {
		t.Fatalf("modal-result line not valid JSON: %v (%s)", err, line)
	}
	if mr.T != "modal-result" || mr.Value == nil || *mr.Value != "name" {
		t.Fatalf("got %+v", mr)
	}
}

// TestModalEscWritesNullModalResultAndCloses covers dismissal: esc answers
// modal-result with a null value rather than leaving the caller's await
// hanging, and closes the overlay the same as a selection would.
func TestModalEscWritesNullModalResultAndCloses(t *testing.T) {
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: []protocol.PickRow{{Value: "a"}}}
	m := New(req)
	m.events = make(chan []byte, 4)

	m.openTSModal(protocol.PickModal{
		Message: "Sort by",
		Rows:    []protocol.PickRow{{Value: "size", Left: []protocol.PickSegment{{Text: "Size"}}}},
	})

	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	m = next.(*Model)

	mustNotQuit(t, cmd)
	if m.modal != nil {
		t.Fatal("esc should close the overlay")
	}

	var line []byte
	select {
	case line = <-m.events:
	default:
		t.Fatal("expected a modal-result line enqueued onto m.events")
	}
	var mr protocol.PickModalResult
	if err := json.Unmarshal(line, &mr); err != nil {
		t.Fatalf("modal-result line not valid JSON: %v (%s)", err, line)
	}
	if mr.T != "modal-result" || mr.Value != nil {
		t.Fatalf("esc should answer a null value, got %+v", mr)
	}
}

// TestWireModalReplacesAnOpenRegistryMenuCleanly covers a wire modal
// arriving while the ctrl-k/right-click menu is still open: the registry
// menu owes the wire nothing on a plain dismiss, so it is simply replaced
// -- the overlay afterward is the TS modal alone, with none of the menu's
// own rows surviving into it.
func TestWireModalReplacesAnOpenRegistryMenuCleanly(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
		Actions: []protocol.PickAction{
			{ID: "dispose", Label: "dispose", Scope: "item"},
		},
	}
	m := New(req)
	m.events = make(chan []byte, 4)

	next, _ := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'k'})
	m = next.(*Model)
	if m.modal == nil || m.modal.kind != modalRegistry {
		t.Fatalf("setup: ctrl-k should open the registry menu, got %+v", m.modal)
	}

	next, cmd := m.Update(ModalMsg{Modal: protocol.PickModal{
		Message: "Sort by",
		Rows:    []protocol.PickRow{{Value: "size", Left: []protocol.PickSegment{{Text: "Size"}}}},
	}})
	m = next.(*Model)

	if m.modal == nil || m.modal.kind != modalTSDriven {
		t.Fatalf("the wire modal should replace the menu, got %+v", m.modal)
	}
	if len(m.modal.rows) != 1 || m.modal.rows[0].text != "Size" {
		t.Fatalf("the menu's own rows must not survive into the wire modal: %+v", m.modal.rows)
	}
	if isQuitCmd(cmd) {
		t.Fatal("replacing the overlay must not end the session")
	}
	select {
	case line := <-m.events:
		t.Fatalf("a registry menu owes the wire nothing on replacement, got a line anyway: %s", line)
	default:
	}
}

// TestWireModalAnswersAPriorOpenModalBeforeReplacingIt covers a wire modal
// arriving while a DIFFERENT TS-driven modal is still open and unanswered:
// the wire contract owes that first modal exactly one modal-result line, so
// it gets answered null -- the same way esc-dismissing it would -- before
// the new one opens, rather than leaving its caller blocked forever.
func TestWireModalAnswersAPriorOpenModalBeforeReplacingIt(t *testing.T) {
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: []protocol.PickRow{{Value: "a"}}}
	m := New(req)
	m.events = make(chan []byte, 4)

	m.openTSModal(protocol.PickModal{
		Message: "Sort by",
		Rows:    []protocol.PickRow{{Value: "size", Left: []protocol.PickSegment{{Text: "Size"}}}},
	})

	next, _ := m.Update(ModalMsg{Modal: protocol.PickModal{
		Message: "Filter by",
		Rows:    []protocol.PickRow{{Value: "kind", Left: []protocol.PickSegment{{Text: "Kind"}}}},
	}})
	m = next.(*Model)

	if m.modal == nil || m.modal.title != "Filter by" {
		t.Fatalf("the newer modal should now be open, got %+v", m.modal)
	}

	var line []byte
	select {
	case line = <-m.events:
	default:
		t.Fatal("the first modal should have been answered null before being replaced")
	}
	var mr protocol.PickModalResult
	if err := json.Unmarshal(line, &mr); err != nil {
		t.Fatalf("modal-result line not valid JSON: %v (%s)", err, line)
	}
	if mr.T != "modal-result" || mr.Value != nil {
		t.Fatalf("the clobbered modal should be answered null, got %+v", mr)
	}
}

// TestOverlayCloseHoldsTheSameHeightAsWhileOpen is the in-repo proxy for
// "no height-changing repaint on modal close": bubbletea's inline renderer
// only takes the grow/shrink redraw path (a cursor-up-then-erase sequence a
// terminal's own idea of an ambiguous-width glyph's column cost can
// disagree with) when the frame's own line count actually changes between
// consecutive renders. A wire modal taller than the base list opens (that
// transition's own height jump from the pre-open frame is a separate,
// accepted case -- see the package doc note above New -- since nothing can
// retroactively widen a frame already sent to the terminal); what this
// pins is that dismissing it does NOT then shrink the frame straight back
// down in the same step. The height right after esc must equal the height
// while the modal was still open, held for one extra render past the
// transition itself (armPinRelease's own countdown) before the picker is
// free to shrink back to natural size on a later, unrelated interaction.
func TestOverlayCloseHoldsTheSameHeightAsWhileOpen(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}},
			{Value: "b", Left: []protocol.PickSegment{{Text: "b"}}},
		},
	}
	m := New(req)
	m.width = 60

	modalRows := make([]protocol.PickRow, 20)
	for i := range modalRows {
		modalRows[i] = protocol.PickRow{Value: fmt.Sprintf("opt%02d", i), Left: []protocol.PickSegment{{Text: fmt.Sprintf("opt%02d", i)}}}
	}
	next, _ := m.Update(ModalMsg{Modal: protocol.PickModal{Message: "Sort by", Rows: modalRows}})
	m = next.(*Model)
	openHeight := lipgloss.Height(renderView(m))

	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	m = next.(*Model)
	closeHeight := lipgloss.Height(renderView(m))

	if closeHeight != openHeight {
		t.Fatalf("dismiss changed the frame height: while open %d, right after dismiss %d", openHeight, closeHeight)
	}

	// tea.ClearScreen's own Cmd sends bubbletea's internal clearScreenMsg
	// back through Update asynchronously -- unexported, so unconstructable
	// here, but any message type Update doesn't specifically recognize
	// falls through the same way, which is what matters for this: the pin
	// has to survive that render too, not just the esc keypress's own.
	next, _ = m.Update(unrecognizedMsg{})
	m = next.(*Model)
	if h := lipgloss.Height(renderView(m)); h != openHeight {
		t.Fatalf("the render following an unrelated internal message changed height: while open %d, got %d", openHeight, h)
	}
}

// unrecognizedMsg stands in for a tea.Msg type Update has no case for --
// bubbletea's own internal clearScreenMsg included, since that type is
// unexported and unconstructable from this package -- to drive Update's
// pinHoldFrames countdown without it representing any real interaction.
type unrecognizedMsg struct{}

// TestRacedRepeatedOverlayOpenNeverShrinks covers the raced case: a second
// wire modal (shorter than the first) arriving before the first has been
// dismissed at all -- the clobber path openTSModal's own guard covers,
// never routing through closeModal/armPinRelease since the overlay never
// truly closes between them. The frame height must stay at the taller
// modal's own height throughout, never dipping to the shorter one's.
func TestRacedRepeatedOverlayOpenNeverShrinks(t *testing.T) {
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: []protocol.PickRow{{Value: "a"}}}
	m := New(req)
	m.width = 60

	tallRows := make([]protocol.PickRow, 20)
	for i := range tallRows {
		tallRows[i] = protocol.PickRow{Value: fmt.Sprintf("opt%02d", i), Left: []protocol.PickSegment{{Text: fmt.Sprintf("opt%02d", i)}}}
	}
	next, _ := m.Update(ModalMsg{Modal: protocol.PickModal{Message: "Sort by", Rows: tallRows}})
	m = next.(*Model)
	tallHeight := lipgloss.Height(renderView(m))

	next, _ = m.Update(ModalMsg{Modal: protocol.PickModal{
		Message: "Filter by",
		Rows:    []protocol.PickRow{{Value: "kind", Left: []protocol.PickSegment{{Text: "Kind"}}}},
	}})
	m = next.(*Model)

	if h := lipgloss.Height(renderView(m)); h != tallHeight {
		t.Fatalf("a shorter modal replacing an open one shrank the frame: tall %d, got %d", tallHeight, h)
	}
}

// TestCtrlKMenuEventActionEmitsEventAndStaysOpen covers the registry-menu
// mechanism's event branch: opening ctrl-k renders the same overlay from
// the model's own action registry (no TS round trip), and choosing an
// event:true row dispatches exactly as if its key had been pressed --
// emitting a PickEvent and leaving the picker running.
func TestCtrlKMenuEventActionEmitsEventAndStaysOpen(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
		Actions: []protocol.PickAction{
			{ID: "dispose", Label: "dispose", Scope: "item", Event: true},
		},
	}
	m := New(req)
	m.events = make(chan []byte, 4)

	next, _ := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'k'})
	m = next.(*Model)
	if m.modal == nil {
		t.Fatal("ctrl-k should open the registry menu")
	}
	if m.modal.rows[m.modal.matches[m.modal.cursor].Index].actionID != "dispose" {
		t.Fatalf("expected the declared item action first, got %+v", m.modal.rows)
	}

	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(*Model)

	mustNotQuit(t, cmd)
	if m.modal != nil {
		t.Fatal("the menu should close once a row is dispatched")
	}
	if m.result != nil {
		t.Fatalf("an event:true action must not produce a terminal result: %+v", m.result)
	}

	var line []byte
	select {
	case line = <-m.events:
	default:
		t.Fatal("expected the dispatched action's event enqueued onto m.events")
	}
	var ev protocol.PickEvent
	if err := json.Unmarshal(line, &ev); err != nil {
		t.Fatalf("event line not valid JSON: %v (%s)", err, line)
	}
	if ev.T != "event" || ev.Action != "dispose" || ev.Value == nil || *ev.Value != "a" {
		t.Fatalf("got %+v", ev)
	}
}

// TestCtrlKMenuNonEventActionYieldsTerminalResult covers the opposite
// branch: choosing a menu row whose action has no event:true ends the
// picker session with the ordinary terminal PickResult, carrying that
// action's id exactly as pressing its key would.
func TestCtrlKMenuNonEventActionYieldsTerminalResult(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
		Actions: []protocol.PickAction{
			{ID: "dispose", Label: "dispose", Scope: "item", Event: true},
			{ID: "editor", Label: "open in editor", Scope: "item"},
		},
	}
	m := New(req)

	next, _ := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'k'})
	m = next.(*Model)
	if m.modal == nil {
		t.Fatal("ctrl-k should open the registry menu")
	}

	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	m = next.(*Model)
	if got := m.modal.rows[m.modal.matches[m.modal.cursor].Index].actionID; got != "editor" {
		t.Fatalf("setup: cursor should sit on the second declared item action, got %q", got)
	}

	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(*Model)

	if m.modal != nil {
		t.Fatal("the menu should close once a row is dispatched")
	}
	if m.result == nil || m.result.Action != "editor" || m.result.Value == nil || *m.result.Value != "a" {
		t.Fatalf("got %+v", m.result)
	}
	if cmd == nil {
		t.Fatal("expected a cmd to end the session")
	}
	if !isQuitCmd(cmd) {
		t.Fatal("expected the cmd to quit the program")
	}
}

// TestInitialValuesPreselectAtConstruction covers InitialValues: a multi
// request that opens with some rows already picked must have them in
// m.selected before the first frame renders, not only once a key is
// pressed.
func TestInitialValuesPreselectAtConstruction(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		InitialValues: []string{"b", "d"},
		Rows:          []protocol.PickRow{{Value: "a"}, {Value: "b"}, {Value: "c"}, {Value: "d"}},
	}
	m := New(req)
	if !m.selected["b"] || !m.selected["d"] {
		t.Fatalf("InitialValues should preselect at construction: %+v", m.selected)
	}
	if m.selected["a"] || m.selected["c"] {
		t.Fatalf("only the InitialValues rows should be preselected: %+v", m.selected)
	}
}

// TestSpaceTogglesCursorRowSelection covers space's whole contract: it
// flips the cursor row's own selection state and, unlike tab, never moves
// the cursor.
func TestSpaceTogglesCursorRowSelection(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		Rows: []protocol.PickRow{{Value: "a"}, {Value: "b"}},
	}
	m := New(req)

	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeySpace, Text: " "})
	m = next.(*Model)
	if !m.selected["a"] {
		t.Fatalf("space should select the cursor row: %+v", m.selected)
	}
	if m.cursor != 0 {
		t.Fatalf("space must not move the cursor, got %d", m.cursor)
	}

	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeySpace, Text: " "})
	m = next.(*Model)
	if m.selected["a"] {
		t.Fatalf("a second space should deselect the cursor row: %+v", m.selected)
	}
}

// TestSpaceTypesIntoTheFilterWhenNotMulti is the negative case: a
// non-multi picker never intercepts space, so it still types a literal
// space character into the query exactly as it did before this task.
func TestSpaceTypesIntoTheFilterWhenNotMulti(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a b"}},
	}
	m := New(req)

	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeySpace, Text: " "})
	m = next.(*Model)
	if m.query != " " {
		t.Fatalf("space should type into the filter when not multi, query = %q", m.query)
	}
}

// TestTabTogglesCursorRowAndAdvances covers tab's compound behavior: it
// toggles the row under the cursor, same as space, then moves to the next
// row -- so a run of tabs walks the whole list toggling each row in turn.
func TestTabTogglesCursorRowAndAdvances(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		Rows: []protocol.PickRow{{Value: "a"}, {Value: "b"}, {Value: "c"}},
	}
	m := New(req)

	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	m = next.(*Model)
	if !m.selected["a"] {
		t.Fatalf("tab should toggle the cursor row before advancing: %+v", m.selected)
	}
	if m.cursor != 1 {
		t.Fatalf("tab should advance the cursor, got %d", m.cursor)
	}

	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	m = next.(*Model)
	if !m.selected["b"] {
		t.Fatalf("tab should also toggle the new cursor row: %+v", m.selected)
	}
	if m.cursor != 2 {
		t.Fatalf("cursor should advance again, got %d", m.cursor)
	}
	if !m.selected["a"] {
		t.Fatalf("earlier toggles must not be undone by a later tab: %+v", m.selected)
	}
}

// TestCtrlAAllVisibleThenNoneRoundTrip is the all/none half of ctrl-a: any
// unselected row still in the match set means "select everything visible";
// pressing it again once everything visible is already selected clears the
// visible set instead.
func TestCtrlAAllVisibleThenNoneRoundTrip(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		Rows: []protocol.PickRow{{Value: "a"}, {Value: "b"}, {Value: "c"}},
	}
	m := New(req)
	m.selected["a"] = true

	next, _ := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'a'})
	m = next.(*Model)
	for _, v := range []string{"a", "b", "c"} {
		if !m.selected[v] {
			t.Fatalf("ctrl-a with any unselected row visible should select every visible row, missing %q: %+v", v, m.selected)
		}
	}

	next, _ = m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'a'})
	m = next.(*Model)
	if len(m.selected) != 0 {
		t.Fatalf("ctrl-a with everything visible already selected should clear the visible set, got %+v", m.selected)
	}
}

// TestCtrlAOnlyTouchesVisibleRows covers the filtered half of the rule: a
// row the active query is hiding must never be touched by ctrl-a in either
// direction, only the rows still in the match set.
func TestCtrlAOnlyTouchesVisibleRows(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		Rows: []protocol.PickRow{
			{Value: "apple", Left: []protocol.PickSegment{{Text: "apple"}}},
			{Value: "banana", Left: []protocol.PickSegment{{Text: "banana"}}},
			{Value: "apricot", Left: []protocol.PickSegment{{Text: "apricot"}}},
		},
	}
	m := New(req)
	m.setQuery("ap")

	next, _ := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'a'})
	m = next.(*Model)

	if !m.selected["apple"] || !m.selected["apricot"] {
		t.Fatalf("ctrl-a should select every currently visible row: %+v", m.selected)
	}
	if m.selected["banana"] {
		t.Fatalf("a row hidden by the active filter must not be touched: %+v", m.selected)
	}
}

// TestSelectionSurvivesRefiltering is the keyed-by-value regression guard:
// a re-filter reorders and shrinks m.matches, but m.selected is keyed by
// row value, not match index, so a selection made before a filter narrows
// the list is still there once the filter widens back out.
func TestSelectionSurvivesRefiltering(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		Rows: []protocol.PickRow{
			{Value: "apple", Left: []protocol.PickSegment{{Text: "apple"}}},
			{Value: "banana", Left: []protocol.PickSegment{{Text: "banana"}}},
		},
	}
	m := New(req)
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeySpace, Text: " "})
	m = next.(*Model)
	if !m.selected["apple"] {
		t.Fatalf("setup: apple should be selected")
	}

	m.setQuery("ban")
	if !m.selected["apple"] {
		t.Fatalf("selection must survive a re-filter that hides the row: %+v", m.selected)
	}

	m.setQuery("")
	if len(m.matches) != 2 {
		t.Fatalf("setup: both rows should be back after clearing the query")
	}
	if !m.selected["apple"] {
		t.Fatalf("selection must still be there once the row is visible again: %+v", m.selected)
	}
}

// TestMultiEnterResultCarriesValuesInInputOrder is the result golden: enter
// answers with Values, not Value, and Values lists selections in the order
// the request declared its rows -- not the order they were toggled in --
// so a caller can zip the result against its own row list positionally.
func TestMultiEnterResultCarriesValuesInInputOrder(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		Rows: []protocol.PickRow{{Value: "a"}, {Value: "b"}, {Value: "c"}, {Value: "d"}},
	}
	m := New(req)
	m.selected["d"] = true
	m.selected["a"] = true
	m.selected["c"] = true

	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(*Model)

	if m.result == nil {
		t.Fatal("no result produced")
	}
	want := []string{"a", "c", "d"}
	if len(m.result.Values) != len(want) {
		t.Fatalf("got %+v, want %v", m.result.Values, want)
	}
	for i, v := range want {
		if m.result.Values[i] != v {
			t.Fatalf("Values must list selections in request order, got %v, want %v", m.result.Values, want)
		}
	}
	if m.result.Value != nil {
		t.Fatalf("a multi result must not also carry a single Value: %+v", m.result.Value)
	}
}

// mintSGR is theme.Mint's (#62E6A8) truecolor SGR fragment, matching the
// cyanSGR/dimSGR convention already used elsewhere in this file.
const mintSGR = "38;2;98;230;168"

// TestMultiSelectGolden is the render golden for the whole feature at once:
// the Multi board's header count, pinned selected panel, and per-row
// ◉/○ prefixes, for a small multi request with 2 preselected rows.
func TestMultiSelectGolden(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb:    []string{"rt", "worktree", "dispose"},
		Multi:         true,
		InitialValues: []string{"rt-94-deck-dev-mode", "chat-qol"},
		Rows: []protocol.PickRow{
			{Value: "rt-94-deck-dev-mode", Left: []protocol.PickSegment{{Text: "rt-94-deck-dev-mode", Tone: "text"}}},
			{Value: "chat-qol", Left: []protocol.PickSegment{{Text: "chat-qol", Tone: "text"}}},
			{Value: "bundle-ci", Left: []protocol.PickSegment{{Text: "bundle-ci", Tone: "text"}}},
			{Value: "chat-invite", Left: []protocol.PickSegment{{Text: "chat-invite", Tone: "text"}}},
			{Value: "post-wt", Left: []protocol.PickSegment{{Text: "post-wt", Tone: "text"}}},
		},
	}
	m := New(req)
	m.width = 88
	m.cursor = 2 // bundle-ci

	plain := ansi.Strip(render(m))

	if !strings.Contains(plain, "◉ 2 selected  ·  5/5") {
		t.Fatalf("header missing the multi count: %q", plain)
	}
	if !strings.Contains(plain, "selected  rt-94-deck-dev-mode · chat-qol") {
		t.Fatalf("selected panel missing or wrong: %q", plain)
	}

	lines := strings.Split(plain, "\n")
	var selectedLine, cursorLine string
	for _, l := range lines {
		if strings.Contains(l, "rt-94-deck-dev-mode") {
			selectedLine = l
		}
		if strings.Contains(l, "bundle-ci") {
			cursorLine = l
		}
	}
	if !strings.Contains(selectedLine, "◉") {
		t.Fatalf("expected a mint ◉ prefix on the selected row: %q", selectedLine)
	}
	if !strings.Contains(cursorLine, "○") {
		t.Fatalf("expected a faint ○ prefix on the unselected cursor row: %q", cursorLine)
	}

	raw := render(m)
	if !strings.Contains(raw, mintSGR) {
		t.Fatalf("expected mint coloring somewhere in the render: %q", raw)
	}
}

// TestSelectedPanelShowsLabelsOnlyNotTheFullLeftTextWithHint covers a row
// whose own Left carries a label segment followed by a hint segment (the
// board convention for "bill · on-deck/bill"): the selected panel lists
// only the label -- the hint is part of the row's own display, not the
// pick the panel is confirming.
func TestSelectedPanelShowsLabelsOnlyNotTheFullLeftTextWithHint(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		InitialValues: []string{"bill"},
		Rows: []protocol.PickRow{
			{Value: "bill", Left: []protocol.PickSegment{
				{Text: "bill", Tone: "text", Bold: true},
				{Text: " · on-deck/bill", Tone: "faint"},
			}},
		},
	}
	m := New(req)
	m.width = 60

	plain := ansi.Strip(render(m))
	if !strings.Contains(plain, "selected  bill") {
		t.Fatalf("expected the panel to list the bare label: %q", plain)
	}
	if strings.Contains(plain, "selected  bill · on-deck/bill") {
		t.Fatalf("panel must not carry the row's hint segment: %q", plain)
	}
}

// TestMultiFooterLegendMatchesTheBoard pins the Multi board's exact footer
// grammar: a lav "mark" cluster for space/tab/ctrl-a/enter, with quit still
// pinned to the far right exactly as the non-multi footer does.
func TestMultiFooterLegendMatchesTheBoard(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
	}
	m := New(req)
	m.width = 88

	lines := strings.Split(ansi.Strip(render(m)), "\n")
	footer := lines[len(lines)-1]
	if !strings.Contains(footer, "mark space toggle  tab toggle & next  ctrl-a all/none  enter confirm") {
		t.Fatalf("footer legend mismatch: %q", footer)
	}
	if !strings.HasSuffix(strings.TrimRight(footer, " "), "esc quit") {
		t.Fatalf("quit should stay pinned right: %q", footer)
	}
}

// TestSelectedPanelCountsAsChromeInHeaderBudget guards the viewport-budget
// half of the requirement: once at least one row is selected and the panel
// is actually showing, it occupies a real line between the filter and the
// top rule, so a height-bounded pane has to give the row window back one
// more line of budget than a non-multi request would, or the frame
// overflows the pane by exactly the panel's own line. InitialValues is what
// makes the panel show at all -- see TestMultiZeroSelectedHidesChipAndPanel
// for the 0-selected case this no longer covers.
func TestSelectedPanelCountsAsChromeInHeaderBudget(t *testing.T) {
	rows := make([]protocol.PickRow, 20)
	for i := range rows {
		v := fmt.Sprintf("row%02d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v, Tone: "text"}}}
	}
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true, Rows: rows,
		InitialValues: []string{"row00"},
	}
	m := New(req)
	m.width = 60
	m.height = 19

	plain := ansi.Strip(render(m))
	lines := strings.Split(plain, "\n")
	if !strings.Contains(plain, "selected  row00") {
		t.Fatalf("setup: expected the selected panel to actually be showing: %q", plain)
	}
	if len(lines) > 19 {
		t.Fatalf("rendered frame must fit the pane height (19) once the selected panel is counted as chrome: got %d lines:\n%s", len(lines), plain)
	}
}

// TestMultiZeroSelectedHidesChipAndPanel covers the zero-selected case:
// both the header's N-selected chip and the selected panel line stay off
// the frame entirely, and the panel's absence gives the row window its
// line back -- rather than a permanently-reserved but empty strip.
func TestMultiZeroSelectedHidesChipAndPanel(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
	}
	m := New(req)
	m.width = 60

	plain := ansi.Strip(render(m))
	if strings.Contains(plain, "selected") {
		t.Fatalf("0 selected must hide both the chip and the panel: %q", plain)
	}
	zeroLines := len(strings.Split(plain, "\n"))

	m.selected["a"] = true
	plainSelected := ansi.Strip(render(m))
	if !strings.Contains(plainSelected, "1 selected") {
		t.Fatalf("expected the header chip once something is selected: %q", plainSelected)
	}
	if !strings.Contains(plainSelected, "selected  a") {
		t.Fatalf("expected the selected panel once something is selected: %q", plainSelected)
	}
	selectedLines := len(strings.Split(plainSelected, "\n"))
	if selectedLines != zeroLines+1 {
		t.Fatalf("the panel line should be the only difference in chrome row count: zero=%d selected=%d", zeroLines, selectedLines)
	}
}

// TestCtrlKMenuHidesBuiltinMultiMarkActionsButKeepsCallerActions is the
// mis-dispatch regression guard: on a multi request that also declares its
// own item/global actions, the ctrl-k menu must never surface the
// synthesized toggle/toggle-next/toggle-all rows (space/tab/ctrl-a are
// hardcoded in Update and never meant to be selected from a menu -- doing
// so used to fall through resultForAction's generic branch and silently
// terminate the session with a bogus PickResult{Action:"toggle"}), nor the
// keybar-only select/cancel/back defaults, while a caller's own declared
// action still appears and still dispatches through its real path (event
// stays open, non-event ends the session).
func TestCtrlKMenuHidesBuiltinMultiMarkActionsButKeepsCallerActions(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
		Actions: []protocol.PickAction{
			{ID: "dispose", Label: "dispose", Scope: "item", Group: "worktree", Event: true},
			{ID: "refresh", Label: "refresh", Scope: "global", Group: "nav"},
		},
	}
	m := New(req)
	m.events = make(chan []byte, 4)

	next, _ := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'k'})
	m = next.(*Model)
	if m.modal == nil {
		t.Fatal("ctrl-k should open the registry menu")
	}

	var ids []string
	for _, r := range m.modal.rows {
		ids = append(ids, r.actionID)
	}
	for _, hidden := range []string{"toggle", "toggle-next", "toggle-all", "select", "cancel", "back"} {
		for _, id := range ids {
			if id == hidden {
				t.Fatalf("built-in/injected action %q must never appear as a ctrl-k menu row, got rows %+v", hidden, ids)
			}
		}
	}

	var sawDispose, sawRefresh bool
	for _, id := range ids {
		sawDispose = sawDispose || id == "dispose"
		sawRefresh = sawRefresh || id == "refresh"
	}
	if !sawDispose || !sawRefresh {
		t.Fatalf("caller-declared item/global actions must still appear in the menu, got %+v", ids)
	}

	if m.modal.rows[m.modal.matches[m.modal.cursor].Index].actionID != "dispose" {
		t.Fatalf("setup: expected dispose (the declared item action) first, got %+v", m.modal.rows)
	}
	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(*Model)

	mustNotQuit(t, cmd)
	if m.result != nil {
		t.Fatalf("no menu path may produce a builtin mis-dispatch result: %+v", m.result)
	}

	var line []byte
	select {
	case line = <-m.events:
	default:
		t.Fatal("expected the dispose action's event enqueued")
	}
	var ev protocol.PickEvent
	if err := json.Unmarshal(line, &ev); err != nil {
		t.Fatalf("event line not valid JSON: %v (%s)", err, line)
	}
	if ev.Action != "dispose" {
		t.Fatalf("caller action should dispatch as itself, got %+v", ev)
	}
}

// TestMultiExitActionCarriesTheCheckedSelectionAsValues covers commit's
// ctrl-d: a non-select EXIT action in a multi session must carry the whole
// checked set, not just the cursor row, so a bulk operation (discard) acts
// on the selection the user actually built up rather than wherever the
// cursor happens to be sitting.
func TestMultiExitActionCarriesTheCheckedSelectionAsValues(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		Rows: []protocol.PickRow{{Value: "a"}, {Value: "b"}, {Value: "c"}},
		Actions: []protocol.PickAction{
			{ID: "discard", Label: "discard", Key: "ctrl-d", Scope: "global"},
		},
	}
	m := New(req)
	m.selected["c"] = true
	m.selected["a"] = true
	m.cursor = 1 // sits on "b", which is NOT checked

	next, cmd := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'd'})
	m = next.(*Model)

	if m.result == nil {
		t.Fatal("no result produced")
	}
	if m.result.Action != "discard" {
		t.Fatalf("got action %q", m.result.Action)
	}
	want := []string{"a", "c"}
	if len(m.result.Values) != len(want) {
		t.Fatalf("got %+v, want %v", m.result.Values, want)
	}
	for i, v := range want {
		if m.result.Values[i] != v {
			t.Fatalf("Values must list the checked set in request order, got %v, want %v", m.result.Values, want)
		}
	}
	if m.result.Value == nil || *m.result.Value != "b" {
		t.Fatalf("Value must still carry the cursor row alongside Values, got %+v", m.result.Value)
	}
	if cmd == nil {
		t.Fatal("expected a cmd to end the session")
	}
	if !isQuitCmd(cmd) {
		t.Fatal("expected the cmd to quit the program")
	}
}

// TestAcceptNoMatchEnterOnNoMatchResolvesWithNilValueAndQuery: a request opted
// into AcceptNoMatch resolves enter on a no-match filter with a terminal select
// result carrying the typed query, instead of leaving the picker open with
// nothing to select.
func TestAcceptNoMatchEnterOnNoMatchResolvesWithNilValueAndQuery(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, InitialQuery: "zzz", AcceptNoMatch: true,
		Rows: []protocol.PickRow{{Value: "restore"}, {Value: "list"}},
	}
	m := New(req)
	if len(m.matches) != 0 {
		t.Fatalf("setup: expected no matches for query %q, got %d", m.query, len(m.matches))
	}

	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(*Model)

	if m.result == nil {
		t.Fatal("no result produced")
	}
	if m.result.Action != idSelect || m.result.Value != nil || m.result.Query != "zzz" {
		t.Fatalf("got %+v", m.result)
	}
	if cmd == nil {
		t.Fatal("expected a cmd to end the session")
	}
	if !isQuitCmd(cmd) {
		t.Fatal("expected the cmd to quit the program")
	}
}

// TestEnterOnNoMatchWithoutAcceptNoMatchProducesNoResult pins the other half
// of AcceptNoMatch's contract: a request that never opts in keeps today's
// behavior unchanged -- enter on a no-match filter never fabricates a result.
func TestEnterOnNoMatchWithoutAcceptNoMatchProducesNoResult(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, InitialQuery: "zzz",
		Rows: []protocol.PickRow{{Value: "restore"}, {Value: "list"}},
	}
	m := New(req)
	if len(m.matches) != 0 {
		t.Fatalf("setup: expected no matches for query %q, got %d", m.query, len(m.matches))
	}

	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(*Model)

	if m.result != nil {
		t.Fatalf("enter on no-match without AcceptNoMatch must not set a result, got %+v", m.result)
	}
}

// ─── mouse ──────────────────────────────────────────────────────────────

// TestMouseHoverSetsHoverNotCursor is the Mouse board's central invariant:
// motion over a row updates the render hint (m.hover) but never steals the
// keyboard's own place in the list.
func TestMouseHoverSetsHoverNotCursor(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}},
			{Value: "b", Left: []protocol.PickSegment{{Text: "b"}}},
		},
	}
	m := New(req)
	m.width = 60
	render(m)

	next, _ := m.Update(tea.MouseMotionMsg{X: 2, Y: 4})
	m = next.(*Model)
	if m.hover != 1 {
		t.Fatalf("hovering row 1's line should set hover=1, got %d", m.hover)
	}
	if m.cursor != 0 {
		t.Fatalf("hover must never move the keyboard cursor, got cursor=%d", m.cursor)
	}

	next, _ = m.Update(tea.MouseMotionMsg{X: 2, Y: 1})
	m = next.(*Model)
	if m.hover != -1 {
		t.Fatalf("motion off any row should clear hover, got %d", m.hover)
	}
}

// TestMouseClickSetsCursorNotAccept pins the single-click half of the
// board's click/double-click split: a click moves focus only, it never
// terminates the session.
func TestMouseClickSetsCursorNotAccept(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}},
			{Value: "b", Left: []protocol.PickSegment{{Text: "b"}}},
		},
	}
	m := New(req)
	m.width = 60
	render(m)

	next, cmd := m.Update(tea.MouseClickMsg{X: 2, Y: 4, Button: tea.MouseLeft})
	m = next.(*Model)
	if cmd != nil {
		t.Fatal("a single click must not end the session")
	}
	if m.cursor != 1 {
		t.Fatalf("click should move the cursor to row 1, got %d", m.cursor)
	}
	if m.result != nil {
		t.Fatalf("a single click must not produce a result: %+v", m.result)
	}
}

// TestMouseDoubleClickAcceptsTheRowWithinTheWindow pins the double-click
// half: two clicks on the same row inside doubleClickWindow accept exactly
// like enter would.
func TestMouseDoubleClickAcceptsTheRowWithinTheWindow(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}},
			{Value: "b", Left: []protocol.PickSegment{{Text: "b"}}},
		},
	}
	m := New(req)
	m.width = 60
	render(m)
	now := time.Now()
	m.nowFn = func() time.Time { return now }

	next, cmd := m.Update(tea.MouseClickMsg{X: 2, Y: 3, Button: tea.MouseLeft})
	m = next.(*Model)
	if cmd != nil {
		t.Fatal("the first click of a pair must not accept")
	}

	now = now.Add(100 * time.Millisecond)
	next, cmd = m.Update(tea.MouseClickMsg{X: 2, Y: 3, Button: tea.MouseLeft})
	m = next.(*Model)
	if cmd == nil {
		t.Fatal("a second click on the same row within the window should accept")
	}
	if !isQuitCmd(cmd) {
		t.Fatalf("expected a quit command, got %v", cmd())
	}
	if m.result == nil || m.result.Value == nil || *m.result.Value != "a" {
		t.Fatalf("expected a select result for row a, got %+v", m.result)
	}
}

// TestMouseClicksFarApartDoNotDoubleClick is the negative case: two clicks
// on the same row outside doubleClickWindow are two independent single
// clicks, not a pair.
func TestMouseClicksFarApartDoNotDoubleClick(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}},
			{Value: "b", Left: []protocol.PickSegment{{Text: "b"}}},
		},
	}
	m := New(req)
	m.width = 60
	render(m)
	now := time.Now()
	m.nowFn = func() time.Time { return now }

	m.Update(tea.MouseClickMsg{X: 2, Y: 3, Button: tea.MouseLeft})

	now = now.Add(2 * time.Second)
	next, cmd := m.Update(tea.MouseClickMsg{X: 2, Y: 3, Button: tea.MouseLeft})
	m = next.(*Model)
	if cmd != nil {
		t.Fatal("clicks outside the double-click window must not accept")
	}
	if m.cursor != 0 {
		t.Fatalf("the second click should still move the cursor, got %d", m.cursor)
	}
}

// TestMouseClickMarkerCellTogglesSelectionAndFocusesRow covers the multi
// board's marker column: it toggles the row's selection, distinct from
// accepting, and per the Mouse board also focuses that row.
func TestMouseClickMarkerCellTogglesSelectionAndFocusesRow(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		Rows: []protocol.PickRow{
			{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}},
			{Value: "b", Left: []protocol.PickSegment{{Text: "b"}}},
		},
	}
	m := New(req)
	m.width = 60
	render(m)

	// Y=4, not 5: with nothing selected yet, the selected panel line is
	// hidden (see showSelectedPanel), so row b sits one line higher than a
	// permanently-shown panel would have put it.
	next, cmd := m.Update(tea.MouseClickMsg{X: 2, Y: 4, Button: tea.MouseLeft})
	m = next.(*Model)
	if cmd != nil {
		t.Fatal("a marker click must not end the session")
	}
	if !m.selected["b"] {
		t.Fatalf("clicking the marker cell should toggle selection, got selected=%+v", m.selected)
	}
	if m.cursor != 1 {
		t.Fatalf("a marker click should also focus its row, got cursor=%d", m.cursor)
	}
}

// TestMouseRightClickOpensMenuAtRow pins right-click: it focuses the row
// under the pointer and opens the same overlay ctrl-k does.
func TestMouseRightClickOpensMenuAtRow(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}},
			{Value: "b", Left: []protocol.PickSegment{{Text: "b"}}},
		},
		Actions: []protocol.PickAction{
			{ID: "editor", Label: "open in editor", Scope: "item"},
		},
	}
	m := New(req)
	m.width = 60
	render(m)

	next, _ := m.Update(tea.MouseClickMsg{X: 2, Y: 4, Button: tea.MouseRight})
	m = next.(*Model)
	if m.cursor != 1 {
		t.Fatalf("right-click should focus the clicked row, got cursor=%d", m.cursor)
	}
	if m.modal == nil {
		t.Fatal("right-click should open the registry menu")
	}
}

// modalRowCell returns a frame cell (x,y) inside the recorded hit-zone of
// modal match `index`, for driving a mouse event straight at that overlay
// row. It reads the zones recordModalZones laid down on the last render, so
// a test never has to re-derive the compositor's centering offset by hand --
// exactly the offset math the code under test owns.
func modalRowCell(m *Model, index int) (x, y int, ok bool) {
	for yy, zs := range m.modalZones.byY {
		for _, z := range zs {
			if z.kind == zoneModalRow && z.row == index {
				return z.xStart + 1, yy, true
			}
		}
	}
	return 0, 0, false
}

// TestModalMouseMotionHoversAndRendersHoverBg pins mouse hover inside the
// overlay: motion over a non-cursor menu row sets modalHover and paints that
// row with HoverBg, the same #251E3D the base list hover uses. Fails on the
// pre-fix mouse-inert modal (motion early-returned, modalRowLine had no hover
// tone at all).
func TestModalMouseMotionHoversAndRendersHoverBg(t *testing.T) {
	const hoverBgSGR = "48;2;37;30;61"
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
	}
	m := New(req)
	m.width = 60
	m.openTSModal(protocol.PickModal{
		Message: "Sort by",
		Rows: []protocol.PickRow{
			{Value: "size", Left: []protocol.PickSegment{{Text: "Size"}}},
			{Value: "name", Left: []protocol.PickSegment{{Text: "Name"}}},
		},
	})
	renderView(m) // records the overlay's frame-space hit-zones

	x, y, ok := modalRowCell(m, 1)
	if !ok {
		t.Fatal("setup: expected a hit-zone for modal row 1")
	}

	next, _ := m.Update(tea.MouseMotionMsg{X: x, Y: y})
	m = next.(*Model)
	if m.modalHover != 1 {
		t.Fatalf("motion over modal row 1 should set modalHover=1, got %d", m.modalHover)
	}
	if m.modal.cursor != 0 {
		t.Fatalf("modal hover must never move the overlay's keyboard cursor, got %d", m.modal.cursor)
	}

	lines := strings.Split(renderView(m), "\n")
	if y >= len(lines) || !strings.Contains(lines[y], hoverBgSGR) {
		t.Fatalf("the hovered modal row (frame line %d) should carry HoverBg %s: %q", y, hoverBgSGR, lines[y])
	}
}

// TestModalMouseClickOnRowActivatesLikeKeyboard pins click-activate parity:
// clicking a menu row dispatches through the very path a keyboard select of
// that same row takes, so the terminal result is byte-identical. Fails on the
// pre-fix modal (click early-returned, leaving the overlay open with no
// result).
func TestModalMouseClickOnRowActivatesLikeKeyboard(t *testing.T) {
	newModel := func() *Model {
		req := protocol.PickRequest{
			T: "pick", Protocol: protocol.Version,
			Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
			Actions: []protocol.PickAction{
				{ID: "editor", Label: "open in editor", Scope: "item"},
				{ID: "dispose", Label: "dispose", Scope: "item"},
			},
		}
		m := New(req)
		m.width = 60
		return m
	}

	// Keyboard baseline: open the menu, move to row 1 (dispose), enter.
	kb := newModel()
	next, _ := kb.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'k'})
	kb = next.(*Model)
	next, _ = kb.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	kb = next.(*Model)
	next, kbCmd := kb.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	kb = next.(*Model)

	// Mouse: open the menu, click the same row (match index 1).
	ms := newModel()
	next, _ = ms.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'k'})
	ms = next.(*Model)
	renderView(ms)
	x, y, ok := modalRowCell(ms, 1)
	if !ok {
		t.Fatal("setup: expected a hit-zone for modal row 1")
	}
	next, msCmd := ms.Update(tea.MouseClickMsg{X: x, Y: y, Button: tea.MouseLeft})
	ms = next.(*Model)

	if ms.modal != nil {
		t.Fatal("clicking a menu row should close the overlay")
	}
	if kb.result == nil || ms.result == nil {
		t.Fatalf("both paths should set a result: kb=%+v mouse=%+v", kb.result, ms.result)
	}
	if ms.result.Action != kb.result.Action || ms.result.Action != "dispose" {
		t.Fatalf("mouse-click result %q must match keyboard-select 'dispose' (kb=%q)", ms.result.Action, kb.result.Action)
	}
	if !isQuitCmd(msCmd) {
		t.Fatalf("mouse activation of a non-event action should quit, got %v", msCmd())
	}
	if !isQuitCmd(kbCmd) {
		t.Fatalf("keyboard activation of a non-event action should quit, got %v", kbCmd())
	}
}

// TestModalMouseClickOutsideDismissesLikeEsc pins outside-click dismissal: a
// press outside the box closes the overlay exactly as esc does, answering a
// TS-driven modal null and repainting rather than quitting. Fails on the
// pre-fix modal (click early-returned, the box stayed open).
func TestModalMouseClickOutsideDismissesLikeEsc(t *testing.T) {
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}}}
	m := New(req)
	m.width = 60
	m.events = make(chan []byte, 4)
	m.openTSModal(protocol.PickModal{
		Message: "Sort by",
		Rows: []protocol.PickRow{
			{Value: "size", Left: []protocol.PickSegment{{Text: "Size"}}},
			{Value: "name", Left: []protocol.PickSegment{{Text: "Name"}}},
		},
	})
	renderView(m)

	if m.modalBox.contains(0, 0) {
		t.Fatal("setup: the frame's top-left corner should be outside the centered modal box")
	}

	next, cmd := m.Update(tea.MouseClickMsg{X: 0, Y: 0, Button: tea.MouseLeft})
	m = next.(*Model)
	if m.modal != nil {
		t.Fatal("a press outside the box should dismiss the overlay")
	}
	if isQuitCmd(cmd) {
		t.Fatal("dismissing the overlay must not quit the picker")
	}

	var line []byte
	select {
	case line = <-m.events:
	default:
		t.Fatal("dismissing a TS modal should enqueue a null modal-result, the same as esc")
	}
	var mr protocol.PickModalResult
	if err := json.Unmarshal(line, &mr); err != nil {
		t.Fatalf("modal-result line not valid JSON: %v (%s)", err, line)
	}
	if mr.T != "modal-result" || mr.Value != nil {
		t.Fatalf("an outside-click dismissal should answer null, got %+v", mr)
	}
}

// TestModalMouseClickInsideOffRowIsInert pins the middle case: a press inside
// the box but not on any row (the header line) neither activates nor
// dismisses -- it is inert, like a click on the base list's own chrome.
func TestModalMouseClickInsideOffRowIsInert(t *testing.T) {
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}}}
	m := New(req)
	m.width = 60
	m.events = make(chan []byte, 4)
	m.openTSModal(protocol.PickModal{
		Message: "Sort by",
		Rows:    []protocol.PickRow{{Value: "size", Left: []protocol.PickSegment{{Text: "Size"}}}},
	})
	renderView(m)

	// The header line sits one row below the box's top border, inside it.
	headerX, headerY := m.modalBox.x0+2, m.modalBox.y0+1
	if _, ok := m.modalZones.at(headerX, headerY); ok {
		t.Fatalf("setup: the header cell (%d,%d) should carry no row hit-zone", headerX, headerY)
	}
	if !m.modalBox.contains(headerX, headerY) {
		t.Fatalf("setup: the header cell (%d,%d) should be inside the box", headerX, headerY)
	}

	next, cmd := m.Update(tea.MouseClickMsg{X: headerX, Y: headerY, Button: tea.MouseLeft})
	m = next.(*Model)
	if m.modal == nil {
		t.Fatal("a press on the box's own chrome must not dismiss the overlay")
	}
	if cmd != nil {
		t.Fatal("an inert modal press must return no command")
	}
	select {
	case <-m.events:
		t.Fatal("an inert modal press must not enqueue a modal-result")
	default:
	}
}

// TestMouseClickMapsThroughGroupHeadersToTheCorrectMatchIndex is the
// hit-zone regression guard the reviewer will scrutinize hardest: Y→row
// cannot be a fixed-chrome-offset subtraction, because an interleaved group
// header consumes a display line without being a row itself. The exact
// chrome layout here (breadcrumb=0, filter=1, rule=2, header=3, row=4,
// header=5, row=6, row=7) is pinned by
// TestGroupHeadersRenderAboveFirstRowOfEachGroup already; this test reuses
// it to prove clicks resolve against it correctly.
func TestMouseClickMapsThroughGroupHeadersToTheCorrectMatchIndex(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{Value: "adjuster+backend", Group: "presets", Left: []protocol.PickSegment{{Text: "adjuster + backend", Tone: "text"}}},
			{Value: "backend", Group: "packages", Left: []protocol.PickSegment{{Text: "backend", Tone: "text"}}},
			{Value: "adjuster", Group: "packages", Left: []protocol.PickSegment{{Text: "adjuster", Tone: "text"}}},
		},
	}
	m := New(req)
	m.width = 60
	plain := ansi.Strip(render(m))
	lines := strings.Split(plain, "\n")
	if !strings.Contains(lines[3], "PRESETS") || !strings.Contains(lines[4], "adjuster + backend") ||
		!strings.Contains(lines[5], "PACKAGES") || !strings.Contains(lines[6], "backend") || !strings.Contains(lines[7], "adjuster") {
		t.Fatalf("setup: unexpected chrome layout:\n%s", plain)
	}

	next, _ := m.Update(tea.MouseClickMsg{X: 5, Y: 4, Button: tea.MouseLeft})
	m = next.(*Model)
	if m.cursor != 0 {
		t.Fatalf("a click just below the filter/rule (the row area's first line) should select match 0, got cursor=%d", m.cursor)
	}

	next, _ = m.Update(tea.MouseClickMsg{X: 5, Y: 5, Button: tea.MouseLeft})
	m = next.(*Model)
	if m.cursor != 0 {
		t.Fatalf("a click on a group header line must be inert, got cursor=%d", m.cursor)
	}

	next, _ = m.Update(tea.MouseClickMsg{X: 5, Y: 6, Button: tea.MouseLeft})
	m = next.(*Model)
	if m.cursor != 1 {
		t.Fatalf("the row right below the PACKAGES header is match 1 (backend), not match 2 -- a naive Y-offset would miscount the header line, got cursor=%d", m.cursor)
	}

	next, _ = m.Update(tea.MouseClickMsg{X: 5, Y: 7, Button: tea.MouseLeft})
	m = next.(*Model)
	if m.cursor != 2 {
		t.Fatalf("expected match 2 (adjuster), got cursor=%d", m.cursor)
	}
}

// TestMouseClickAccountsForViewportScrollOffset covers the other half of
// the hit-zone math: once the window has scrolled, the row under a given Y
// is top+i, not i -- render() records zones against the actual scrolled
// window, not the unscrolled match order.
func TestMouseClickAccountsForViewportScrollOffset(t *testing.T) {
	rows := make([]protocol.PickRow, 20)
	for i := range rows {
		v := fmt.Sprintf("row%02d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v, Tone: "text"}}}
	}
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: rows, Cap: 5}
	m := New(req)
	m.width = 60
	m.cursor = 10

	plain := ansi.Strip(render(m))
	lines := strings.Split(plain, "\n")
	top := m.viewportTop
	if top == 0 {
		t.Fatalf("setup: expected the window to have scrolled, top=%d", top)
	}
	wantRow := fmt.Sprintf("row%02d", top)
	if !strings.Contains(lines[3], wantRow) {
		t.Fatalf("setup: expected %q on the row area's first line, got %q", wantRow, lines[3])
	}

	next, _ := m.Update(tea.MouseClickMsg{X: 2, Y: 3, Button: tea.MouseLeft})
	m = next.(*Model)
	if m.cursor != top {
		t.Fatalf("clicking the window's first row line should select match index %d (the scrolled-to row), got cursor=%d", top, m.cursor)
	}
}

// TestMouseWheelMovesViewportButLeavesCursorInPlace pins the board's wheel
// rule: a modest scroll (the cursor stays comfortably within the window's
// scrolloff margin) moves only m.viewportTop.
func TestMouseWheelMovesViewportButLeavesCursorInPlace(t *testing.T) {
	rows := make([]protocol.PickRow, 30)
	for i := range rows {
		v := fmt.Sprintf("row%02d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v, Tone: "text"}}}
	}
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: rows, Cap: 10}
	m := New(req)
	m.width = 60
	m.cursor = 15
	render(m)
	if m.viewportTop != 8 {
		t.Fatalf("setup: expected top=8 once placeTop centers on cursor=15, got %d", m.viewportTop)
	}

	next, _ := m.Update(tea.MouseWheelMsg{Button: tea.MouseWheelDown})
	m = next.(*Model)
	if m.viewportTop != 11 {
		t.Fatalf("wheel down should move the viewport by wheelStep, got top=%d", m.viewportTop)
	}
	if m.cursor != 15 {
		t.Fatalf("the cursor must stay put while it's still within the window's margin, got cursor=%d", m.cursor)
	}
}

// TestMouseWheelClampsCursorWhenItWouldScrollOffscreen covers the edge
// case: scrolling far enough that the cursor's row would leave the window
// moves the cursor to the nearest row still inside it, and that new
// position must hold across the very next render (placeTop must not
// silently re-center the window back toward where the cursor used to sit).
func TestMouseWheelClampsCursorWhenItWouldScrollOffscreen(t *testing.T) {
	rows := make([]protocol.PickRow, 30)
	for i := range rows {
		v := fmt.Sprintf("row%02d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v, Tone: "text"}}}
	}
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: rows, Cap: 10}
	m := New(req)
	m.width = 60
	render(m)
	if m.cursor != 0 || m.viewportTop != 0 {
		t.Fatalf("setup: expected cursor=0 top=0, got cursor=%d top=%d", m.cursor, m.viewportTop)
	}

	next, _ := m.Update(tea.MouseWheelMsg{Button: tea.MouseWheelDown})
	m = next.(*Model)
	if m.viewportTop != 3 {
		t.Fatalf("expected the viewport to move by wheelStep, got top=%d", m.viewportTop)
	}
	if m.cursor != 5 {
		t.Fatalf("row 0 scrolled out of view, so the cursor should clamp to the window's own scrolloff-safe edge (top+2=5), got cursor=%d", m.cursor)
	}

	render(m)
	if m.viewportTop != 3 {
		t.Fatalf("re-rendering after the wheel scroll must not snap the viewport back toward the cursor: top=%d", m.viewportTop)
	}
}

// TestBreadcrumbClickEmitsCrumbEventOnlyWhenOptedIn pins the protocol gate:
// a breadcrumb segment click emits {action:"crumb", value:"<index>"} only
// when the request set crumbEvents, and is otherwise inert.
func TestBreadcrumbClickEmitsCrumbEventOnlyWhenOptedIn(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb:  []string{"rt", "worktree", "dispose"},
		Rows:        []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
		CrumbEvents: true,
	}
	m := New(req)
	m.width = 60
	m.events = make(chan []byte, 4)

	plain := ansi.Strip(render(m))
	idx := strings.Index(plain, "worktree")
	if idx < 0 {
		t.Fatalf("setup: expected worktree in the breadcrumb: %q", plain)
	}

	next, _ := m.Update(tea.MouseClickMsg{X: idx, Y: 0, Button: tea.MouseLeft})
	m = next.(*Model)

	var line []byte
	select {
	case line = <-m.events:
	default:
		t.Fatal("expected a crumb event to be enqueued")
	}
	var ev protocol.PickEvent
	if err := json.Unmarshal(line, &ev); err != nil {
		t.Fatalf("event line not valid JSON: %v (%s)", err, line)
	}
	if ev.Action != "crumb" || ev.Value == nil || *ev.Value != "1" {
		t.Fatalf("expected a crumb event for segment 1 (worktree), got %+v", ev)
	}

	optedOut := req
	optedOut.CrumbEvents = false
	m2 := New(optedOut)
	m2.width = 60
	m2.events = make(chan []byte, 4)
	render(m2)

	next2, _ := m2.Update(tea.MouseClickMsg{X: idx, Y: 0, Button: tea.MouseLeft})
	m2 = next2.(*Model)
	select {
	case line := <-m2.events:
		t.Fatalf("a crumb click must be inert without crumbEvents, got %s", line)
	default:
	}
}

// TestKeybarKeyClickDispatchesTheAction pins keybar keys as buttons: a
// click on a registry action's key+label run dispatches it exactly as its
// bound key would.
func TestKeybarKeyClickDispatchesTheAction(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
	}
	m := New(req)
	m.width = 60

	plain := ansi.Strip(render(m))
	lines := strings.Split(plain, "\n")
	footer := lines[len(lines)-1]
	keybarY := len(lines) - 1
	idx := strings.Index(footer, "esc")
	if idx < 0 {
		t.Fatalf("setup: expected esc in the footer: %q", footer)
	}

	next, cmd := m.Update(tea.MouseClickMsg{X: idx, Y: keybarY, Button: tea.MouseLeft})
	m = next.(*Model)
	if cmd == nil {
		t.Fatal("clicking esc should end the session")
	}
	if !isQuitCmd(cmd) {
		t.Fatalf("expected a quit command, got %v", cmd())
	}
	if m.result == nil || m.result.Action != "cancel" {
		t.Fatalf("expected a cancel result, got %+v", m.result)
	}
}

// TestKeybarKeyClickTogglesForBuiltinMultiMarkActions covers dispatchAction's
// special case: the built-in mark-cluster actions (toggle/toggle-next/
// toggle-all) run their hardcoded handler on a keybar click exactly as
// their real key does, rather than mis-firing through the generic
// event/result dispatch the way a caller-declared action would.
func TestKeybarKeyClickTogglesForBuiltinMultiMarkActions(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Multi: true,
		Rows: []protocol.PickRow{{Value: "a", Left: []protocol.PickSegment{{Text: "a"}}}},
	}
	m := New(req)
	m.width = 88

	plain := ansi.Strip(render(m))
	lines := strings.Split(plain, "\n")
	footer := lines[len(lines)-1]
	keybarY := len(lines) - 1
	idx := strings.Index(footer, "space")
	if idx < 0 {
		t.Fatalf("setup: expected space in the footer: %q", footer)
	}

	next, cmd := m.Update(tea.MouseClickMsg{X: idx, Y: keybarY, Button: tea.MouseLeft})
	m = next.(*Model)
	if cmd != nil {
		t.Fatal("toggle must not end the session")
	}
	if !m.selected["a"] {
		t.Fatalf("clicking the space key should toggle the cursor row, got selected=%+v", m.selected)
	}
}

// TestModifierPressAndReleaseTracksHeldState pins the held-state seam
// itself: a bare modifier key's press sets it, its release clears it, and
// it is never mistaken for typed input.
func TestModifierPressAndReleaseTracksHeldState(t *testing.T) {
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: []protocol.PickRow{{Value: "a"}}}
	m := New(req)

	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyLeftAlt})
	m = next.(*Model)
	if !m.held.alt {
		t.Fatal("a bare alt press should set held.alt")
	}
	if m.query != "" {
		t.Fatalf("a bare modifier press must never be typed into the query, got %q", m.query)
	}

	next, _ = m.Update(tea.KeyReleaseMsg{Code: tea.KeyLeftAlt})
	m = next.(*Model)
	if m.held.alt {
		t.Fatal("alt release should clear held.alt")
	}

	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyRightCtrl})
	m = next.(*Model)
	if !m.held.ctrl {
		t.Fatal("a bare right-ctrl press should set held.ctrl")
	}
	next, _ = m.Update(tea.KeyReleaseMsg{Code: tea.KeyRightCtrl})
	m = next.(*Model)
	if m.held.ctrl {
		t.Fatal("ctrl release should clear held.ctrl")
	}
}

// TestAltNotHeldRendersIdenticallyRegardlessOfWithArgs pins the additive-mode
// guarantee: a request whose rows carry PickRow.WithArgs renders byte
// identically whether or not any row claims it, as long as alt itself is
// never held -- the with-args chrome must never leak in through the data
// alone.
func TestAltNotHeldRendersIdenticallyRegardlessOfWithArgs(t *testing.T) {
	plain := func(withArgs bool) string {
		req := protocol.PickRequest{
			T: "pick", Protocol: protocol.Version,
			Breadcrumb: []string{"rt", "worktree"},
			Rows: []protocol.PickRow{
				{Value: "provision", Left: []protocol.PickSegment{{Text: "provision"}}, WithArgs: withArgs},
				{Value: "list", Left: []protocol.PickSegment{{Text: "list"}}},
			},
		}
		m := New(req)
		m.width = 92
		return render(m)
	}
	if got, want := plain(true), plain(false); got != want {
		t.Fatalf("alt-not-held render must not vary with WithArgs:\nwith:    %q\nwithout: %q", got, want)
	}
	if strings.Contains(ansi.Strip(plain(true)), "with args") {
		t.Fatalf("no with-args affordance should render while alt is not held: %q", ansi.Strip(plain(true)))
	}
}

// TestAltHeldRendersHeaderBadgeCursorBadgeAndRowDim is the Modifiers board's
// "⌥ held" golden: the header carries the "with args" badge, the cursor row
// (WithArgs true) swaps its right side for the "pick args" badge, a
// non-cursor WithArgs row keeps its ordinary styling, and a non-cursor
// WithArgs-false row fades to Faint -- all three only once alt is actually
// held. A second pass moves the cursor onto a WithArgs-false row itself:
// the board keeps the focused row full-strength under its own SelBg
// highlight, so the cursor row's own left text must never dim, even though
// it has no args to preview -- only a still-non-cursor no-args row (here,
// "dispose") dims.
func TestAltHeldRendersHeaderBadgeCursorBadgeAndRowDim(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb: []string{"rt", "worktree"},
		Rows: []protocol.PickRow{
			{Value: "provision", Left: []protocol.PickSegment{{Text: "provision", Tone: "text", Bold: true}}, WithArgs: true},
			{Value: "create", Left: []protocol.PickSegment{{Text: "create", Tone: "text", Bold: true}}, WithArgs: true},
			{Value: "list", Left: []protocol.PickSegment{{Text: "list", Tone: "text", Bold: true}}},
			{Value: "dispose", Left: []protocol.PickSegment{{Text: "dispose", Tone: "text", Bold: true}}},
		},
	}
	m := New(req)
	m.width = 92

	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyLeftAlt})
	m = next.(*Model)
	if !m.held.alt {
		t.Fatal("setup: alt press should set held.alt")
	}

	lines := strings.Split(render(m), "\n")
	header := lines[0]
	cursorLine := lines[3] // rule, then the cursor row (provision) first
	createLine := lines[4] // non-cursor, WithArgs true
	listLine := lines[5]   // non-cursor, WithArgs false
	const lavSGR = "38;2;189;147;249"
	const faintSGR = "38;2;110;102;140"

	if !strings.Contains(ansi.Strip(header), "with args") {
		t.Fatalf("header should carry the with-args badge while alt is held: %q", ansi.Strip(header))
	}
	if !strings.Contains(header, lavSGR) {
		t.Fatalf("with-args badge should be lav-colored: %q", header)
	}

	if !strings.Contains(ansi.Strip(cursorLine), "enter → pick args") {
		t.Fatalf("cursor row (WithArgs) should carry the pick-args badge: %q", ansi.Strip(cursorLine))
	}

	if strings.Contains(ansi.Strip(createLine), "enter → pick args") {
		t.Fatalf("only the cursor row gets the pick-args badge: %q", ansi.Strip(createLine))
	}
	if strings.Contains(createLine, faintSGR) {
		t.Fatalf("a WithArgs row must not dim while alt is held: %q", createLine)
	}

	if !strings.Contains(listLine, faintSGR) {
		t.Fatalf("a non-cursor row without WithArgs should fade to Faint while alt is held: %q", listLine)
	}

	// Move the cursor onto "list" (WithArgs false, index 2): the focused
	// row's own left text must stay full-strength, while "dispose" (still
	// non-cursor, also WithArgs false) still dims.
	m.cursor = 2
	lines = strings.Split(render(m), "\n")
	focusedNoArgsLine := lines[5] // cursor now on "list"
	disposeLine := lines[6]       // non-cursor, WithArgs false

	if strings.Contains(focusedNoArgsLine, faintSGR) {
		t.Fatalf("the cursor row's own left text must never dim, even with no args: %q", focusedNoArgsLine)
	}
	if !strings.Contains(disposeLine, faintSGR) {
		t.Fatalf("a non-cursor row without WithArgs should still fade to Faint: %q", disposeLine)
	}
}

// TestCtrlNotHeldRendersTheSingleLineKeybar pins today's baseline: the
// footer stays one line, the real range indicator renders when the list
// overflows, and nothing claims an expanded keymap.
func TestCtrlNotHeldRendersTheSingleLineKeybar(t *testing.T) {
	rows := make([]protocol.PickRow, 20)
	for i := range rows {
		v := fmt.Sprintf("row%02d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v, Tone: "text"}}}
	}
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: rows, Cap: 5}
	m := New(req)
	m.width = 60

	lines := strings.Split(render(m), "\n")
	if strings.Contains(ansi.Strip(lines[0]), "⌃ keys") {
		t.Fatalf("no ctrl-held header badge should render while ctrl is not held: %q", ansi.Strip(lines[0]))
	}
	footer := ansi.Strip(lines[len(lines)-1])
	if strings.Contains(footer, "showing all keys") {
		t.Fatalf("no expansion claim should render while ctrl is not held: %q", footer)
	}
	if !strings.Contains(footer, "1-5 of 20") {
		t.Fatalf("the range indicator must render: %q", footer)
	}
}

// TestCtrlHeldRendersTwoLineGroupedKeybar is the Modifiers board's "⌃ held"
// golden: the header carries the "⌃ keys" badge, the footer grows to two
// lines, each declared group renders whole (never split mid-group) across
// them, "held: showing all keys" pins to the first line's right edge
// alongside the still-live range indicator, and the ordinary right-pinned
// action run (quit) closes the second line.
func TestCtrlHeldRendersTwoLineGroupedKeybar(t *testing.T) {
	rows := make([]protocol.PickRow, 20)
	for i := range rows {
		v := fmt.Sprintf("row%02d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v, Tone: "text"}}}
	}
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Rows: rows, Cap: 5,
		Actions: []protocol.PickAction{
			{ID: "open", Label: "open", Key: "enter", Scope: "item", Group: "nav", Primary: true},
			{ID: "cd-here", Label: "cd here", Key: "ctrl-h", Scope: "global", Group: "nav"},
			{ID: "editor", Label: "open in editor", Key: "ctrl-o", Scope: "item", Group: "act"},
		},
	}
	m := New(req)
	// Wide enough for the "nav" group plus the range+held run on line one,
	// but not wide enough for "act" to join it there -- pinning the
	// group-boundary wrap the assertions below check for.
	m.width = 90

	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyLeftCtrl})
	m = next.(*Model)
	if !m.held.ctrl {
		t.Fatal("setup: ctrl press should set held.ctrl")
	}

	lines := strings.Split(render(m), "\n")
	// breadcrumb, filter, rule, 5 rows, rule, keybar line 1, keybar line 2:
	// one more line than the single-line footer's own 10, for the second
	// keybar line totalChromeRows now budgets for.
	if want := 11; len(lines) != want {
		t.Fatalf("expected %d lines with the two-line keybar, got %d:\n%s", want, len(lines), render(m))
	}
	header := lines[0]
	if !strings.Contains(ansi.Strip(header), "⌃ keys") {
		t.Fatalf("header should carry the ctrl-held badge while ctrl is held: %q", ansi.Strip(header))
	}
	if !strings.Contains(header, cyanSGR) {
		t.Fatalf("ctrl-held badge should be cyan-colored: %q", header)
	}

	line1 := ansi.Strip(lines[len(lines)-2])
	line2 := ansi.Strip(lines[len(lines)-1])

	if !strings.Contains(line1, "nav") || !strings.Contains(line1, "enter") || !strings.Contains(line1, "cd here") {
		t.Fatalf("first keybar line should carry the nav group whole: %q", line1)
	}
	if !strings.Contains(line1, "held: showing all keys") {
		t.Fatalf("first keybar line should carry the held indicator: %q", line1)
	}
	if !strings.Contains(line1, "1-5 of 20") {
		t.Fatalf("the range indicator must survive alongside the held indicator: %q", line1)
	}
	if strings.Contains(line1, "act") {
		t.Fatalf("the act group belongs on the second line, not the first: %q", line1)
	}

	if !strings.Contains(line2, "act") || !strings.Contains(line2, "open in editor") {
		t.Fatalf("second keybar line should carry the act group: %q", line2)
	}
	if !strings.Contains(line2, "esc") || !strings.Contains(line2, "quit") {
		t.Fatalf("second keybar line should still pin quit to the right: %q", line2)
	}
}

// isQuitCmd reports whether running cmd yields the program's own quit signal,
// mirroring mustNotQuit's check in the positive direction for the exit-path
// tests. quit() now returns tea.Sequence(tea.ClearScreen, tea.Quit) so the
// card erases in-loop before shutdown, so a plain tea.QuitMsg assertion no
// longer holds; this unwraps the sequence (its message type is unexported, so
// it is reached by reflection over the slice of Cmds it carries) and every
// batch/sequence within it to find the QuitMsg.
func isQuitCmd(cmd tea.Cmd) bool {
	if cmd == nil {
		return false
	}
	return msgYieldsQuit(cmd())
}

func msgYieldsQuit(msg tea.Msg) bool {
	if _, ok := msg.(tea.QuitMsg); ok {
		return true
	}
	v := reflect.ValueOf(msg)
	if v.Kind() != reflect.Slice {
		return false
	}
	for i := 0; i < v.Len(); i++ {
		inner, ok := v.Index(i).Interface().(tea.Cmd)
		if ok && inner != nil && msgYieldsQuit(inner()) {
			return true
		}
	}
	return false
}

// stableHeightReq is an n-row request under a breadcrumb whose rows all
// contain "r" but none contain "z", so one query edit can collapse the match
// set to zero while another leaves it full -- the natural frame height really
// moves, which is what makes the constant-padded-height assertions non-vacuous.
func stableHeightReq(n int) protocol.PickRequest {
	return protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb: []string{"rt", "list"},
		Rows:       stableHeightRows(n),
	}
}

func stableHeightRows(n int) []protocol.PickRow {
	rows := make([]protocol.PickRow, n)
	for i := range rows {
		v := fmt.Sprintf("row%02d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v}}}
	}
	return rows
}

// TestFrameHeightStaysConstantWhenAQueryShrinksTheList is the core of the
// stable-height fix: once the pane is known, a typed query that collapses the
// list to no matches must not change the padded frame's height. The natural
// (unpadded) frame really shrinks; the reserved floor holds renderView steady,
// so the frame never re-enters bubbletea's inline shrink diff -- the residue
// path that reads as a lost or lagging rune when the picker sits below other
// terminal content. Pre-fix, with no floor, renderView tracked the natural
// height and this changed.
func TestFrameHeightStaysConstantWhenAQueryShrinksTheList(t *testing.T) {
	next, _ := New(stableHeightReq(30)).Update(tea.WindowSizeMsg{Width: 80, Height: 40})
	m := next.(*Model)

	before := lipgloss.Height(renderView(m))
	naturalBefore := lipgloss.Height(render(m))

	next, _ = m.Update(tea.KeyPressMsg{Code: 'z', Text: "z"}) // no row contains z
	m = next.(*Model)

	naturalAfter := lipgloss.Height(render(m))
	if naturalAfter == naturalBefore {
		t.Fatalf("setup: the query did not move the natural frame height (%d); nothing to hold constant", naturalBefore)
	}
	if after := lipgloss.Height(renderView(m)); after != before {
		t.Fatalf("padded frame changed height across a query shrink: before %d, after %d", before, after)
	}
}

// TestFrameHeightStaysConstantWhenADescendSwapsTheRows drives the row-set swap
// a nav descend performs (a PickUpdate replacing Rows). The new directory is
// much shorter, so the natural frame shrinks, but the reserved floor keeps
// renderView constant.
func TestFrameHeightStaysConstantWhenADescendSwapsTheRows(t *testing.T) {
	next, _ := New(stableHeightReq(30)).Update(tea.WindowSizeMsg{Width: 80, Height: 40})
	m := next.(*Model)

	before := lipgloss.Height(renderView(m))
	naturalBefore := lipgloss.Height(render(m))

	next, _ = m.Update(UpdateMsg{Update: protocol.PickUpdate{Rows: stableHeightRows(4)}})
	m = next.(*Model)

	naturalAfter := lipgloss.Height(render(m))
	if naturalAfter == naturalBefore {
		t.Fatalf("setup: the descend did not move the natural frame height (%d)", naturalBefore)
	}
	if after := lipgloss.Height(renderView(m)); after != before {
		t.Fatalf("padded frame changed height across a descend: before %d, after %d", before, after)
	}
}

// TestFrameHeightStaysConstantWhenAHiddenFilesToggleGrowsTheRowSet drives the
// other direction ctrl-t takes: a PickUpdate that grows the row set (revealing
// hidden entries). The natural frame grows within the floor; renderView holds.
func TestFrameHeightStaysConstantWhenAHiddenFilesToggleGrowsTheRowSet(t *testing.T) {
	next, _ := New(stableHeightReq(5)).Update(tea.WindowSizeMsg{Width: 80, Height: 40})
	m := next.(*Model)

	before := lipgloss.Height(renderView(m))
	naturalBefore := lipgloss.Height(render(m))

	next, _ = m.Update(UpdateMsg{Update: protocol.PickUpdate{Rows: stableHeightRows(12)}})
	m = next.(*Model)

	naturalAfter := lipgloss.Height(render(m))
	if naturalAfter == naturalBefore {
		t.Fatalf("setup: the toggle did not move the natural frame height (%d)", naturalBefore)
	}
	if after := lipgloss.Height(renderView(m)); after != before {
		t.Fatalf("padded frame changed height across a hidden-files toggle: before %d, after %d", before, after)
	}
}

// TestReservedFrameShowsCap14ContentAndRespectsThePaneCap pins the two board
// constraints the reserve must not break: on a tall pane the frame stays at
// the cap-14 content height with its scroll-range label, never stretched to
// the pane; on a short pane the reserve is clamped to the pane and never
// paints past the terminal.
func TestReservedFrameShowsCap14ContentAndRespectsThePaneCap(t *testing.T) {
	next, _ := New(stableHeightReq(100)).Update(tea.WindowSizeMsg{Width: 80, Height: 40})
	tall := next.(*Model)

	h := lipgloss.Height(renderView(tall))
	if h >= 40 {
		t.Fatalf("reserved frame is pane-tall (%d of 40) rather than content-anchored", h)
	}
	plain := ansi.Strip(render(tall))
	if !strings.Contains(plain, "of 100") {
		t.Fatalf("cap-14 windowed frame should carry the scroll-range label:\n%s", plain)
	}
	if rowLines := strings.Count(plain, "row"); rowLines != defaultCap {
		t.Fatalf("cap-14 window should paint exactly %d row lines, painted %d:\n%s", defaultCap, rowLines, plain)
	}

	next, _ = New(stableHeightReq(100)).Update(tea.WindowSizeMsg{Width: 80, Height: 12})
	short := next.(*Model)
	if sh := lipgloss.Height(renderView(short)); sh > 12 {
		t.Fatalf("reserved frame exceeded the pane: height %d, pane 12", sh)
	}
}

// TestQuitCollapsesTheFrameToZeroRows pins self-erase-on-close: a select that
// ends the session leaves an empty final frame so the picker collapses to
// clean scrollback rather than a dead card the next chained stage stacks
// under. Pre-fix, renderView still painted the reserved frame after the quit.
func TestQuitCollapsesTheFrameToZeroRows(t *testing.T) {
	next, _ := New(stableHeightReq(30)).Update(tea.WindowSizeMsg{Width: 80, Height: 40})
	m := next.(*Model)
	if lipgloss.Height(renderView(m)) <= 1 {
		t.Fatal("setup: the live frame should occupy the reserved height, not be empty")
	}

	next, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter}) // select -> quit
	m = next.(*Model)
	if !isQuitCmd(cmd) {
		t.Fatalf("enter on a match should end the session")
	}
	if got := renderView(m); got != "" {
		t.Fatalf("final frame after quit must collapse to zero rows, got %d:\n%q", lipgloss.Height(got), got)
	}
}

// TestEmptyBreadcrumbHeaderRowIsNotBlank locks the defensive edge: a request
// with no breadcrumb still renders its header row (the chrome budget and the
// mouse hit-zones both key on that row always being present), and that row
// carries the live count rather than a blank line.
func TestEmptyBreadcrumbHeaderRowIsNotBlank(t *testing.T) {
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Rows: stableHeightRows(5)}
	m := New(req)
	m.width = 40

	header := ansi.Strip(strings.Split(render(m), "\n")[0])
	if strings.TrimSpace(header) == "" {
		t.Fatalf("empty breadcrumb must not leave a blank header row, got %q", header)
	}
	if !strings.Contains(header, "5/5") {
		t.Fatalf("the header row should carry the live count, got %q", header)
	}
}

// interleavingGroupRows is a two-group list whose labels carry "ab" at a
// widening gap, so fuzzy ranking scores folder and file rows into an
// alternating order under a query -- a filtered window then shows a header
// boundary before nearly every row, far more than the two groups.
func interleavingGroupRows() []protocol.PickRow {
	var rows []protocol.PickRow
	gap := func(prefix, suffix string, n int) protocol.PickRow {
		label := prefix + strings.Repeat("x", n) + suffix
		return protocol.PickRow{Value: label, Group: prefix + suffix, Left: []protocol.PickSegment{{Text: label}}}
	}
	for i := 0; i < 10; i++ {
		rows = append(rows, gap("a", "bfolder", i))
	}
	for i := 0; i < 10; i++ {
		rows = append(rows, gap("a", "bfile", i))
	}
	return rows
}

// TestFrameHeightStaysConstantWhenAFuzzyQueryInterleavesGroups is the grouped
// case the flat-list tests missed: Rank sorts filtered matches by fuzzy score,
// interleaving the two groups so a window carries a header before nearly every
// row. Reserving only distinctGroupCount header lines under-counted that, the
// natural frame crossed the floor, and the padded frame changed height per
// keystroke -- the residue this fix exists to close. Pre-fix the padded height
// moved (22 -> 33 -> 33); the floor now reserves the window maximum so it holds.
func TestFrameHeightStaysConstantWhenAFuzzyQueryInterleavesGroups(t *testing.T) {
	build := func(query string) *Model {
		req := protocol.PickRequest{
			T: "pick", Protocol: protocol.Version,
			Breadcrumb: []string{"rt", "nav"},
			Rows:       interleavingGroupRows(),
		}
		next, _ := New(req).Update(tea.WindowSizeMsg{Width: 80, Height: 60})
		m := next.(*Model)
		for _, r := range query {
			n, _ := m.Update(tea.KeyPressMsg{Code: r, Text: string(r)})
			m = n.(*Model)
		}
		return m
	}

	queries := []string{"a", "ab", "axb"}
	padded := make([]int, len(queries))
	natural := make([]int, len(queries))
	for i, q := range queries {
		m := build(q)
		padded[i] = lipgloss.Height(renderView(m))
		natural[i] = lipgloss.Height(render(m))
	}

	if natural[0] == natural[1] && natural[1] == natural[2] {
		t.Fatalf("setup: the natural frame height did not move across the queries (%v); the interleave never reproduced", natural)
	}
	for i, q := range queries {
		if padded[i] != padded[0] {
			t.Fatalf("padded frame height moved across a group-interleaving query %q: padded %v, natural %v", q, padded, natural)
		}
	}
}

// TestCursorRowLabelBoldOnExtrasRowsPath is the Commit.dc.html golden for
// F-c2: commit builds its rows via extras.rows, where the label segment
// carries neither a tone nor bold (unlike the options path, which bakes
// bold:true into the row data). The cursor row must still render that label
// bold Text, exactly as the options path does.
func TestCursorRowLabelBoldOnExtrasRowsPath(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{Value: "a", Left: []protocol.PickSegment{{Text: "lib/runner/workspace-registry.ts"}}},
			{Value: "b", Left: []protocol.PickSegment{{Text: "commands/runner.ts"}}},
		},
	}
	m := New(req)
	m.width = 90

	cursorRow := rowLine(m, 0)
	if !strings.Contains(cursorRow, "1;"+textSGR) {
		t.Fatalf("cursor row label from extras.rows should render bold Text: %q", cursorRow)
	}
	nonCursorRow := rowLine(m, 1)
	if strings.Contains(nonCursorRow, "1;"+textSGR) {
		t.Fatalf("non-cursor row label must not be bold Text: %q", nonCursorRow)
	}
}

// TestCtrlSlashTogglesExpandedKeybar is the F-n1 golden: ctrl-/ toggles the
// Modifiers-board two-line grouped keybar on and off, independent of the
// physical-hold path. On a legacy terminal ctrl-/ arrives as ctrl+_ (byte
// 0x1F + 0x40 = '_'); on Kitty as ctrl+/. Both must drive the toggle.
func TestCtrlSlashTogglesExpandedKeybar(t *testing.T) {
	rows := make([]protocol.PickRow, 20)
	for i := range rows {
		v := fmt.Sprintf("row%02d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v, Tone: "text"}}}
	}
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Rows: rows, Cap: 5,
		Actions: []protocol.PickAction{
			{ID: "open", Label: "open", Key: "enter", Scope: "item", Group: "nav", Primary: true},
			{ID: "editor", Label: "open in editor", Key: "ctrl-o", Scope: "item", Group: "act"},
		},
	}
	lastLine := func(frame string) string {
		lines := strings.Split(frame, "\n")
		return ansi.Strip(lines[len(lines)-1])
	}

	m := New(req)
	m.width = 90
	if strings.Contains(lastLine(render(m)), "showing all keys") {
		t.Fatal("setup: the expanded keybar must not show before ctrl-/")
	}

	// Legacy decode: ctrl-/ surfaces as ctrl+_.
	next, _ := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: '_'})
	m = next.(*Model)
	if !m.expanded {
		t.Fatal("ctrl-/ (ctrl+_) should toggle the expanded keybar on")
	}
	lines := strings.Split(render(m), "\n")
	if !strings.Contains(ansi.Strip(lines[len(lines)-2]), "held: showing all keys") {
		t.Fatalf("the two-line grouped keybar should show after ctrl-/: %q", ansi.Strip(lines[len(lines)-2]))
	}

	// A second ctrl-/ toggles it back off.
	next, _ = m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: '_'})
	m = next.(*Model)
	if m.expanded {
		t.Fatal("a second ctrl-/ should toggle the expanded keybar off")
	}
	if strings.Contains(lastLine(render(m)), "showing all keys") {
		t.Fatal("the expanded keybar should hide after the second ctrl-/")
	}

	// Kitty decode: ctrl-/ surfaces as ctrl+/ and must toggle the same state.
	next, _ = m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: '/'})
	m = next.(*Model)
	if !m.expanded {
		t.Fatal("ctrl-/ (ctrl+/) should toggle the expanded keybar on")
	}
}

// TestHoverRowRendersHoverBg pins the hover-SGR fix's list-row half: a
// hovered non-cursor row carries HoverBg #251E3D, the exact 48;2;37;30;61
// background the Mouse board specifies.
func TestHoverRowRendersHoverBg(t *testing.T) {
	const hoverBgSGR = "48;2;37;30;61"
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{
			{Value: "a", Left: []protocol.PickSegment{{Text: "provision", Tone: "text"}}},
			{Value: "b", Left: []protocol.PickSegment{{Text: "dispose", Tone: "text"}}},
		},
	}
	m := New(req)
	m.width = 60
	render(m)

	next, _ := m.Update(tea.MouseMotionMsg{X: 2, Y: 4})
	m = next.(*Model)
	if m.hover != 1 {
		t.Fatalf("setup: motion over row 1 should set hover=1, got %d", m.hover)
	}
	lines := strings.Split(render(m), "\n")
	if !strings.Contains(lines[4], hoverBgSGR) {
		t.Fatalf("the hovered row should carry HoverBg %s: %q", hoverBgSGR, lines[4])
	}
}
