package picker

import (
	"encoding/json"
	"fmt"
	"image/color"
	"regexp"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"rt-ui/internal/protocol"
	"rt-ui/internal/theme"
)

// modalKind distinguishes the overlay's two mechanisms: a registry menu
// (ctrl-k / right-click) dispatches its chosen row through the same
// event/result paths a pressed key would, entirely locally; a TS-driven
// modal answers with a modal-result line and never dispatches anything
// itself.
type modalKind int

const (
	modalRegistry modalKind = iota
	modalTSDriven
)

// modalRow is one selectable row inside the overlay, normalized from either
// a registry MenuRow or a TS PickRow so the box has one renderer for both.
// isGlobal (registry rows only) marks the divider that separates item-scope
// rows from global-scope ones; value (TS rows only) is what modal-result
// reports back on selection.
type modalRow struct {
	text     string
	hint     string
	isGlobal bool
	actionID string
	value    string
}

// modalState is the picker's overlay: opened by ctrl-k/right-click (a
// registry menu, rendered from data the model already holds) or by a
// PickModal message (TS-driven), and closed either by a selection or by
// esc/click-outside. It carries its own query/cursor so typing narrows its
// rows exactly like the main list, and the parent picker underneath is
// never torn down while it's open.
type modalState struct {
	kind    modalKind
	title   string
	rows    []modalRow
	query   string
	matches []Match
	cursor  int
}

// refilter re-ranks the overlay's rows against its own query, reusing the
// same fzf-backed Rank the main list filters with so a modal with many rows
// narrows the same way. The divider between item- and global-scope rows is
// derived at render time from isGlobal, not tracked here, so refilter never
// has to reason about where it moved.
func (ms *modalState) refilter() {
	targets := make([]string, len(ms.rows))
	for i, r := range ms.rows {
		targets[i] = r.text
	}
	ms.matches = Rank(ms.query, targets, false)
	ms.cursor = 0
}

func (ms *modalState) moveCursor(delta int) {
	n := len(ms.matches)
	if n == 0 {
		return
	}
	ms.cursor += delta
	if ms.cursor < 0 {
		ms.cursor = 0
	}
	if ms.cursor >= n {
		ms.cursor = n - 1
	}
}

// menuCursorRow reports which visible row ctrl-k/right-click should act on,
// in the form deriveMenu expects (-1 for "no row" -- an empty list).
func (m *Model) menuCursorRow() int {
	if m.cursor < 0 || m.cursor >= len(m.matches) {
		return -1
	}
	return m.cursor
}

// composeFrame is renderView's own composition step before any height
// padding: the plain list, composited under the modal overlay when one is
// open. Kept separate from renderView so pinFrameHeight can measure a
// frame's own natural height without measuring back through padding an
// earlier call already applied.
func composeFrame(m *Model) string {
	body := render(m)
	if m.modal != nil && body != "" {
		body = renderModal(m, body)
	}
	return body
}

// padToHeight appends blank TRAILING lines until body reaches target lines.
// renderView reaches the reserved floor with renderFrame's interior filler
// (the keybar stays the last visible line); this only fires for the pin's
// extra height (pinnedHeight above the floor, hosting a wire modal taller than
// the list and held through its close), where trailing blanks are wanted --
// clearBottom strips them off screen, so bubbletea's frame line count holds
// across the close without the visible frame inflating once the overlay is
// gone. target <= body's height leaves body unpadded.
func padToHeight(body string, target int) string {
	if target <= 0 || body == "" {
		return body
	}
	if h := lipgloss.Height(body); h < target {
		body += strings.Repeat("\n", target-h)
	}
	return body
}

