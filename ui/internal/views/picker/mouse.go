package picker

import (
	"strconv"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"rt-ui/internal/protocol"
	"rt-ui/internal/theme"
)

// doubleClickWindow is how close together two clicks on the same row have
// to land to read as a double-click rather than two separate single clicks.
// MouseMsg carries no click timestamp of its own, so Model.now() stamps
// each one on arrival.
const doubleClickWindow = 400 * time.Millisecond

// wheelStep is how many rows one wheel tick scrolls the viewport.
const wheelStep = 3

// zoneKind identifies what a recorded hit-zone targets.
type zoneKind int

const (
	zoneRow zoneKind = iota
	zoneMarker
	zoneCrumb
	zoneKeybarKey
	zoneModalRow
)

// modalBoxRect is the open overlay's bordered frame rectangle, recorded by
// recordModalZones so a press outside it can be told apart from one on a row
// (a dismiss vs. an activate). Half-open on both axes: [x0,x1) x [y0,y1).
// valid is false until a render has recorded one, so a click that somehow
// arrives before the first modal paint reads as outside rather than as the
// zero rectangle's corner.
type modalBoxRect struct {
	x0, y0, x1, y1 int
	valid          bool
}

func (r modalBoxRect) contains(x, y int) bool {
	return r.valid && x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1
}

// mouseZone is one clickable region recorded during render(): a half-open
// column span [xStart, xEnd) on one specific line of the current frame.
type mouseZone struct {
	kind         zoneKind
	xStart, xEnd int
	row          int                 // zoneRow, zoneMarker: match index
	segment      int                 // zoneCrumb: breadcrumb segment index
	action       protocol.PickAction // zoneKeybarKey: the action a click dispatches
}

// hitZones is render()'s own map of what each line targets, rebuilt on
// every call: Y indexes lines the same way render()'s own line slice does
// (0 = the breadcrumb, and so on), which is what lets a click account for
// interleaved group headers and the viewport's scrolled window without the
// click handler ever having to re-derive that layout itself.
type hitZones struct {
	byY map[int][]mouseZone
}

// addAll records every zone in zs as landing on line y.
func (z *hitZones) addAll(y int, zs []mouseZone) {
	if len(zs) == 0 {
		return
	}
	if z.byY == nil {
		z.byY = map[int][]mouseZone{}
	}
	z.byY[y] = append(z.byY[y], zs...)
}

// at reports the first recorded zone on line y whose column span contains
// x. A row's marker zone is always recorded ahead of its row zone (see
// rowZones), so a click inside the narrower marker span resolves to the
// marker rather than falling through to the row underneath it.
//
// Every caller (handleMouseClick, handleMouseMotion) passes mouse.Y straight
// through as content-relative (0 = the picker's own first rendered line,
// matching how render() numbers its zones): measured on a live terminal at
// two different frame anchors (frame starting at the screen's top row, and
// pushed down by prior scrollback), the absolute-vs-content Y delta was
// zero at both -- bubbletea v2's inline mouse coordinates are already
// frame-relative, so no translation is needed here.
func (z hitZones) at(x, y int) (mouseZone, bool) {
	for _, zone := range z.byY[y] {
		if x >= zone.xStart && x < zone.xEnd {
			return zone, true
		}
	}
	return mouseZone{}, false
}

// rowZones is the pair of zones one rendered row line contributes: the
// marker cell (multi-select only, columns [2,4) -- gutter then a blank
// column then the 2-wide glyph rowLineWidth always paints there) ahead of
// the row body spanning the row's full width, so a marker click resolves
// before the row-body click underneath it.
func rowZones(m *Model, matchIndex, width int) []mouseZone {
	zones := make([]mouseZone, 0, 2)
	if m.multiMode() {
		zones = append(zones, mouseZone{kind: zoneMarker, xStart: 2, xEnd: 4, row: matchIndex})
	}
	zones = append(zones, mouseZone{kind: zoneRow, xStart: 0, xEnd: width, row: matchIndex})
	return zones
}

// breadcrumbZones lays out one zone per breadcrumb segment, mirroring
// breadcrumbLine's own margin and " › " separator so a click resolves to
// whichever segment's text it actually landed on.
func breadcrumbZones(m *Model) []mouseZone {
	col := 2 // breadcrumbLine's own left margin, via justify
	zones := make([]mouseZone, 0, len(m.req.Breadcrumb))
	for i, part := range m.req.Breadcrumb {
		if i > 0 {
			col += lipgloss.Width(" › ")
		}
		start := col
		col += lipgloss.Width(part)
		zones = append(zones, mouseZone{kind: zoneCrumb, xStart: start, xEnd: col, segment: i})
	}
	return zones
}

