package picker

import (
	"fmt"
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"

	"rt-ui/internal/protocol"
	"rt-ui/internal/theme"
)

// The picker paints inline at the terminal's native background, same as the
// board's row content; only the selection and hover rows carry an explicit
// background.
var onBg = lipgloss.NewStyle()

func fg(c color.Color) lipgloss.Style {
	return onBg.Foreground(c)
}

// chromeRows is the fixed line count wrapping the scrollable row list:
// breadcrumb, filter, top rule, bottom rule, keybar. Viewport subtracts it
// from the pane height to find how many rows actually fit.
const chromeRows = 5

func render(m *Model) string {
	// pick.ts never opens the picker for a zero-row request, so this is not
	// a UI state to design for -- just insurance against the empty slice
	// below producing an out-of-range panic if that invariant ever slips.
	if m.width == 0 || len(m.req.Rows) == 0 {
		return ""
	}

	n := len(m.matches)
	lines := make([]string, 0, n+chromeRows)
	lines = append(lines, breadcrumbLine(m), filterLine(m), rule(m.width))

	if n == 0 {
		lines = append(lines, noMatchLine())
		lines = append(lines, rule(m.width), noMatchKeybarLine(m))
		return strings.Join(lines, "\n")
	}

	top, h := m.viewport()
	scrolling := n > h

	rowWidth := m.width
	if scrolling {
		rowWidth-- // last column is the thumb rail's dedicated gutter
	}
	thumbTop, thumbH := thumbSpan(top, h, n)
	for i := top; i < top+h; i++ {
		if group, ok := headerBoundary(m, i); ok {
			lines = append(lines, groupHeaderLine(group))
		}
		line := rowLineWidth(m, i, rowWidth)
		if scrolling {
			line += thumbCell(i-top, thumbTop, thumbH)
		}
		lines = append(lines, line)
	}

	lines = append(lines, rule(m.width), keybarLine(m, top, h, n))
	return strings.Join(lines, "\n")
}

// noMatchLine is the Filtering board's zero-match row: a single inline
// faint line replacing the list rather than an empty row area, so the user
// sees the query took effect instead of wondering if the picker is stuck.
func noMatchLine() string {
	return onBg.Render("  ") + fg(theme.Faint).Render("no matches")
}

// noMatchKeybarLine replaces the whole footer legend rather than composing
// it alongside the normal one: enter/tab/ctrl-up all act on a row, and there
// are none, so the only live keys are backing out of the filter or quitting.
func noMatchKeybarLine(m *Model) string {
	left := fg(theme.Faint).Render("backspace") + fg(theme.Dim).Render(" edit filter") +
		fg(theme.Faint).Render(" · ") + fg(theme.Faint).Render("esc") + fg(theme.Dim).Render(" quit")
	return justify(m.width, left, "")
}

// groupOf reads the group label backing matches[i]. Group headers are
// render-only: the cursor indexes m.matches directly and this function is
// never consulted by cursor movement, so a header can never become the
// selected row.
func groupOf(m *Model, i int) string {
	return m.req.Rows[m.matches[i].Index].Group
}

// headerBoundary reports whether matches[i] starts a new group -- computed
// against the full match order, not just the visible window, so scrolling
// into the middle of a group never repeats its header and scrolling to a
// group's first row (even as the window's own top line) still shows one.
// The viewport sizes its window against this same check before any line is
// painted, so it and the row loop must never diverge -- hence one function
// instead of two copies of the boundary condition.
func headerBoundary(m *Model, i int) (group string, ok bool) {
	group = groupOf(m, i)
	if group == "" {
		return "", false
	}
	if i == 0 || groupOf(m, i-1) != group {
		return group, true
	}
	return "", false
}

// headerCount reports how many group headers fall within [top, top+h) --
// the extra display lines Viewport's own row ceiling never accounted for,
// so the viewport window has to budget for them separately.
func headerCount(m *Model, top, h int) int {
	count := 0
	for i := top; i < top+h; i++ {
		if _, ok := headerBoundary(m, i); ok {
			count++
		}
	}
	return count
}