// reservedContentHeight is the session floor renderView pads to from the
// first paint: the row cap (the visible-row ceiling, past which the list
// scrolls), the tallest chrome the session can show, room for the group
// headers the cap never counted, and never past the pane. A frame padded to
// this never grows or shrinks as the query narrows, a descend swaps the rows,
// or ctrl-t toggles hidden files, so none of those re-enter the inline
// grow/shrink diff pinFrameHeight guards for.
func (m *Model) reservedContentHeight() int {
	rowCap := m.req.Cap
	if rowCap <= 0 {
		rowCap = defaultCap
	}
	// chromeRows counts one keybar line; the ctrl-held legend is two, and a
	// multi session can reveal the selected panel -- reserve both so holding
	// ctrl or checking a row never grows the frame.
	chrome := chromeRows + 1
	if isMultiRequest(m.req) {
		chrome++
	}
	// Grouped matches render contiguous (GroupContiguous partitions them after
	// Rank), so the whole list carries one header per group and any window shows
	// at most distinctGroupCount of them. Reserve that many header lines so a
	// typed query narrowing the list never crosses the floor.
	headers := distinctGroupCount(m.req.Rows)
	reserved := chrome + rowCap + headers
	if o := m.registryMenuHeight(); o > reserved {
		reserved = o
	}
	if m.height > 0 && reserved > m.height {
		reserved = m.height
	}
	return reserved
}

// registryMenuHeight is the height a ctrl-k / right-click overlay derived
// from this request's declared actions would occupy, so the reserved frame
// is tall enough to host it without the base list growing when it opens.
func (m *Model) registryMenuHeight() int {
	rows := deriveMenu(m.req.Actions, 0)
	if len(rows) == 0 {
		return 0
	}
	ms := &modalState{kind: modalRegistry, rows: modalRowsFromMenu(rows)}
	ms.refilter()
	return lipgloss.Height(renderModalBox(ms, m.width, -1))
}

// setReserved re-derives the floor from the current pane, dropping it when a
// resize shrinks the terminal (a resize is a full repaint, not the inline
// diff the floor exists to avoid). pinnedHeight tracks the floor up, and back
// down only when a shrunk pane leaves it taller than the terminal.
func (m *Model) setReserved() {
	m.reservedHeight = m.reservedContentHeight()
	if m.pinnedHeight < m.reservedHeight {
		m.pinnedHeight = m.reservedHeight
	}
	if m.height > 0 && m.pinnedHeight > m.height {
		m.pinnedHeight = m.reservedHeight
	}
}

// raiseReserved lifts the floor to cover a live row swap that needs more room
// (more groups, a breadcrumb the request gained) without ever lowering it
// within a fixed pane, so a descend into a shorter directory never shrinks
// the frame back.
func (m *Model) raiseReserved() {
	if r := m.reservedContentHeight(); r > m.reservedHeight {
		m.reservedHeight = r
	}
	if m.pinnedHeight < m.reservedHeight {
		m.pinnedHeight = m.reservedHeight
	}
}

// distinctGroupCount counts the distinct non-empty group labels across the
// rows. Since grouped matches render contiguous, this is exactly how many
// headers the whole list carries, and so the most any window can show -- the
// header room reservedContentHeight budgets.
func distinctGroupCount(rows []protocol.PickRow) int {
	seen := make(map[string]bool)
	for _, r := range rows {
		if r.Group != "" {
			seen[r.Group] = true
		}
	}
	return len(seen)
}

// pinFrameHeight raises the pad target to host an overlay taller than the
// session floor, so that overlay's own open and close repaint whole
// (armPinRelease holds the raise through the close's clearScreenMsg) rather
// than diffing across its grow and shrink. It never lowers the target; a
// shorter overlay opening over a taller floor changes nothing.
//
// The height this holds steady is exactly what bubbletea's own inline
// renderer treats as a "grow" or "shrink" transition -- entering that path
// is what the terminal's own idea of an ambiguous-width glyph's column
// cost (❯, ◉) can disagree with this renderer's own, slipping the
// differ's row bookkeeping for one frame and leaving a transitional
// stanza behind.
func (m *Model) pinFrameHeight() {
	if h := lipgloss.Height(composeFrame(m)); h > m.pinnedHeight {
		m.pinnedHeight = h
	}
}

// armPinRelease keeps a pinFrameHeight raise through this render (the close's
// own) and its one guaranteed clearScreenMsg follow-up, dropping the target
// back to the session floor (never to zero) only once both have rendered --
// see pinHoldFrames' own comment for why one call isn't enough.
func (m *Model) armPinRelease() {
	m.pinHoldFrames = 2
}

