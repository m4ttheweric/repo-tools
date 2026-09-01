package picker

import (
	"fmt"
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
