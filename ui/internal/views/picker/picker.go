package picker

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/colorprofile"
	"github.com/charmbracelet/x/ansi"

	"rt-ui/internal/protocol"
	"rt-ui/internal/tty"
)

// heldModifiers tracks whether alt/ctrl are currently physically held, for
// the Modifiers board's reactive chrome (the "with args" badge, the
// expanded keybar). A bare modifier key's own KeyPressMsg sets the
// corresponding field; its KeyReleaseMsg clears it. A terminal that never
// reports key release events also never reports a bare modifier press as
// its own key event in the first place, so on such a terminal these fields
// simply never flip -- there is no stuck-held state to guard against, only
// an absent one.
type heldModifiers struct {
	alt  bool
	ctrl bool
}

// Model is the picker's Bubble Tea model. Every field the later render,
// filter, action, modal, and mouse tasks need is scaffolded now so each one
// only fills in behavior, never reshapes the struct.
type Model struct {
	req         protocol.PickRequest
	query       string
	cursor      int
	viewportTop int
	matches     []Match
	selected    map[string]bool
	modal       *modalState
	held        heldModifiers
	hover       int
	width       int
	height      int

	// pinnedHeight, when > 0, is the line-count height renderView pads every
	// frame to. Set the moment an overlay opens, to whatever it and the
	// list beneath it naturally need, and held through the overlay's own
	// close so neither transition crosses bubbletea's genuine-height-change
	// redraw path -- see pinFrameHeight's own comment for why that path is
	// the one worth avoiding. pinHoldFrames, armed by armPinRelease, keeps
	// it held for that many more Update calls past the close before
	// releasing -- 2, not 1: the close's own render is already covered
	// without decrementing anything, and tea.ClearScreen's own Cmd sends
	// exactly one clearScreenMsg back through Update asynchronously, whose
	// render is still part of the same close transition, not yet "the next
	// unrelated one" this pin is meant to survive until.
	pinnedHeight  int
	pinHoldFrames int

	// zones is the render pass's own record of what each rendered line's
	// columns target, rebuilt every render() call; mouse.go's click/motion
	// handlers only ever read it, never recompute layout themselves.
	zones hitZones
	// lastClickRow/lastClickAt pair a row click with whatever click preceded
	// it, the only way to detect a double-click: MouseMsg carries no click
	// timestamp of its own. -1 is "no previous click" (never a valid match
	// index), so the very first click on a session can never read as one
	// half of a pair.
	lastClickRow int
	lastClickAt  time.Time
	// nowFn stands in for time.Now so a test can drive double-click timing
	// deterministically; nil (a bare &Model{} a test builds directly, not
	// through New) falls back to the real clock in now().
	nowFn func() time.Time

	// output is where the event writer and the final result write land;
	// Run wires the real stdout, tests wire a buffer directly.
	output io.Writer
	// events carries an event:true action's encoded PickEvent line from
	// Update (which enqueues synchronously, on the single goroutine tea
	// runs Update on) to the one writer goroutine Run starts, which drains
	// it in order. Nil in a bare model test that never dispatches an
	// event: emitEvent checks before sending so it never blocks on a
	// channel nobody is reading.
	events   chan []byte
	outputMu sync.Mutex

	result *protocol.PickResult
}

// UpdateMsg carries a mid-flight PickUpdate patch into the running program.
// readPatches decodes it off input and hands it to tea.Program.Send, the
// same bridge session.go uses to get external NDJSON onto the single
// goroutine Update runs on.
type UpdateMsg struct {
	Update protocol.PickUpdate
}

// ModalMsg carries a TS-driven PickModal into the running program, the same
// way UpdateMsg carries a PickUpdate.
type ModalMsg struct {
	Modal protocol.PickModal
}

// New builds a Model from an opening request and ranks it against
// InitialQuery immediately, so a request that opens pre-filtered renders
// its real matches on the first frame rather than the identity order.
func New(req protocol.PickRequest) *Model {
	m := &Model{
		req:          req,
		query:        req.InitialQuery,
		selected:     make(map[string]bool),
		hover:        -1,
		lastClickRow: -1,
		nowFn:        time.Now,
	}
	for _, v := range req.InitialValues {
		m.selected[v] = true
	}
	m.refilter()
	return m
}