// openRegistryMenu opens the ctrl-k/right-click overlay from the request's
// own declared actions -- deriveMenu is the authority on which are dropped
// (every injected keybar default and every MenuHidden action stay keybar-only
// and never become menu rows). A request with nothing left to show leaves the
// picker untouched rather than opening an empty box.
func (m *Model) openRegistryMenu() {
	cursorRow := m.menuCursorRow()
	rows := deriveMenu(m.req.Actions, cursorRow)
	if len(rows) == 0 {
		return
	}
	title := "Actions"
	if cursorRow >= 0 {
		title = leftPlainText(m.req.Rows[m.matches[cursorRow].Index])
	}
	ms := &modalState{kind: modalRegistry, title: title, rows: modalRowsFromMenu(rows)}
	ms.refilter()
	m.modal = ms
	m.modalHover = -1
}

// openTSModal opens the overlay from a wire PickModal message, rendering
// the same box a registry menu does. A registry menu already open owes the
// wire nothing and is simply replaced. A TS-driven modal already open is
// different: the wire contract owes its caller exactly one modal-result
// line, and silently overwriting m.modal would leave that caller blocked
// forever waiting for an answer that never comes -- so it gets answered
// null, the same way esc-dismissing it would, before the new one opens.
// Either way the caller's own ClearScreen on the ModalMsg case (picker.go)
// repaints the transition, so no overlay's own residue survives into the
// next one.
func (m *Model) openTSModal(pm protocol.PickModal) {
	if m.modal != nil && m.modal.kind == modalTSDriven {
		m.writeModalResult(nil)
	}
	ms := &modalState{kind: modalTSDriven, title: pm.Message, rows: modalRowsFromPick(pm.Rows)}
	ms.refilter()
	m.modal = ms
	m.modalHover = -1
}

// modalRowsFromMenu flattens deriveMenu's ordered rows (item rows, an
// optional Rule sentinel, then global rows) into modalRows with isGlobal
// set on everything after the rule -- the rule itself becomes a render-time
// boundary rather than a row of its own, so it can never end up under the
// cursor or survive into a filtered view with nothing left on one side.
func modalRowsFromMenu(rows []MenuRow) []modalRow {
	out := make([]modalRow, 0, len(rows))
	global := false
	for _, r := range rows {
		if r.Rule {
			global = true
			continue
		}
		out = append(out, modalRow{
			text:     r.Label,
			hint:     keyGlyph(r.Key),
			isGlobal: global,
			actionID: r.ActionID,
		})
	}
	return out
}

func modalRowsFromPick(rows []protocol.PickRow) []modalRow {
	out := make([]modalRow, len(rows))
	for i, r := range rows {
		out[i] = modalRow{text: leftPlainText(r), hint: plainConcat(r.Right), value: r.Value}
	}
	return out
}

// keyGlyph renders a wire key ("ctrl-o", "ctrl-space") in a menu's compact
// glyph form (⌃o, ⌃space): the keybar spells modifiers out because it has a
// whole footer line to work with, but a menu's key column is narrow, so
// only the modifier collapses to a glyph -- the base key stays literal.
func keyGlyph(key string) string {
	if key == "" {
		return ""
	}
	replacer := strings.NewReplacer("ctrl-", "⌃", "alt-", "⌥", "shift-", "⇧")
	return replacer.Replace(key)
}

func actionByID(actions []protocol.PickAction, id string) (protocol.PickAction, bool) {
	for _, a := range actions {
		if a.ID == id {
			return a, true
		}
	}
	return protocol.PickAction{}, false
}

// updateModal handles a key press while the overlay is open: navigation and
// typing stay local to modalState, esc and enter close it.
func (m *Model) updateModal(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.closeModal()
		m.armPinRelease()
		return m, tea.ClearScreen
	case "down":
		m.modal.moveCursor(1)
		return m, nil
	case "up":
		m.modal.moveCursor(-1)
		return m, nil
	case "enter":
		return m.selectModalRow()
	case "backspace":
		if r := []rune(m.modal.query); len(r) > 0 {
			m.modal.query = string(r[:len(r)-1])
			m.modal.refilter()
		}
		return m, nil
	}
	if msg.Text != "" {
		m.modal.query += msg.Text
		m.modal.refilter()
		return m, nil
	}
	// A key that types nothing is never filter input, so a registry binding
	// for it fires straight from the menu. The menu's own keys above take
	// precedence, and a plain character always filters, so an action's key
	// only ever reaches here as a modifier combo or a special key.
	if m.modal.kind == modalRegistry {
		if action, ok := m.actionForKey(msg.String()); ok {
			return m.dispatchRegistryAction(action)
		}
	}
	return m, nil
}