// groupHeaderLine paints a group boundary as a faint uppercase label at the
// row gutter's own two-column indent -- the board renders lowercase source
// text uppercased purely by CSS, which a terminal has no equivalent for, so
// the case conversion has to happen here instead.
func groupHeaderLine(group string) string {
	return onBg.Render("  ") + fg(theme.Faint).Render(strings.ToUpper(group))
}

// thumbSpan sizes the rail to the visible fraction of the list (h*h/n,
// floored, minimum one row so a long list always shows something to grab)
// and positions it in lockstep with the scroll offset.
func thumbSpan(top, h, n int) (thumbTop, thumbH int) {
	if n <= 0 || h <= 0 {
		return 0, 0
	}
	thumbH = h * h / n
	if thumbH < 1 {
		thumbH = 1
	}
	if thumbH > h {
		thumbH = h
	}
	maxTop := n - h
	if maxTop <= 0 {
		return 0, thumbH
	}
	avail := h - thumbH
	if avail < 0 {
		avail = 0
	}
	thumbTop = top * avail / maxTop
	return thumbTop, thumbH
}

// thumbCell paints one row of the rail: Panel-colored across the thumb's
// span, a plain blank cell everywhere else in the gutter.
func thumbCell(rowInWindow, thumbTop, thumbH int) string {
	if rowInWindow >= thumbTop && rowInWindow < thumbTop+thumbH {
		return lipgloss.NewStyle().Background(theme.Panel).Render(" ")
	}
	return onBg.Render(" ")
}

// keybarLine currently renders only the right-pinned visible-range
// indicator, shown whenever the list overflows the window; the left-side
// key legend is filled in by later work. The separator between the two
// numbers is a plain ASCII hyphen, not an en/em dash -- a rendered-output
// constraint that applies everywhere, including here.
func keybarLine(m *Model, top, h, n int) string {
	right := ""
	if n > h {
		right = fg(theme.Cyan).Render(fmt.Sprintf("%d-%d", top+1, top+h)) +
			fg(theme.Faint).Render(fmt.Sprintf(" of %d", n))
	}
	return justify(m.width, "", right)
}

func rule(width int) string {
	return fg(theme.Rule).Render(strings.Repeat("─", width))
}

// breadcrumbLine joins Breadcrumb in the board header's grammar: bold
// segments separated by a faint chevron, with the live count pinned right.
func breadcrumbLine(m *Model) string {
	var left strings.Builder
	for i, part := range m.req.Breadcrumb {
		if i > 0 {
			left.WriteString(fg(theme.Faint).Render(" › "))
		}
		left.WriteString(fg(theme.Text).Bold(true).Render(part))
	}
	return justify(m.width, left.String(), countText(m))
}

// countText turns cyan only while a query is narrowing the list to at least
// one match; an empty query or a query with no matches reads as one flat
// faint fraction, matching the Branch and zero-match Filtering boards.
func countText(m *Model) string {
	total := len(m.req.Rows)
	n := len(m.matches)
	if m.query != "" && n > 0 {
		return fg(theme.Cyan).Render(fmt.Sprintf("%d", n)) + fg(theme.Faint).Render(fmt.Sprintf("/%d", total))
	}
	return fg(theme.Faint).Render(fmt.Sprintf("%d/%d", n, total))
}

func filterLine(m *Model) string {
	left := fg(theme.Pink).Render(theme.GlyphChevron + " ")
	if m.query == "" {
		left += fg(theme.Faint).Render("filter…")
	} else {
		left += fg(theme.Text).Render(m.query)
	}
	return justify(m.width, left, "")
}