// keybarLineZones is keybarLine's own layout, walked a second time in
// lockstep to record each clickable key's column span -- run from render()
// alongside the string it describes, not recomputed later against a stale
// frame. keybarLine itself delegates here and discards the zones, so the
// two can never drift into two different ideas of where a key landed.
// The Modifiers board's ctrl-held expanded keymap (a second footer row
// surfacing keys -- built-in navigation, alt-enter -- that the registry
// doesn't carry today) is not built here: it needs the same registry
// groundwork the nav ctrl-/ task lands, and a footer that silently grows a
// line while held has real chrome-budget implications this task didn't
// scope. m.held.ctrl is still tracked (see applyModifierHeld); wire the
// expanded keymap in alongside ctrl-/.
func keybarLineZones(m *Model, top, h, n int) (string, []mouseZone) {
	left, ungrouped := keybarClusters(effectiveActions(m.req))

	rangeText := ""
	if n > h {
		rangeText = fg(theme.Cyan).Render(strconv.Itoa(top+1)+"-"+strconv.Itoa(top+h)) +
			fg(theme.Faint).Render(" of "+strconv.Itoa(n))
	}
	ungroupedRendered := renderKeybarCluster(keybarCluster{actions: ungrouped})
	right := renderKeybarRight(rangeText, ungroupedRendered)

	// The right-pinned run (range + back/quit) always renders in full; the
	// left legend is what gives way at a narrow width, one whole group at a
	// time, never mid-key.
	left = truncateKeybarGroups(left, keybarLeftBudget(m.width, right))
	line := justify(m.width, renderKeybarLeft(left), right)

	var zones []mouseZone
	_, leftZones := layoutKeybarLeft(2, left)
	zones = append(zones, leftZones...)

	if len(ungrouped) > 0 {
		rightStart := m.width - 1 - lipgloss.Width(right)
		ungroupedStart := rightStart
		if rangeText != "" {
			ungroupedStart = rightStart + lipgloss.Width(rangeText) + lipgloss.Width(keybarRightSep)
		}
		_, ungroupedZones := layoutKeybarCluster(ungroupedStart, keybarCluster{actions: ungrouped})
		zones = append(zones, ungroupedZones...)
	}

	return line, zones
}

// layoutKeybarLeft walks the same groups, in the same order, that
// renderKeybarLeft joins with a 2-column gap -- returning the column just
// past the last one written, and every action's own zone within.
func layoutKeybarLeft(col int, groups []keybarCluster) (int, []mouseZone) {
	var zones []mouseZone
	for i, g := range groups {
		if i > 0 {
			col += 2
		}
		var gz []mouseZone
		col, gz = layoutKeybarCluster(col, g)
		zones = append(zones, gz...)
	}
	return col, zones
}

// layoutKeybarCluster mirrors renderKeybarCluster's own spacing rules
// exactly (a label plus one space before the first action when the cluster
// is labeled, "  " between actions, each action's own run being its key
// plus one space plus its label) so each action's zone covers precisely the
// "key label" run the board calls a clickable button.
func layoutKeybarCluster(col int, c keybarCluster) (int, []mouseZone) {
	var zones []mouseZone
	if c.label != "" {
		col += lipgloss.Width(c.label)
	}
	for i, a := range c.actions {
		if i == 0 {
			if c.label != "" {
				col++
			}
		} else {
			col += 2
		}
		start := col
		col += lipgloss.Width(a.Key) + 1 + lipgloss.Width(a.Label)
		zones = append(zones, mouseZone{kind: zoneKeybarKey, xStart: start, xEnd: col, action: a})
	}
	return col, zones
}

// now returns the clock a click is timestamped against -- m.nowFn when the
// model went through New, the real clock for a bare &Model{} a test built
// directly.
func (m *Model) now() time.Time {
	if m.nowFn != nil {
		return m.nowFn()
	}
	return time.Now()
}

