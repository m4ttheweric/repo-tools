package picker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"rt-ui/internal/protocol"
)

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
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatalf("expected the cmd to quit the program")
	}
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
// the injected back/cancel defaults -- ungrouped, since this request never
// claims a group for them -- pin to the right with no group label.
func TestKeybarRendersGroupedLegendWithBackAndQuitPinnedRight(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb: []string{"rt", "worktree"},
		Rows:       []protocol.PickRow{{Value: "provision"}},
		Actions: []protocol.PickAction{
			{ID: "select", Label: "select", Key: "enter", Scope: "item", Group: "pick", Primary: true},
			{ID: "with-args", Label: "with args", Key: "alt-enter", Scope: "item", Group: "pick"},
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

// TestDefaultActionsCoverTheBareRequest pins the case a request declares no
// registry at all: select and cancel always exist, but back only once the
// breadcrumb has somewhere to return to.
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
		t.Fatalf("a flat breadcrumb (depth <= 1) must not get a back default: %+v", actions)
	}

	nested := flat
	nested.Breadcrumb = []string{"rt", "worktree"}
	nestedActions := effectiveActions(nested)
	var sawBack bool
	for _, a := range nestedActions {
		if a.ID == "back" {
			sawBack = true
			if a.Key != "ctrl-up" {
				t.Fatalf("back should bind ctrl-up, got %q", a.Key)
			}
		}
	}
	if !sawBack {
		t.Fatalf("breadcrumb depth > 1 should inject a back default: %+v", nestedActions)
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

	if cmd != nil {
		t.Fatal("selecting a modal row must not end the picker session")
	}
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

	if cmd != nil {
		t.Fatal("esc must not end the picker session")
	}
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

	if cmd != nil {
		t.Fatal("an event:true menu action must not end the picker session")
	}
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
	if _, ok := cmd().(tea.QuitMsg); !ok {
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
// half of the requirement: the panel occupies a real line between the
// filter and the top rule, so a height-bounded pane has to give the row
// window back one more line of budget than a non-multi request would, or
// the frame overflows the pane by exactly the panel's own line.
func TestSelectedPanelCountsAsChromeInHeaderBudget(t *testing.T) {
	rows := make([]protocol.PickRow, 20)
	for i := range rows {
		v := fmt.Sprintf("row%02d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v, Tone: "text"}}}
	}
	req := protocol.PickRequest{T: "pick", Protocol: protocol.Version, Multi: true, Rows: rows}
	m := New(req)
	m.width = 60
	m.height = 19

	plain := ansi.Strip(render(m))
	lines := strings.Split(plain, "\n")
	if len(lines) > 19 {
		t.Fatalf("rendered frame must fit the pane height (19) once the selected panel is counted as chrome: got %d lines:\n%s", len(lines), plain)
	}
}