// justify mirrors the board header/keybar convention: a 2-column left
// margin, the right block pinned to the edge, a 1-column trailing margin.
func justify(width int, left, right string) string {
	avail := width - 3 - lipgloss.Width(left)
	if avail < 0 {
		avail = 0
	}
	return onBg.Render("  ") + left + lipgloss.PlaceHorizontal(avail, lipgloss.Right, right, lipgloss.WithWhitespaceStyle(onBg)) + onBg.Render(" ")
}

// rowLine paints row i at the model's full width.
func rowLine(m *Model, i int) string {
	return rowLineWidth(m, i, m.width)
}

// rowLineWidth paints one matched row within an explicit width: a 1-column
// gutter outside the highlight (pink bar on the cursor row, blank
// otherwise), then a SelBg/HoverBg-filled span carrying the left segments,
// matched-character highlight, spacer, and right segments pinned to the far
// edge. The width is explicit (rather than always m.width) because a
// scrolling list shrinks it by one column to make room for the thumb rail.
func rowLineWidth(m *Model, i int, width int) string {
	match := m.matches[i]
	row := m.req.Rows[match.Index]
	cursorRow := i == m.cursor
	hoverRow := !cursorRow && i == m.hover

	rowBg := onBg
	gutterGlyph := " "
	gutterStyle := onBg
	switch {
	case cursorRow:
		rowBg = lipgloss.NewStyle().Background(theme.SelBg)
		gutterGlyph = theme.GlyphBar
		gutterStyle = fg(theme.Pink)
	case hoverRow:
		rowBg = lipgloss.NewStyle().Background(theme.HoverBg)
	}
	gutter := gutterStyle.Render(gutterGlyph)

	rightPlain := plainConcat(row.Right)
	rightWidth := lipgloss.Width(rightPlain)

	// Budget: 1 gutter column + 1 separator column, plus a gap column ahead
	// of any right segments so they never touch the left text directly.
	leftBudget := width - 2 - rightWidth
	if rightWidth > 0 {
		leftBudget--
	}
	if leftBudget < 0 {
		leftBudget = 0
	}

	leftPlain := leftPlainText(row)
	kept, truncated := clipRunes(leftPlain, leftBudget)
	// match.Positions index the text Rank scored (row.Match when the caller
	// set one, e.g. an alias or a string folding in right-segment text) --
	// only when that text is identical to what's actually on screen do
	// those rune indices land on the runes they were computed against.
	positions := match.Positions
	if matchText(row) != leftPlain {
		positions = nil
	}
	leftRendered := renderHighlightedLeft(row, len([]rune(kept)), positions, rowBg, cursorRow)
	usedLeftWidth := lipgloss.Width(kept)
	if truncated {
		leftRendered += rowBg.Foreground(theme.Faint).Render("…")
		usedLeftWidth++
	}

	spacer := width - 2 - usedLeftWidth - rightWidth
	if spacer < 0 {
		spacer = 0
	}

	rightRendered := renderSegments(row.Right, rowBg)

	return gutter + rowBg.Render(" ") + leftRendered + rowBg.Render(strings.Repeat(" ", spacer)) + rightRendered
}

// renderHighlightedLeft re-styles matched runes cyan bold while walking the
// left segments' own tone/hex/bold, stopping at keptRunes (the clip
// boundary) so a truncated row never highlights past what it actually
// shows. positions index by rune, not byte -- fzf's Chars falls back to a
// byte offset only when the target is pure ASCII, where the two coincide,
// so non-ASCII targets would misalign under byte-slicing.
func renderHighlightedLeft(row protocol.PickRow, keptRunes int, positions []int, rowBg lipgloss.Style, cursorRow bool) string {
	matched := make(map[int]bool, len(positions))
	for _, p := range positions {
		matched[p] = true
	}
	var out strings.Builder
	runeIdx := 0
	for _, seg := range row.Left {
		color, bold := leftSegColor(seg, cursorRow)
		base := rowBg.Foreground(color).Bold(bold)
		for _, r := range seg.Text {
			if runeIdx >= keptRunes {
				return out.String()
			}
			style := base
			if matched[runeIdx] {
				style = rowBg.Foreground(theme.Cyan).Bold(true)
			}
			out.WriteString(style.Render(string(r)))
			runeIdx++
		}
	}
	return out.String()
}