// isMultiRequest reports whether a request wants multi-select interactions:
// either the caller asked for Multi outright, or asked for the pinned
// selected panel on its own, which still needs a way to add rows to it.
func isMultiRequest(req protocol.PickRequest) bool {
	return req.Multi || req.SelectedPanel
}

func (m *Model) multiMode() bool {
	return isMultiRequest(m.req)
}

// showSelectedPanel mirrors multiMode, gated further by at least one row
// actually being selected: an empty panel would render as a bare "selected"
// label with nothing after it, so it -- and the header's own N-selected
// chip, see countText -- wait for the first pick instead of occupying
// chrome nobody has used yet.
func (m *Model) showSelectedPanel() bool {
	return m.multiMode() && len(m.selected) > 0
}

// refilter re-ranks matches against the current query. Rank itself already
// short-circuits an empty query to the identity order, so this is safe to
// call unconditionally.
func (m *Model) refilter() {
	targets := make([]string, len(m.req.Rows))
	for i, row := range m.req.Rows {
		targets[i] = matchText(row)
	}
	m.matches = Rank(m.query, targets, m.req.Exact)
}

func (m *Model) Init() tea.Cmd { return nil }

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if m.pinHoldFrames > 0 {
		m.pinHoldFrames--
		if m.pinHoldFrames == 0 {
			m.pinnedHeight = 0
		}
	}
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	case UpdateMsg:
		m.applyUpdate(msg.Update)
	case ModalMsg:
		m.openTSModal(msg.Modal)
		m.pinFrameHeight()
		return m, tea.ClearScreen
	case tea.MouseClickMsg:
		return m.handleMouseClick(msg)
	case tea.MouseMotionMsg:
		return m.handleMouseMotion(msg)
	case tea.MouseWheelMsg:
		return m.handleMouseWheel(msg)
	case tea.KeyReleaseMsg:
		m.applyModifierHeld(msg.Code, false)
	case tea.KeyPressMsg:
		if m.applyModifierHeld(msg.Code, true) {
			return m, nil
		}
		if m.modal != nil {
			return m.updateModal(msg)
		}
		key := msg.String()
		switch key {
		case "down":
			m.moveCursor(1)
			return m, nil
		case "up":
			m.moveCursor(-1)
			return m, nil
		case "space":
			if m.multiMode() {
				m.toggleCursor()
				return m, nil
			}
		case "tab":
			if m.multiMode() {
				m.toggleCursor()
				m.moveCursor(1)
				return m, nil
			}
		case "ctrl+a":
			if m.multiMode() {
				m.toggleAllVisible()
				return m, nil
			}
		}
		if action, ok := m.actionForKey(key); ok {
			if action.Event {
				m.emitEvent(action.ID)
				return m, nil
			}
			m.resultForAction(action.ID)
			return m, tea.Quit
		}
		if key == "ctrl+k" {
			m.openRegistryMenu()
			if m.modal != nil {
				m.pinFrameHeight()
				return m, tea.ClearScreen
			}
			return m, nil
		}
		if key == "enter" {
			if len(m.matches) == 0 && m.req.AcceptNoMatch {
				m.result = &protocol.PickResult{Action: idSelect, Value: nil, Query: m.query}
				return m, tea.Quit
			}
			m.selectCursor()
			return m, tea.Quit
		}
		if key == "esc" {
			// Reached only once a declared esc action has already had its
			// chance via actionForKey above, so this is the fallback that
			// keeps the keybar's own "esc quit" honest for a request that
			// declares nothing: cancel is otherwise unreachable from the
			// keyboard on a bare picker.
			m.result = &protocol.PickResult{Action: idCancel, Query: m.query}
			return m, tea.Quit
		}
		if key == "backspace" {
			if r := []rune(m.query); len(r) > 0 {
				m.setQuery(string(r[:len(r)-1]))
			}
			return m, nil
		}
		// msg.Text carries the produced character(s) only for genuinely
		// printable key presses (bubbletea leaves it empty for arrows,
		// enter, and modifier combos), so this is what distinguishes real
		// typed input from every special key already handled above.
		if msg.Text != "" {
			m.setQuery(m.query + msg.Text)
			return m, nil
		}
	}
	return m, nil
}