// applyModifierHeld updates alt/ctrl held state from a bare modifier key's
// own press or release event, reporting whether code was in fact one of
// those keys. An ordinary key held down while alt is physically pressed
// still carries alt only in that event's own Mod field, never as its own
// Code, so this never fires for a normal keystroke -- only for the
// modifier's own, separate key event.
//
// A press (down) only engages held once reportsKeyReleases confirms the
// terminal delivers the matching release; a fallback terminal can still
// deliver the press but never the release, so latching held true there would
// strand the badge and the auto-expand on with nothing held. A release always
// clears, so it can never latch and is never gated.
func (m *Model) applyModifierHeld(code rune, down bool) bool {
	switch code {
	case tea.KeyLeftAlt, tea.KeyRightAlt:
		if m.reportsKeyReleases || !down {
			m.held.alt = down
		}
		return true
	case tea.KeyLeftCtrl, tea.KeyRightCtrl:
		if m.reportsKeyReleases || !down {
			m.held.ctrl = down
		}
		return true
	}
	return false
}

// handleMouseClick dispatches a button press against whichever zone
// render() last recorded under that cell. A miss (blank chrome, a group
// header line) and any button beyond left/right are inert.
func (m *Model) handleMouseClick(msg tea.MouseClickMsg) (tea.Model, tea.Cmd) {
	if m.modal != nil {
		return m.modalMouseClick(msg)
	}
	mouse := msg.Mouse()
	zone, ok := m.zones.at(mouse.X, mouse.Y)
	if !ok {
		return m, nil
	}
	switch mouse.Button {
	case tea.MouseRight:
		return m.clickRight(zone)
	case tea.MouseLeft:
		return m.clickLeft(zone)
	}
	return m, nil
}

// modalMouseClick routes a press against the open overlay: a left/right press
// on a modal row activates it through the very path a keyboard select of that
// row takes (set the overlay's own cursor, then selectModalRow), so the
// dispatched event/result is identical to enter's. A press anywhere outside
// the box dismisses it exactly as esc does. A press inside the box but off any
// row is inert, like a click on the base list's own chrome.
func (m *Model) modalMouseClick(msg tea.MouseClickMsg) (tea.Model, tea.Cmd) {
	mouse := msg.Mouse()
	if mouse.Button != tea.MouseLeft && mouse.Button != tea.MouseRight {
		return m, nil
	}
	if zone, ok := m.modalZones.at(mouse.X, mouse.Y); ok && zone.kind == zoneModalRow {
		m.modal.cursor = zone.row
		return m.selectModalRow()
	}
	if !m.modalBox.contains(mouse.X, mouse.Y) {
		m.closeModal()
		m.armPinRelease()
		return m, tea.ClearScreen
	}
	return m, nil
}

// clickRight opens the registry menu at whichever row was clicked -- the
// same overlay ctrl-k opens, just pre-aimed at this row instead of wherever
// the keyboard cursor already sat.
func (m *Model) clickRight(zone mouseZone) (tea.Model, tea.Cmd) {
	if zone.kind != zoneRow && zone.kind != zoneMarker {
		return m, nil
	}
	m.cursor = zone.row
	m.openRegistryMenu()
	if m.modal != nil {
		m.pinFrameHeight()
		return m, tea.ClearScreen
	}
	return m, nil
}

func (m *Model) clickLeft(zone mouseZone) (tea.Model, tea.Cmd) {
	switch zone.kind {
	case zoneMarker:
		m.cursor = zone.row
		m.toggleCursor()
		return m, nil
	case zoneRow:
		return m.clickRow(zone.row)
	case zoneCrumb:
		return m.clickCrumb(zone.segment)
	case zoneKeybarKey:
		return m.dispatchAction(zone.action)
	}
	return m, nil
}

// clickRow moves the keyboard cursor to the clicked row, then checks
// whether this arrived within doubleClickWindow of the previous click on
// that same row -- the only click-pairing signal available, since
// MouseMsg carries no timestamp. A double-click accepts exactly like enter
// would (selectCursor already knows the single-vs-multi difference), and
// clears the pairing so a third rapid click starts a fresh pair rather than
// re-triggering.
func (m *Model) clickRow(row int) (tea.Model, tea.Cmd) {
	now := m.now()
	isDouble := row == m.lastClickRow && !m.lastClickAt.IsZero() && now.Sub(m.lastClickAt) <= doubleClickWindow

	m.cursor = row
	if isDouble {
		m.lastClickRow = -1
		m.lastClickAt = time.Time{}
		m.selectCursor()
		return m.quit()
	}
	m.lastClickRow = row
	m.lastClickAt = now
	return m, nil
}