// closeModal dismisses whichever overlay is open. A TS-driven modal owes
// the caller a modal-result line even when nothing was selected (esc,
// click-outside) -- the caller is blocked mid-flow waiting for an answer --
// so this always answers null for that kind; a registry menu is purely
// local and owes the wire nothing on a plain dismiss.
func (m *Model) closeModal() {
	if m.modal.kind == modalTSDriven {
		m.writeModalResult(nil)
	}
	m.modal = nil
}

// selectModalRow dispatches the row under the overlay's own cursor. A
// TS-driven modal always answers with a modal-result line and closes. A
// registry menu row is dispatched exactly as if its action's key had been
// pressed on the main list: event:true stays open and emits a PickEvent,
// anything else ends the session with the ordinary terminal PickResult.
// Every path that closes the overlay without quitting the program repaints
// with a full-frame clear (see closeModal/updateModal's esc case) so the
// next frame never shows the box's own residue underneath it.
func (m *Model) selectModalRow() (tea.Model, tea.Cmd) {
	ms := m.modal
	if ms.cursor < 0 || ms.cursor >= len(ms.matches) {
		return m, nil
	}
	row := ms.rows[ms.matches[ms.cursor].Index]

	if ms.kind == modalTSDriven {
		value := row.value
		m.writeModalResult(&value)
		m.modal = nil
		m.armPinRelease()
		return m, tea.ClearScreen
	}

	action, ok := actionByID(m.req.Actions, row.actionID)
	if !ok {
		m.modal = nil
		m.armPinRelease()
		return m, tea.ClearScreen
	}
	return m.dispatchRegistryAction(action)
}

// dispatchRegistryAction closes the registry menu and fires action against
// the row the menu was opened for (the cursor: a right-click open moves it
// there first), exactly as if the action's key had been pressed on the main
// list. Shared by selecting a menu row and by pressing the action's own key
// while the menu is open -- the hint the menu prints for it is a live
// accelerator, not documentation.
func (m *Model) dispatchRegistryAction(action protocol.PickAction) (tea.Model, tea.Cmd) {
	m.modal = nil
	m.armPinRelease()
	if action.Event {
		m.emitEvent(action.ID)
		return m, tea.ClearScreen
	}
	m.resultForAction(action.ID)
	return m.quit()
}

// writeModalResult answers a TS-driven modal through the same ordered
// writer an event uses (Model.enqueueOutput in picker.go), never a second,
// unsynchronized path to output -- a modal-result line is a mid-flight
// Go->TS message exactly like an event, and has to land before the
// terminal result the same way.
func (m *Model) writeModalResult(value *string) {
	m.enqueueOutput(encodeModalResult(value))
}

func encodeModalResult(value *string) []byte {
	b, _ := json.Marshal(protocol.PickModalResult{T: "modal-result", Value: value})
	return append(b, '\n')
}

// modalMinWidth floors the overlay's content width so a one-row menu still
// reads as a box rather than a sliver.
const modalMinWidth = 24

// renderModal composites the overlay over the already-rendered parent
// frame: the parent dims (dimForeground), the box sits centered on top of
// it as a lipgloss v2 layer -- Draw only touches the cells inside its own
// bounds, so nothing outside the box has to be repainted by hand.
func renderModal(m *Model, parent string) string {
	dimmed := dimForeground(parent)
	inner := modalInner(m.modal, m.width)
	lines, rowLines := modalBoxLines(m.modal, inner, m.modalHover)
	box := modalBoxFrame(lines)

	pw := m.width
	ph := lipgloss.Height(dimmed)
	mw := lipgloss.Width(box)
	mh := lipgloss.Height(box)

	x := (pw - mw) / 2
	if x < 0 {
		x = 0
	}
	y := (ph - mh) / 2
	if y < 0 {
		y = 0
	}

	m.recordModalZones(x, y, mw, mh, inner, rowLines)

	parentLayer := lipgloss.NewLayer(dimmed).X(0).Y(0).Z(0)
	modalLayer := lipgloss.NewLayer(box).X(x).Y(y).Z(1)
	return lipgloss.NewCompositor(parentLayer, modalLayer).Render()
}