// setQuery replaces the query, re-ranks matches against it, and rebinds
// the cursor to the top: a changed query reorders and resizes the match
// set, so whatever row the cursor sat on before may no longer exist or
// may no longer be adjacent to where it lands now.
func (m *Model) setQuery(q string) {
	m.query = q
	m.refilter()
	m.cursor = 0
	m.viewportTop = 0
}

// applyUpdate patches whichever fields the message carries; each is replaced
// wholesale rather than merged, matching PickUpdate's own "any subset of
// fields present" contract. A row replacement re-ranks against the query
// that's already live and re-resolves the cursor, since the old match
// indices no longer describe the new row set.
func (m *Model) applyUpdate(u protocol.PickUpdate) {
	if u.Message != "" {
		m.req.Message = u.Message
	}
	if u.Actions != nil {
		m.req.Actions = u.Actions
	}
	if u.Rows != nil {
		value, hadCursor := m.cursorRowValue()
		prevCursor := m.cursor
		m.req.Rows = u.Rows
		m.refilter()
		m.cursor = m.resolveCursor(value, hadCursor, prevCursor)
	}
}

// resolveCursor keeps the cursor pinned to the row the user was looking at
// across a live replacement: an index-based cursor would otherwise land on
// whatever row happens to reshuffle into the old numeric slot. When that
// row is gone from the new set, the previous numeric position is clamped
// into the new range instead of resetting to the top.
func (m *Model) resolveCursor(value string, had bool, prev int) int {
	if had {
		for i, mt := range m.matches {
			if m.req.Rows[mt.Index].Value == value {
				return i
			}
		}
	}
	n := len(m.matches)
	switch {
	case n == 0:
		return 0
	case prev >= n:
		return n - 1
	case prev < 0:
		return 0
	default:
		return prev
	}
}

// actionForKey resolves a pressed key against the registry. The wire's key
// strings follow the picker's display convention (hyphenated, e.g.
// "ctrl-r", matching the footer legend elsewhere in this package) while
// bubbletea's own Key.String() joins modifiers with "+" (e.g. "ctrl+r"); the
// translation happens here so the registry can stay in the display form
// without every producer needing to know bubbletea's wire format.
func (m *Model) actionForKey(key string) (protocol.PickAction, bool) {
	for _, a := range m.req.Actions {
		if a.Key != "" && strings.ReplaceAll(a.Key, "-", "+") == key {
			return a, true
		}
	}
	return protocol.PickAction{}, false
}

// cursorRowValue reads the value of the row currently under the cursor;
// the bool is false when there is no row to read (an empty list, or a
// cursor a caller pushed out of bounds directly).
func (m *Model) cursorRowValue() (string, bool) {
	if m.cursor < 0 || m.cursor >= len(m.matches) {
		return "", false
	}
	return m.req.Rows[m.matches[m.cursor].Index].Value, true
}

// resultForAction terminates the session with a registry action's id as the
// result's Action, mirroring selectCursor's shape for the built-in "select".
// The confirm action in a multi session is the one exception: it carries the
// whole selected set, not the cursor row alone. Any other exit action in a
// multi session still carries that same checked set on Values (alongside
// Value, the cursor row), so a bulk action -- commit's ctrl-d discard --
// acts on what the user checked, not on wherever the cursor sits.
func (m *Model) resultForAction(actionID string) {
	if actionID == idSelect && m.multiMode() {
		m.selectMulti()
		return
	}
	var value *string
	if v, ok := m.cursorRowValue(); ok {
		value = &v
	}
	result := &protocol.PickResult{Action: actionID, Value: value, Query: m.query}
	if m.multiMode() {
		result.Values = m.selectedValuesInOrder()
	}
	m.result = result
}

