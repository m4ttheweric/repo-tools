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

func render(m *Model) string {
	if m.width == 0 {
		return ""
	}
	lines := make([]string, 0, len(m.matches)+5)
	lines = append(lines, breadcrumbLine(m), filterLine(m), rule(m.width))
	for i := range m.matches {
		lines = append(lines, rowLine(m, i))
	}
	lines = append(lines, rule(m.width), keybarStub(m))
	return strings.Join(lines, "\n")
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

// keybarStub is a blank placeholder line; keybar content is filled in later.
func keybarStub(m *Model) string {
	return justify(m.width, "", "")
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

// rowLine paints one matched row: a 1-column gutter outside the highlight
// (pink bar on the cursor row, blank otherwise), then a SelBg/HoverBg-filled
// span carrying the left segments, matched-character highlight, spacer, and
// right segments pinned to the far edge.
func rowLine(m *Model, i int) string {
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
	leftBudget := m.width - 2 - rightWidth
	if rightWidth > 0 {
		leftBudget--
	}
	if leftBudget < 0 {
		leftBudget = 0
	}

	leftPlain := leftPlainText(row)
	kept, truncated := clipRunes(leftPlain, leftBudget)
	leftRendered := renderHighlightedLeft(row, len([]rune(kept)), match.Positions, rowBg)
	usedLeftWidth := lipgloss.Width(kept)
	if truncated {
		leftRendered += rowBg.Foreground(theme.Faint).Render("…")
		usedLeftWidth++
	}

	spacer := m.width - 2 - usedLeftWidth - rightWidth
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
func renderHighlightedLeft(row protocol.PickRow, keptRunes int, positions []int, rowBg lipgloss.Style) string {
	matched := make(map[int]bool, len(positions))
	for _, p := range positions {
		matched[p] = true
	}
	var out strings.Builder
	runeIdx := 0
	for _, seg := range row.Left {
		base := rowBg.Foreground(segColor(seg)).Bold(seg.Bold)
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
