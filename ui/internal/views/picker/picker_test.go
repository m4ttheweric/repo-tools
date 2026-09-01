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

// TestEventActionKeyWritesEventAndStaysOpen is the golden for the
// event:true dispatch path: the key is matched against the registry (not
// the hardcoded enter/select path), the write happens on the returned
// tea.Cmd rather than inline, and the model produces no terminal result.
func TestEventActionKeyWritesEventAndStaysOpen(t *testing.T) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a"}, {Value: "b"}},
		Actions: []protocol.PickAction{
			{ID: "refresh", Label: "refresh", Key: "ctrl-r", Scope: "global", Event: true},
		},
	}
	m := New(req)
	var buf bytes.Buffer
	m.output = &buf
	m.cursor = 1 // sits on "b"

	next, cmd := m.Update(tea.KeyPressMsg{Mod: tea.ModCtrl, Code: 'r'})
	m = next.(*Model)

	if m.result != nil {
		t.Fatalf("event action must not terminate the session: %+v", m.result)
	}
	if cmd == nil {
		t.Fatal("expected a cmd to write the event")
	}
	if msg := cmd(); msg != nil {
		t.Fatalf("event cmd should return no further message, got %#v", msg)
	}

	var ev protocol.PickEvent
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &ev); err != nil {
		t.Fatalf("event line not valid JSON: %v (%s)", err, buf.String())
	}
	if ev.T != "event" || ev.Action != "refresh" || ev.Value == nil || *ev.Value != "b" || ev.Query != "" {
		t.Fatalf("got %+v", ev)
	}
}

// TestNonEventActionKeyProducesTerminalResult covers the opposite branch: a
// registry action without event:true ends the session, exactly as Task 4's
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

// TestHighlightSkippedWhenMatchFieldDivergesFromLeftText is the regression
// guard for a row whose match field is an alias that differs from what's
// on screen (row.Left has no "e" at all here, so it can only be found via
// the alias): match.Positions then index the alias, not the visible left
// text, so applying them there would highlight the wrong runes.
func TestHighlightSkippedWhenMatchFieldDivergesFromLeftText(t *testing.T) {
	req := protocol.PickRequest{
		T:            "pick",
		Protocol:     protocol.Version,
		InitialQuery: "re",
		Rows: []protocol.PickRow{
			{
				Value: "provision",
				Left:  []protocol.PickSegment{{Text: "provision", Tone: "text"}},
				Match: "reprovision",
			},
		},
	}
	m := New(req)
	m.width = 40

	if len(m.matches) != 1 || len(m.matches[0].Positions) == 0 {
		t.Fatalf("the query should still match via the match field override: %+v", m.matches)
	}

	raw := rowLine(m, 0)
	if strings.Contains(raw, cyanSGR) {
		t.Fatalf("positions computed against an overriding match field must not paint the visible left text: %q", raw)
	}
	if !strings.Contains(ansi.Strip(raw), "provision") {
		t.Fatalf("the left text should still render, just unhighlighted: %q", raw)
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