// toggleCursor flips the selection state of the row under the cursor,
// keyed by value so it survives the row reordering a re-filter causes.
func (m *Model) toggleCursor() {
	value, ok := m.cursorRowValue()
	if !ok {
		return
	}
	if m.selected[value] {
		delete(m.selected, value)
	} else {
		m.selected[value] = true
	}
}

// toggleAllVisible is ctrl-a's all/none rule: any unselected row still in
// the current (filtered) match set means "select everything visible";
// otherwise every visible row is already selected, so the same key clears
// them. A row hidden by the active filter is never touched either way.
func (m *Model) toggleAllVisible() {
	anyUnselected := false
	for _, mt := range m.matches {
		if !m.selected[m.req.Rows[mt.Index].Value] {
			anyUnselected = true
			break
		}
	}
	for _, mt := range m.matches {
		value := m.req.Rows[mt.Index].Value
		if anyUnselected {
			m.selected[value] = true
		} else {
			delete(m.selected, value)
		}
	}
}

// selectMulti terminates a multi session: Values lists every selected row
// in request order (the order m.req.Rows was declared in), not selection
// order, so a caller can zip the result against its own row list
// positionally without re-deriving an order of its own.
func (m *Model) selectMulti() {
	m.result = &protocol.PickResult{Action: idSelect, Values: m.selectedValuesInOrder(), Query: m.query}
}

// selectedValuesInOrder lists every checked row's value in request order --
// the same order selectMulti's own Values carries, shared with any other
// multi-mode exit action's Values (see resultForAction).
func (m *Model) selectedValuesInOrder() []string {
	values := make([]string, 0, len(m.selected))
	for _, row := range m.req.Rows {
		if m.selected[row.Value] {
			values = append(values, row.Value)
		}
	}
	return values
}

// emitEvent reports an event:true action without ending the session. It
// encodes and enqueues onto m.events synchronously, inside Update's own
// call -- not inside a returned tea.Cmd. Bubble Tea does not wait for a
// still-running Cmd's goroutine on shutdown (it leaks them intentionally so
// shutdown isn't held up by a slow one), so a write left to run inside a
// Cmd has no guaranteed order against whatever runs after the program
// exits; a synchronous enqueue here, ahead of the terminal key press's own
// later Update call, does. The one writer goroutine startEventWriter starts
// is what actually performs the output write, in the order things were
// enqueued.
func (m *Model) emitEvent(actionID string) {
	var value *string
	if v, ok := m.cursorRowValue(); ok {
		value = &v
	}
	ev := protocol.PickEvent{Action: actionID, Value: value, Query: m.query}
	m.enqueueOutput(protocol.EncodePickEvent(ev))
}

// enqueueOutput sends an already-encoded line onto the ordered event
// writer. A modal-result line (modal.go) is, like an event, a mid-flight
// Go->TS message that has to land before the terminal result -- routing
// both through this one send keeps that ordering guarantee to a single
// choke point instead of a second, unsynchronized path to output. Nil
// m.events (a bare model in a test that never wires Run's writer) drops
// the line rather than blocking forever on a channel nobody drains.
func (m *Model) enqueueOutput(line []byte) {
	if m.events == nil {
		return
	}
	m.events <- line
}

// startEventWriter starts the single goroutine that drains m.events onto
// output, one line per event, in the order Update enqueued them. Returns a
// channel that closes once the drain loop has exited -- after m.events is
// closed and every already-buffered event has been written -- so a caller
// can block until it is safe to write the terminal result.
func (m *Model) startEventWriter(output io.Writer) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		for line := range m.events {
			m.outputMu.Lock()
			_, _ = output.Write(line)
			m.outputMu.Unlock()
		}
	}()
	return done
}

// drainEvents closes m.events and blocks until the writer goroutine has
// finished writing every event that was buffered before the close. Only
// call this once Update can no longer be invoked (Bubble Tea's event loop
// has stopped): closing a channel that a later Update might still send on
// would panic.
func (m *Model) drainEvents(writerDone <-chan struct{}) {
	close(m.events)
	<-writerDone
}