// recordModalZones rebuilds m.modalZones and m.modalBox for the overlay
// currently composited at frame origin (boxX, boxY) with size (boxW, boxH),
// off the same rowLines the box was painted from.
//
// Offset invariant: the box is a centered compositor layer, not inline
// content, so a modal row's frame line is the box origin plus one border
// line plus that row's content-line offset (boxY + 1 + rowLines[i]), and its
// clickable column span is the box origin plus one border column across the
// inner width ([boxX+1, boxX+1+inner)). Mapping a mouse cell straight against
// the base list's row coordinates (which start at frame line 0) would miss
// the box entirely -- honoring this origin is the whole point of recording
// here, where the compositor's own centering offset is known.
func (m *Model) recordModalZones(boxX, boxY, boxW, boxH, inner int, rowLines []int) {
	zones := hitZones{}
	xStart := boxX + 1
	xEnd := xStart + inner
	for i, cl := range rowLines {
		frameY := boxY + 1 + cl
		zones.addAll(frameY, []mouseZone{{kind: zoneModalRow, xStart: xStart, xEnd: xEnd, row: i}})
	}
	m.modalZones = zones
	m.modalBox = modalBoxRect{x0: boxX, y0: boxY, x1: boxX + boxW, y1: boxY + boxH, valid: true}
}

// surfaceBg is the overlay's own background -- every line painted inside
// the box carries it explicitly (unlike the main list's onBg, which paints
// at the terminal's native background) since the box is composited over
// the dimmed parent rather than printed inline: a cell left with no
// explicit background renders at the terminal's ambient default, not
// "see-through" to whatever the parent drew there.
var surfaceBg = lipgloss.NewStyle().Background(theme.Surface)

func sfg(c color.Color) lipgloss.Style {
	return surfaceBg.Foreground(c)
}

// modalInner is the overlay's inner content width, capped to the pane and
// floored to modalMinWidth -- shared by renderModalBox and recordModalZones
// so a row's clickable column span can never drift from the width it paints
// at.
func modalInner(ms *modalState, parentWidth int) int {
	maxInner := parentWidth - 4
	if maxInner < modalMinWidth {
		maxInner = modalMinWidth
	}
	return modalContentWidth(ms, maxInner)
}

// modalBoxLines builds the overlay's inner lines and, in the same pass, the
// content-line offset each visible row lands on (rowLines[i] for match i).
// The two are returned together so recordModalZones can position a row's
// hit-zone against exactly the line this appended it on, never a second walk
// that could order the header/filter/rule/divider run differently. hover is
// the match index the pointer is over (-1 = none), painted HoverBg unless it
// is also the keyboard cursor.
func modalBoxLines(ms *modalState, inner, hover int) (lines []string, rowLines []int) {
	lines = []string{
		modalHeaderLine(ms, inner),
		modalFilterLine(ms, inner),
		modalRuleLine(inner),
	}
	if len(ms.matches) == 0 {
		lines = append(lines, modalNoMatchLine(inner))
		return lines, nil
	}
	rowLines = make([]int, len(ms.matches))
	for i, mt := range ms.matches {
		if modalDividerBefore(ms, i) {
			lines = append(lines, modalRuleLine(inner))
		}
		rowLines[i] = len(lines)
		lines = append(lines, modalRowLine(ms.rows[mt.Index], inner, i == ms.cursor, i == hover))
	}
	return lines, rowLines
}

// modalBoxFrame wraps the overlay's content lines in the Panel-colored
// rounded border on the Surface background.
func modalBoxFrame(lines []string) string {
	content := strings.Join(lines, "\n")
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(theme.Panel).
		BorderBackground(theme.Surface).
		Background(theme.Surface).
		Render(content)
}

// renderModalBox paints the overlay's own header/filter/rows onto a fixed
// inner width, then wraps it in the Panel-colored rounded border. hover is
// the match index the pointer is over (-1 for the measuring callers, which
// never paint a hover).
func renderModalBox(ms *modalState, parentWidth, hover int) string {
	lines, _ := modalBoxLines(ms, modalInner(ms, parentWidth), hover)
	return modalBoxFrame(lines)
}

// modalDividerBefore reports whether a rule belongs between matches[i-1]
// and matches[i] in the overlay's current (possibly filtered) order --
// mirrors render.go's headerBoundary, but on a boolean scope flip instead
// of a group label.
func modalDividerBefore(ms *modalState, i int) bool {
	if i == 0 {
		return false
	}
	cur := ms.rows[ms.matches[i].Index]
	prev := ms.rows[ms.matches[i-1].Index]
	return cur.isGlobal && !prev.isGlobal
}