func renderSegments(segs []protocol.PickSegment, rowBg lipgloss.Style) string {
	var out strings.Builder
	for _, seg := range segs {
		out.WriteString(rowBg.Foreground(segColor(seg)).Bold(seg.Bold).Render(seg.Text))
	}
	return out.String()
}

// segColor resolves a segment's foreground: an explicit hex wins, then a
// named tone, then the neutral default. Cursor/hover state never recolors a
// segment -- only the gutter and the row background carry focus.
func segColor(seg protocol.PickSegment) color.Color {
	if seg.Hex != "" {
		return lipgloss.Color(seg.Hex)
	}
	if c, ok := toneColor(seg.Tone); ok {
		return c
	}
	return theme.Text
}

// leftSegColor resolves a left segment's foreground and bold for row focus:
// on a non-cursor row, the default text tone (explicit "text" or unset)
// steps down to TextSoft with bold dropped, and "dim" steps down to
// Dimmer, so focus reads from color contrast rather than every row
// competing at the cursor row's own weight. Any other tone -- faint, an
// explicit semantic color, or a hex -- is a deliberate accent the row
// author chose and is left exactly as segColor would render it.
func leftSegColor(seg protocol.PickSegment, cursorRow bool) (color.Color, bool) {
	if seg.Hex != "" {
		return lipgloss.Color(seg.Hex), seg.Bold
	}
	if !cursorRow {
		switch seg.Tone {
		case "text", "":
			return theme.TextSoft, false
		case "dim":
			return theme.Dimmer, seg.Bold
		}
	}
	if c, ok := toneColor(seg.Tone); ok {
		return c, seg.Bold
	}
	return theme.Text, seg.Bold
}

func toneColor(tone string) (color.Color, bool) {
	switch tone {
	case "text":
		return theme.Text, true
	case "textsoft":
		return theme.TextSoft, true
	case "dim":
		return theme.Dim, true
	case "dimmer":
		return theme.Dimmer, true
	case "faint":
		return theme.Faint, true
	case "pink":
		return theme.Pink, true
	case "cyan":
		return theme.Cyan, true
	case "mint":
		return theme.Mint, true
	case "coral":
		return theme.Coral, true
	case "peach":
		return theme.Peach, true
	case "lav":
		return theme.Lav, true
	case "blue":
		return theme.Blue, true
	case "surface":
		return theme.Surface, true
	case "hoverbg":
		return theme.HoverBg, true
	case "selbg":
		return theme.SelBg, true
	case "rule":
		return theme.Rule, true
	}
	return theme.Text, false
}

// clipRunes reports how much of s fits in w cells (like the board's clip)
// but returns the kept plain text and a truncated flag instead of an
// already-styled string, so the caller can keep highlighting matched runes
// within the kept prefix before appending its own ellipsis.
func clipRunes(s string, w int) (kept string, truncated bool) {
	if w < 1 || lipgloss.Width(s) <= w {
		return s, false
	}
	if w == 1 {
		return "", true
	}
	return lipgloss.NewStyle().Inline(true).MaxWidth(w - 1).Render(s), true
}

func plainConcat(segs []protocol.PickSegment) string {
	var b strings.Builder
	for _, seg := range segs {
		b.WriteString(seg.Text)
	}
	return b.String()
}

func leftPlainText(row protocol.PickRow) string {
	return plainConcat(row.Left)
}

// matchText is what Rank scores against: the row's own match field when the
// caller supplies one (e.g. to rank against unstyled text), else the same
// concatenation the left segments render -- so a row without an explicit
// match field can trust rune-indexed positions against its own left text.
func matchText(row protocol.PickRow) string {
	if row.Match != "" {
		return row.Match
	}
	return leftPlainText(row)
}