// writeResult writes the terminal PickResult. Call only after drainEvents,
// so every event line the session enqueued is already on output ahead of
// it -- the wire contract event lines are additional lines before the
// single terminal result depends on that ordering, not merely on the bytes
// of any one line staying intact.
func (m *Model) writeResult(output io.Writer) error {
	result := m.result
	if result == nil {
		result = &protocol.PickResult{Action: "cancel", Query: m.query}
	}
	m.outputMu.Lock()
	_, err := output.Write(protocol.EncodePickResult(*result))
	m.outputMu.Unlock()
	return err
}

func (m *Model) moveCursor(delta int) {
	n := len(m.matches)
	if n == 0 {
		return
	}
	m.cursor += delta
	if m.cursor < 0 {
		m.cursor = 0
	}
	if m.cursor >= n {
		m.cursor = n - 1
	}
}

// viewport derives the current scroll window from the cursor, re-using (and
// persisting) the previous top so repeated calls scroll in small steps
// rather than recentering from scratch every frame. A pane height of zero
// means no WindowSizeMsg has landed yet -- true at construction, and true
// for a test that builds a Model and calls render directly -- so that case
// is treated as an unbounded pane, leaving cap and list length alone to
// decide h. A real pane height additionally has to give some of its budget
// back to group headers: Viewport's own ceiling only ever counted match
// rows, so a window dense with group boundaries can still paint more lines
// than the pane has room for unless it's trimmed again here.
func (m *Model) viewport() (top, h int) {
	rows := m.totalChromeRows()
	pane := m.height
	bounded := pane > 0
	if !bounded {
		pane = len(m.matches) + rows
	}
	top, h = Viewport(m.cursor, m.viewportTop, len(m.matches), m.req.Cap, pane, rows)
	if bounded {
		top, h = m.fitHeaderBudget(h, pane-rows)
	}
	m.viewportTop = top
	return top, h
}

// fitHeaderBudget finds the tallest window that still fits budget display
// lines once its interleaved group headers are counted in, re-deriving a
// scrolloff-correct top via placeTop for every height it tries rather than
// eroding whatever edge a shrink first reaches: eroding an edge in place
// can leave the cursor pinned on the window's last visible line even when
// the now-smaller height could easily afford full scrolloff margin on both
// sides, since erosion never revisits where the window ought to sit once it
// stops moving. Once the window has shrunk to the cursor's own row, that
// row is kept regardless of budget -- hiding the selection is worse than a
// pane too small to hold a lone header and its row overflowing by a line.
func (m *Model) fitHeaderBudget(h, budget int) (top, finalH int) {
	if budget < 0 {
		budget = 0
	}
	n := len(m.matches)
	for h > 1 {
		top := placeTop(m.cursor, m.viewportTop, n, h)
		if h+headerCount(m, top, h) <= budget {
			return top, h
		}
		h--
	}
	return placeTop(m.cursor, m.viewportTop, n, h), h
}

// selectCursor terminates the session with the row under the cursor. The
// bounds guard covers a zero-row request, which moveCursor never lets the
// cursor leave but Update's enter case can still reach directly. A multi
// session defers entirely to selectMulti: enter confirms the selected set,
// not whatever row the cursor happens to be sitting on.
func (m *Model) selectCursor() {
	if m.multiMode() {
		m.selectMulti()
		return
	}
	if m.cursor < 0 || m.cursor >= len(m.matches) {
		return
	}
	value := m.req.Rows[m.matches[m.cursor].Index].Value
	m.result = &protocol.PickResult{Action: idSelect, Value: &value, Query: m.query}
}

// renderView is the frame View() paints: composeFrame's own plain-list-or-
// composited-overlay content, padded to m.pinnedHeight when an overlay
// open/close transition has one active. A separate function from render()
// so a test can assert on the modal-composited frame without going through
// tea.View's own wrapper.
func renderView(m *Model) string {
	return padToHeight(composeFrame(m), m.pinnedHeight)
}