// modalTitleCap bounds how much the title can widen the overlay. The rows are
// what size the box; a long cursor row (a full script command line) only
// clips in the header (modalHeaderLine) rather than stretching the menu to
// the pane.
const modalTitleCap = 40

func modalContentWidth(ms *modalState, maxInner int) int {
	titleW := lipgloss.Width(ms.title)
	if titleW > modalTitleCap {
		titleW = modalTitleCap
	}
	need := titleW + lipgloss.Width("esc dismiss") + 4
	for _, r := range ms.rows {
		w := 2 + lipgloss.Width(r.text)
		if r.hint != "" {
			w += 1 + lipgloss.Width(r.hint)
		}
		if w > need {
			need = w
		}
	}
	if need > maxInner {
		need = maxInner
	}
	if need < modalMinWidth {
		need = modalMinWidth
	}
	return need
}

// modalJustify fills width with bg's background, left text pinned left and
// right text pinned right -- the overlay's own version of render.go's
// justify, needed because every overlay line has to carry an explicit
// background (see surfaceBg) rather than the main list's native-background
// convention.
func modalJustify(width int, bg lipgloss.Style, left, right string) string {
	avail := width - lipgloss.Width(left)
	if avail < 0 {
		avail = 0
	}
	return left + lipgloss.PlaceHorizontal(avail, lipgloss.Right, right, lipgloss.WithWhitespaceStyle(bg))
}

// modalHeaderLine clips ms.title to what's actually left of width once the
// margin, the "esc dismiss" hint, and a gap column ahead of it are spoken
// for. modalContentWidth already sizes the box for the title in the common
// case, but caps at maxInner -- a title long enough to hit that cap (a
// registry menu's title is a row's own label, always short, but a
// TS-driven modal's title is caller-supplied free text with no such bound)
// would otherwise render past width uncapped, the one line in the box
// modalRowLine's own clipping convention didn't already cover.
func modalHeaderLine(ms *modalState, width int) string {
	const rightText = "esc dismiss"
	titleBudget := width - 1 - 1 - lipgloss.Width(rightText)
	if titleBudget < 0 {
		titleBudget = 0
	}
	kept, truncated := clipRunes(ms.title, titleBudget)
	title := kept
	if truncated {
		title += "…"
	}
	left := surfaceBg.Render(" ") + sfg(theme.Text).Bold(true).Render(title)
	right := sfg(theme.Faint).Render(rightText)
	return modalJustify(width, surfaceBg, left, right)
}

func modalFilterLine(ms *modalState, width int) string {
	left := surfaceBg.Render(" ") + sfg(theme.Pink).Render(theme.GlyphChevron+" ")
	if ms.query == "" {
		left += sfg(theme.Faint).Render("filter…")
	} else {
		left += sfg(theme.Text).Render(ms.query)
	}
	return modalJustify(width, surfaceBg, left, "")
}

func modalRuleLine(width int) string {
	return sfg(theme.Rule).Render(strings.Repeat("─", width))
}

func modalNoMatchLine(width int) string {
	left := surfaceBg.Render(" ") + sfg(theme.Faint).Render("no matches")
	return modalJustify(width, surfaceBg, left, "")
}

// modalRowLine paints one row: a 1-column gutter (pink bar on the overlay's
// own cursor row, blank otherwise), the label, and the hint pinned right.
// Item-scope rows read at TextSoft, global-scope rows at Dimmer -- the
// Actions board's registry menu renders global (structural, always-there)
// actions quieter than the item-scope ones a caller declared for this row;
// a TS-driven row (never isGlobal) always reads at the brighter tone.
// A hovered non-cursor row carries HoverBg, the same mouse hint the base
// list paints (see rowLineWidth); the keyboard cursor's SelBg always wins,
// so hover and cursor never both style one row.
func modalRowLine(row modalRow, width int, cursor, hover bool) string {
	rowBg := surfaceBg
	gutterGlyph := " "
	gutterStyle := surfaceBg
	switch {
	case cursor:
		rowBg = lipgloss.NewStyle().Background(theme.SelBg)
		gutterGlyph = theme.GlyphBar
		gutterStyle = rowBg.Foreground(theme.Pink)
	case hover:
		rowBg = lipgloss.NewStyle().Background(theme.HoverBg)
	}
	gutter := gutterStyle.Render(gutterGlyph)

	textColor := theme.TextSoft
	if row.isGlobal {
		textColor = theme.Dimmer
	}

	hintWidth := 0
	if row.hint != "" {
		hintWidth = 1 + lipgloss.Width(row.hint)
	}
	textBudget := width - 2 - hintWidth
	if textBudget < 0 {
		textBudget = 0
	}
	kept, truncated := clipRunes(row.text, textBudget)
	text := " " + kept
	if truncated {
		text += "…"
	}

	hint := ""
	if row.hint != "" {
		hint = rowBg.Foreground(theme.Faint).Render(row.hint)
	}

	left := gutter + rowBg.Foreground(textColor).Render(text)
	return modalJustify(width, rowBg, left, hint)
}

