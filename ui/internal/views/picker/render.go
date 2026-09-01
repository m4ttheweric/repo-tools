package picker

import (
	"fmt"
	"image/color"
	"strconv"
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

// totalChromeRows is chromeRows plus the pinned selected panel's own line,
// when a multi session is showing one -- the panel sits between the filter
// line and the top rule, so it eats into the same pane budget every other
// chrome line already claims -- plus one more line while ctrl is held, when
// the keybar itself grows from one line to the Modifiers board's two-line
// grouped legend.
func (m *Model) totalChromeRows() int {
	rows := chromeRows
	if m.showSelectedPanel() {
		rows++
	}
	if m.held.ctrl {
		rows++
	}
	return rows
}

// render paints one frame and, as a side effect, rebuilds m.zones from the
// lines it actually draws -- the render pass is the only place that knows
// which Y lines are group headers (no zone) versus rows, and where the
// breadcrumb/keybar runs actually landed once justified, so hit-zones are
// recorded here rather than recomputed against a click's since-changed
// model state later.
func render(m *Model) string {
	// pick.ts never opens the picker for a zero-row request, so this is not
	// a UI state to design for -- just insurance against the empty slice
	// below producing an out-of-range panic if that invariant ever slips.
	if m.width == 0 || len(m.req.Rows) == 0 {
		m.zones = hitZones{}
		return ""
	}

	zones := hitZones{}
	y := 0

	n := len(m.matches)
	lines := make([]string, 0, n+m.totalChromeRows())
	lines = append(lines, breadcrumbLine(m))
	zones.addAll(y, breadcrumbZones(m))
	y++
	lines = append(lines, filterLine(m))
	y++
	if m.showSelectedPanel() {
		lines = append(lines, selectedPanelLine(m, m.width))
		y++
	}
	lines = append(lines, rule(m.width))
	y++

	if n == 0 {
		lines = append(lines, noMatchLine())
		lines = append(lines, rule(m.width), noMatchKeybarLine(m))
		m.zones = zones
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
			y++ // a header consumes a display line but is never a hit-zone
		}
		line := rowLineWidth(m, i, rowWidth)
		zones.addAll(y, rowZones(m, i, rowWidth))
		if scrolling {
			line += thumbCell(i-top, thumbTop, thumbH)
		}
		lines = append(lines, line)
		y++
	}

	lines = append(lines, rule(m.width))
	y++
	if m.held.ctrl {
		line1, zones1, line2, zones2 := expandedKeybarLines(m, top, h, n)
		zones.addAll(y, zones1)
		y++
		zones.addAll(y, zones2)
		lines = append(lines, line1, line2)
	} else {
		keybarStr, keyZones := keybarLineZones(m, top, h, n)
		zones.addAll(y, keyZones)
		lines = append(lines, keybarStr)
	}

	m.zones = zones
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

// keybarLine renders the footer's grouped action legend on the left and,
// on the right, the visible-range indicator (shown whenever the list
// overflows the window) alongside the ungrouped action run -- back/cancel
// by default. The separator between the two range numbers is a plain ASCII
// hyphen, not an en/em dash -- a rendered-output constraint that applies
// everywhere, including here.
func keybarLine(m *Model, top, h, n int) string {
	line, _ := keybarLineZones(m, top, h, n)
	return line
}

// expandedKeybarLines renders the ctrl-held keybar as the Modifiers board's
// "⌃ held" two-line grouped legend, in place of keybarLineZones's own
// single truncated line. Every declared group is placed whole (never split
// mid-group): as many as fit the first line, the rest carried to the
// second and truncated there the same way a single line would give up
// trailing groups -- so a registry too big even for two lines still never
// clips a key or label mid-word. The scroll range (when the list overflows)
// survives on the first line's right edge alongside the "held: showing all
// keys" indicator -- the ctrl swap this replaces once dropped the range
// silently, which is exactly what pinning it here prevents. The ordinary
// right-pinned action run (quit, by default) closes the second line, same
// as it would the single-line footer.
func expandedKeybarLines(m *Model, top, h, n int) (line1 string, zones1 []mouseZone, line2 string, zones2 []mouseZone) {
	left, ungrouped := keybarClusters(effectiveActions(m.req))

	rangeText := ""
	if n > h {
		rangeText = fg(theme.Cyan).Render(strconv.Itoa(top+1)+"-"+strconv.Itoa(top+h)) +
			fg(theme.Faint).Render(" of "+strconv.Itoa(n))
	}
	right1 := renderKeybarRight(rangeText, fg(theme.Cyan).Render("held: showing all keys"))
	right2 := renderKeybarCluster(keybarCluster{actions: ungrouped})

	firstGroups := truncateKeybarGroups(left, keybarLeftBudget(m.width, right1))
	secondGroups := truncateKeybarGroups(left[len(firstGroups):], keybarLeftBudget(m.width, right2))

	line1 = justify(m.width, renderKeybarLeft(firstGroups), right1)
	line2 = justify(m.width, renderKeybarLeft(secondGroups), right2)

	_, zones1 = layoutKeybarLeft(2, firstGroups)
	_, zones2 = layoutKeybarLeft(2, secondGroups)
	if len(ungrouped) > 0 {
		rightStart := m.width - 1 - lipgloss.Width(right2)
		_, ungroupedZones := layoutKeybarCluster(rightStart, keybarCluster{actions: ungrouped})
		zones2 = append(zones2, ungroupedZones...)
	}

	return line1, zones1, line2, zones2
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

// countText is the breadcrumb line's right-aligned count area. Alt held
// prepends the Modifiers board's "with args" badge ahead of either the
// multi-selection prefix or the plain fraction -- a session-level "args
// preview is live" indicator; the per-row claim (which rows actually have
// one) is rowLineWidth's own cursor badge and dim, keyed off
// PickRow.WithArgs. Ctrl held prepends the same board's "⌃ keys" badge the
// same way, mirroring the alt badge's color/separator grammar with cyan in
// place of lav. The two are mutually exclusive on the boards, so alt wins
// if somehow both are held at once.
func countText(m *Model) string {
	prefix := ""
	switch {
	case m.held.alt:
		prefix = fg(theme.Lav).Bold(true).Render("⌥ with args") + fg(theme.Faint).Render(keybarRightSep)
	case m.held.ctrl:
		prefix = fg(theme.Cyan).Bold(true).Render("⌃ keys") + fg(theme.Faint).Render(keybarRightSep)
	}
	if m.multiMode() && len(m.selected) > 0 {
		return prefix + fg(theme.Mint).Render(fmt.Sprintf("%s %d", theme.GlyphOn, len(m.selected))) +
			fg(theme.Faint).Render(" selected  ·  ") + countFraction(m)
	}
	return prefix + countFraction(m)
}

// countFraction turns cyan only while a query is narrowing the list to at
// least one match; an empty query or a query with no matches reads as one
// flat faint fraction, matching the Branch and zero-match Filtering boards.
func countFraction(m *Model) string {
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

// selectedPanelLine paints the pinned BgSubtle strip under the filter line:
// a faint "selected" label followed by every currently selected row's label
// in mint, joined by a faint middle dot and clipped to width -- the panel
// that lets a multi session see its picks without them scrolling out of
// the row list.
func selectedPanelLine(m *Model, width int) string {
	bg := lipgloss.NewStyle().Background(theme.BgSubtle)
	labels := selectedLabelsInOrder(m)

	const prefix = "  selected  "
	plain := prefix + strings.Join(labels, " · ")

	kept, truncated := clipRunes(plain, width)
	rendered := renderPanelRun(prefix, labels, len([]rune(kept)), bg)
	used := lipgloss.Width(kept)
	if truncated {
		rendered += bg.Foreground(theme.Faint).Render("…")
		used++
	}

	pad := width - used
	if pad < 0 {
		pad = 0
	}
	return rendered + bg.Render(strings.Repeat(" ", pad))
}

// selectedLabelsInOrder lists every selected row's own label, in request
// order -- the same order selectMulti's Values result carries, so the panel
// a user sees while filtering matches what enter will confirm.
func selectedLabelsInOrder(m *Model) []string {
	labels := make([]string, 0, len(m.selected))
	for _, row := range m.req.Rows {
		if m.selected[row.Value] {
			labels = append(labels, rowLabel(row))
		}
	}
	return labels
}

// rowLabel is a row's own label: the first left segment's text. A row's
// full left text can carry further segments after it (a hint, e.g. a
// worktree path) that the row itself renders alongside the label but the
// selected panel deliberately leaves out -- it lists picks, not their
// hints.
func rowLabel(row protocol.PickRow) string {
	if len(row.Left) == 0 {
		return ""
	}
	return row.Left[0].Text
}

// renderPanelRun re-styles the panel's prefix/label/separator runs -- faint
// prefix and separators against mint labels -- stopping at keptRunes so a
// clipped panel never colors past what clipRunes decided actually fits.
func renderPanelRun(prefix string, labels []string, keptRunes int, bg lipgloss.Style) string {
	var out strings.Builder
	runeIdx := 0
	write := func(s string, style lipgloss.Style) bool {
		for _, r := range s {
			if runeIdx >= keptRunes {
				return false
			}
			out.WriteString(style.Render(string(r)))
			runeIdx++
		}
		return true
	}
	if !write(prefix, bg.Foreground(theme.Faint)) {
		return out.String()
	}
	for i, label := range labels {
		if i > 0 && !write(" · ", bg.Foreground(theme.Faint)) {
			return out.String()
		}
		if !write(label, bg.Foreground(theme.Mint)) {
			return out.String()
		}
	}
	return out.String()
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

// highlightPositions re-ranks the live query against a row's own visible
// left text, so the returned positions always index runes that are
// actually on screen. Filtering ranks against matchText (row.Match when
// the caller supplies one, e.g. a separator-stripped alias) which can
// differ from leftPlain -- reusing that match's positions for highlight
// would then land on the wrong runes, or (worse) get suppressed outright
// wherever the two diverged, which is what left every override-match row
// with no highlight at all. An empty query has nothing to highlight, and
// a row that only matched via the alias (its visible text doesn't
// contain the query) correctly gets no positions back from Rank.
func highlightPositions(m *Model, leftPlain string) []int {
	if m.query == "" {
		return nil
	}
	hl := Rank(m.query, []string{leftPlain}, m.req.Exact)
	if len(hl) == 0 {
		return nil
	}
	return hl[0].Positions
}

// rowLineWidth paints one matched row within an explicit width: a 1-column
// gutter outside the highlight (pink bar on the cursor row, blank
// otherwise), then a SelBg/HoverBg-filled span carrying the left segments,
// matched-character highlight, spacer, and right segments pinned to the far
// edge. The width is explicit (rather than always m.width) because a
// scrolling list shrinks it by one column to make room for the thumb rail.
func rowLineWidth(m *Model, i int, width int) string {
	row := m.req.Rows[m.matches[i].Index]
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

	// The selection marker sits inside the row's own background (rowBg),
	// unlike the gutter -- it's part of the highlighted span on the board,
	// not the outer cursor indicator -- so it costs 2 columns out of the
	// same budget the left text and right segments share.
	selMarker := ""
	selMarkerWidth := 0
	if m.multiMode() {
		glyph, markColor := theme.GlyphStopped, theme.Faint
		if m.selected[row.Value] {
			glyph, markColor = theme.GlyphOn, theme.Mint
		}
		selMarker = rowBg.Foreground(markColor).Render(glyph + " ")
		selMarkerWidth = 2
	}

	// The Modifiers board's alt-held "enter → pick args" cursor-row badge
	// previews what enter now does, so it replaces the cursor row's own
	// right segments outright -- but only for a row PickRow.WithArgs
	// actually claims; a row without one keeps its ordinary right text even
	// while alt is held. argsDim is the board's "no args" fade: a
	// non-cursor row that doesn't claim WithArgs steps down to Faint while
	// alt is held. The cursor row is excluded regardless of WithArgs -- the
	// board keeps the focused row full-strength under its SelBg highlight
	// even when it has no args to preview, same as the badge's own
	// cursor-only gate.
	argsBadge := cursorRow && m.held.alt && row.WithArgs
	argsDim := m.held.alt && !row.WithArgs && !cursorRow

	rightPlain := plainConcat(row.Right)
	if argsBadge {
		rightPlain = " enter → pick args "
	}
	rightWidth := lipgloss.Width(rightPlain)

	// Budget: 1 gutter column + 1 separator column, plus a gap column ahead
	// of any right segments so they never touch the left text directly.
	leftBudget := width - 2 - selMarkerWidth - rightWidth
	if rightWidth > 0 {
		leftBudget--
	}
	if leftBudget < 0 {
		leftBudget = 0
	}

	leftPlain := leftPlainText(row)
	kept, truncated := clipRunes(leftPlain, leftBudget)
	leftRendered := renderHighlightedLeft(row, len([]rune(kept)), highlightPositions(m, leftPlain), rowBg, cursorRow, argsDim)
	usedLeftWidth := lipgloss.Width(kept)
	if truncated {
		leftRendered += rowBg.Foreground(theme.Faint).Render("…")
		usedLeftWidth++
	}

	spacer := width - 2 - selMarkerWidth - usedLeftWidth - rightWidth
	if spacer < 0 {
		spacer = 0
	}

	rightRendered := renderSegments(row.Right, rowBg, argsDim)
	if argsBadge {
		rightRendered = lipgloss.NewStyle().Background(theme.Lav).Foreground(theme.Bg).Bold(true).Render(rightPlain)
	}

	return gutter + rowBg.Render(" ") + selMarker + leftRendered + rowBg.Render(strings.Repeat(" ", spacer)) + rightRendered
}

// renderHighlightedLeft re-styles matched runes cyan bold while walking the
// left segments' own tone/hex/bold, stopping at keptRunes (the clip
// boundary) so a truncated row never highlights past what it actually
// shows. positions index by rune, not byte -- fzf's Chars falls back to a
// byte offset only when the target is pure ASCII, where the two coincide,
// so non-ASCII targets would misalign under byte-slicing. dim is the
// Modifiers board's alt-held "no args" fade: every segment's own
// tone/hex/bold and any match highlight are overridden to a flat Faint, so
// a row the current modifier can't act on never competes for attention
// against one that can.
func renderHighlightedLeft(row protocol.PickRow, keptRunes int, positions []int, rowBg lipgloss.Style, cursorRow bool, dim bool) string {
	matched := make(map[int]bool, len(positions))
	for _, p := range positions {
		matched[p] = true
	}
	var out strings.Builder
	runeIdx := 0
	for _, seg := range row.Left {
		color, bold := leftSegColor(seg, cursorRow)
		if dim {
			color, bold = theme.Faint, false
		}
		base := rowBg.Foreground(color).Bold(bold)
		for _, r := range seg.Text {
			if runeIdx >= keptRunes {
				return out.String()
			}
			style := base
			if !dim && matched[runeIdx] {
				style = rowBg.Foreground(theme.Cyan).Bold(true)
			}
			out.WriteString(style.Render(string(r)))
			runeIdx++
		}
	}
	return out.String()
}

// renderSegments paints Right's own tone/hex/bold as declared, except while
// dim overrides every segment to a flat Faint -- see renderHighlightedLeft.
func renderSegments(segs []protocol.PickSegment, rowBg lipgloss.Style, dim bool) string {
	var out strings.Builder
	for _, seg := range segs {
		color, bold := segColor(seg), seg.Bold
		if dim {
			color, bold = theme.Faint, false
		}
		out.WriteString(rowBg.Foreground(color).Bold(bold).Render(seg.Text))
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