func (m *Model) View() tea.View {
	v := tea.NewView(renderView(m))
	// Inline, not alt-screen: the picker is content-anchored, appearing
	// where the caller invoked it rather than taking over the terminal.
	v.MouseMode = tea.MouseModeAllMotion
	v.KeyboardEnhancements.ReportEventTypes = true
	return v
}

// Run drives the picker to completion: it paints on /dev/tty (never input or
// output, which carry the NDJSON protocol -- same split as prompt/session)
// and writes exactly one result line to output before returning.
func Run(req protocol.PickRequest, input io.Reader, output io.Writer) error {
	term, err := tty.Open(tty.ReadWrite)
	if err != nil {
		return err
	}
	defer term.Close()

	if f, ok := output.(*os.File); ok && stdoutIsATerminal(f) {
		return errStdoutSharesTTY
	}

	m := New(req)
	m.output = output
	m.events = make(chan []byte, eventBufferSize)
	writerDone := m.startEventWriter(output)

	p := tea.NewProgram(m,
		tea.WithInput(term),
		tea.WithOutput(term),
		tea.WithColorProfile(colorprofile.TrueColor),
		tea.WithoutSignalHandler(),
		tea.WithFilter(denyGraphemeWidthMode),
	)

	go readPatches(p, input)

	if _, err := p.Run(); err != nil {
		m.drainEvents(writerDone)
		return err
	}

	m.drainEvents(writerDone)
	return m.writeResult(output)
}

// denyGraphemeWidthMode swallows bubbletea's own reply to its startup
// DECRQM query for mode 2027 (grapheme clustering), pinning the renderer's
// cursor-motion width math to wcwidth for the life of the program.
//
// Left alone, bubbletea flips its internal width model to GraphemeWidth --
// and answers the terminal's own query by turning mode 2027 ON -- the
// moment the terminal reports the mode as recognized at all (set, reset, or
// permanently set; only "not recognized" leaves it alone), with no check
// that the terminal's OWN renderer actually agrees with GraphemeWidth's
// column math for whatever it just painted. Denying the report keeps both
// sides on the same (default, wcwidth) width table, so a real tmux that
// answers "recognized" for a glyph it renders differently can never
// desync the cursor-motion bookkeeping the way it could otherwise.
func denyGraphemeWidthMode(_ tea.Model, msg tea.Msg) tea.Msg {
	if report, ok := msg.(tea.ModeReportMsg); ok && report.Mode == ansi.ModeUnicodeCore {
		return nil
	}
	return msg
}

// eventBufferSize is how many event lines Update can enqueue ahead of the
// writer goroutine before a send blocks. It only needs to smooth over the
// ordinary case; a full buffer applies brief backpressure to the event loop
// rather than losing or reordering anything, since the writer keeps
// draining independently of how fast events arrive.
const eventBufferSize = 16

// readPatches decodes update/modal messages off input and forwards them
// into the running program via p.Send, which is safe to call from any
// goroutine -- the same bridge session.go uses for its own mid-flight model
// replacements. It returns once input closes, which happens when the
// parent ends the connection. Any other message kind (a result or event --
// Go->TS directions Run itself writes, never reads back) is ignored rather
// than treated as an error, so a wire that echoes its own output doesn't
// wedge the read loop.
func readPatches(p *tea.Program, input io.Reader) {
	br := bufio.NewReader(input)
	for {
		line, err := protocol.ReadLine(br)
		if err != nil {
			return
		}
		kind, raw, err := protocol.DecodePickLine(line)
		if err != nil {
			continue
		}
		switch kind {
		case "update":
			var u protocol.PickUpdate
			if json.Unmarshal(raw, &u) == nil {
				p.Send(UpdateMsg{Update: u})
			}
		case "modal":
			var pm protocol.PickModal
			if json.Unmarshal(raw, &pm) == nil {
				p.Send(ModalMsg{Modal: pm})
			}
		}
	}
}