// fgTrueColorSGR matches a truecolor foreground escape's "38;2;R;G;B"
// parameter run wherever it appears in an already-rendered ANSI frame.
// Combined SGRs (bold+fg, fg+bg) put several parameter runs in one escape,
// so matching the run itself -- not the whole escape sequence -- is what
// lets one substitution pass dim every foreground color without disturbing
// bold, background, or reset codes sitting next to it.
var fgTrueColorSGR = regexp.MustCompile(`38;2;(\d{1,3});(\d{1,3});(\d{1,3})`)

// dimRamp is rt's text ramp stepped down one level, keyed by each tone's
// decimal "R;G;B" (how lipgloss actually renders a truecolor SGR) so
// dimForeground can look a match up with no parsing beyond what the regex
// already captured. Faint has nothing dimmer below it, so it maps to
// itself -- the floor of the ramp, not an omission.
var dimRamp = map[string]string{
	rgbKey(theme.Text):     rgbKey(theme.Dim),
	rgbKey(theme.TextSoft): rgbKey(theme.Dimmer),
	rgbKey(theme.Dim):      rgbKey(theme.Dimmer),
	rgbKey(theme.Dimmer):   rgbKey(theme.Faint),
	rgbKey(theme.Faint):    rgbKey(theme.Faint),
}

func rgbKey(c color.Color) string {
	r, g, b, _ := c.RGBA()
	return fmt.Sprintf("%d;%d;%d", r>>8, g>>8, b>>8)
}

// dimBlend is how far an out-of-ramp foreground color (an accent like Pink
// or Cyan, or a row's own explicit hex) is blended toward the picker's
// background when it has no named dimmer rung to step to.
const dimBlend = 0.4

func blendTowardBg(r, g, b int) (int, int, int) {
	br, bg, bb, _ := theme.Bg.RGBA()
	return blendChannel(r, int(br>>8)), blendChannel(g, int(bg>>8)), blendChannel(b, int(bb>>8))
}

func blendChannel(v, target int) int {
	return v + int(float64(target-v)*dimBlend)
}

// dimForeground steps down every truecolor foreground color in an
// already-rendered frame: this is the whole dimming transform, run once
// over the composed parent string, rather than a "dimmed" flag threaded
// through render.go's many fg() call sites. Named text-ramp tones map
// through dimRamp exactly; any other explicit foreground color (an accent,
// or a row's own hex) blends toward the background instead, since it has
// no lower rung to step to.
func dimForeground(s string) string {
	idxs := fgTrueColorSGR.FindAllStringSubmatchIndex(s, -1)
	if idxs == nil {
		return s
	}
	var out strings.Builder
	last := 0
	for _, loc := range idxs {
		out.WriteString(s[last:loc[0]])
		r, _ := strconv.Atoi(s[loc[2]:loc[3]])
		g, _ := strconv.Atoi(s[loc[4]:loc[5]])
		b, _ := strconv.Atoi(s[loc[6]:loc[7]])
		key := fmt.Sprintf("%d;%d;%d", r, g, b)
		dimmed, ok := dimRamp[key]
		if !ok {
			nr, ng, nb := blendTowardBg(r, g, b)
			dimmed = fmt.Sprintf("%d;%d;%d", nr, ng, nb)
		}
		out.WriteString("38;2;" + dimmed)
		last = loc[1]
	}
	out.WriteString(s[last:])
	return out.String()
}