// clickCrumb reports a breadcrumb click as a crumb event, but only when the
// request opted in via crumbEvents -- otherwise a caller that never wired a
// listener for it would have no way to know a click happened, so the click
// is simply inert instead.
func (m *Model) clickCrumb(segment int) (tea.Model, tea.Cmd) {
	if !m.req.CrumbEvents {
		return m, nil
	}
	value := strconv.Itoa(segment)
	ev := protocol.PickEvent{Action: "crumb", Value: &value, Query: m.query}
	m.enqueueOutput(protocol.EncodePickEvent(ev))
	return m, nil
}

// dispatchAction runs a keybar key's action exactly as if its bound key had
// been pressed. The three built-in multi mark actions are intercepted the
// same way Update's own key switch intercepts space/tab/ctrl-a -- they
// exist in the registry only to appear in the footer legend, and would
// mis-fire through the generic event/result dispatch below (which is what
// their real keys never go through either).
func (m *Model) dispatchAction(action protocol.PickAction) (tea.Model, tea.Cmd) {
	switch action.ID {
	case idToggle:
		m.toggleCursor()
		return m, nil
	case idToggleNext:
		m.toggleCursor()
		m.moveCursor(1)
		return m, nil
	case idToggleAll:
		m.toggleAllVisible()
		return m, nil
	}
	if action.Event {
		m.emitEvent(action.ID)
		return m, nil
	}
	m.resultForAction(action.ID)
	return m.quit()
}

// handleMouseMotion tracks which row the pointer is over. Hover is purely a
// render hint (render.go paints HoverBg on m.hover) and never touches
// m.cursor -- the keyboard's place in the list is the keyboard's alone, so
// moving the mouse across the list can never steal it.
func (m *Model) handleMouseMotion(msg tea.MouseMotionMsg) (tea.Model, tea.Cmd) {
	if m.modal != nil {
		return m.modalMouseMotion(msg)
	}
	mouse := msg.Mouse()
	zone, ok := m.zones.at(mouse.X, mouse.Y)
	if ok && (zone.kind == zoneRow || zone.kind == zoneMarker) {
		m.hover = zone.row
	} else {
		m.hover = -1
	}
	return m, nil
}

// modalMouseMotion tracks which overlay row the pointer is over, the modal's
// counterpart to handleMouseMotion: it sets modalHover (a render hint
// modalRowLine paints HoverBg on) and never the overlay's keyboard cursor,
// so moving the mouse across the menu can no more steal its cursor than it
// can the base list's.
func (m *Model) modalMouseMotion(msg tea.MouseMotionMsg) (tea.Model, tea.Cmd) {
	mouse := msg.Mouse()
	if zone, ok := m.modalZones.at(mouse.X, mouse.Y); ok && zone.kind == zoneModalRow {
		m.modalHover = zone.row
	} else {
		m.modalHover = -1
	}
	return m, nil
}

// handleMouseWheel scrolls the viewport by wheelStep rows, independent of
// the cursor, then defers to scrollViewport for the one case that does
// touch the cursor: the window scrolling past it entirely.
func (m *Model) handleMouseWheel(msg tea.MouseWheelMsg) (tea.Model, tea.Cmd) {
	if m.modal != nil {
		return m, nil
	}
	mouse := msg.Mouse()
	switch mouse.Button {
	case tea.MouseWheelUp:
		m.scrollViewport(-wheelStep)
	case tea.MouseWheelDown:
		m.scrollViewport(wheelStep)
	}
	return m, nil
}

// scrollViewport moves m.viewportTop by delta, clamped to the list's range,
// and leaves m.cursor alone -- except when the cursor would otherwise fall
// outside the new window. "Outside" is judged against the same scrolloff
// margin placeTop enforces (see scrollMargin), not just the window's raw
// edges: the very next render() calls m.viewport(), which re-derives top
// from the cursor via placeTop, and placeTop only ever leaves a prevTop
// unchanged when the cursor already sits within that margin of it. Clamping
// the cursor into the margin here, not just into the raw window, is what
// keeps the wheel's own scroll from being silently overridden one frame
// later.
func (m *Model) scrollViewport(delta int) {
	n := len(m.matches)
	if n == 0 {
		return
	}
	top, h := m.viewport()
	if h <= 0 {
		return
	}
	maxTop := n - h
	if maxTop < 0 {
		maxTop = 0
	}
	top += delta
	if top < 0 {
		top = 0
	}
	if top > maxTop {
		top = maxTop
	}
	m.viewportTop = top

	off := scrollMargin(h)
	lo, hi := top+off, top+h-1-off
	switch {
	case m.cursor < lo:
		m.cursor = lo
	case m.cursor > hi:
		m.cursor = hi
	}
}
