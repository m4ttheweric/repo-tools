package picker

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"sync"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/colorprofile"

	"rt-ui/internal/protocol"
	"rt-ui/internal/tty"
)

// modalState is the picker's submenu overlay, opened by a PickModal message
// and closed with a PickModalResult; left empty until that behavior is
// built, so the field exists without shaping what it will hold.
type modalState struct{}

// heldModifiers is cross-event modifier tracking (shift/alt held across
// mouse and key events, driving range-select); left empty until that
// behavior is built, so the field exists without shaping what it will hold.
type heldModifiers struct{}

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

// New builds a Model from an opening request and ranks it against
// InitialQuery immediately, so a request that opens pre-filtered renders
// its real matches on the first frame rather than the identity order.
func New(req protocol.PickRequest) *Model {
	m := &Model{
		req:      req,
		query:    req.InitialQuery,
		selected: make(map[string]bool),
		hover:    -1,
	}
	m.refilter()
	return m
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
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	case UpdateMsg:
		m.applyUpdate(msg.Update)
	case tea.KeyPressMsg:
		key := msg.String()
		switch key {
		case "down":
			m.moveCursor(1)
			return m, nil
		case "up":
			m.moveCursor(-1)
			return m, nil
		}
		if action, ok := m.actionForKey(key); ok {
			if action.Event {
				m.emitEvent(action.ID)
				return m, nil
			}
			m.resultForAction(action.ID)
			return m, tea.Quit
		}
		if key == "enter" {
			m.selectCursor()
			return m, tea.Quit
		}
	}
	return m, nil
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
func (m *Model) resultForAction(actionID string) {
	var value *string
	if v, ok := m.cursorRowValue(); ok {
		value = &v
	}
	m.result = &protocol.PickResult{Action: actionID, Value: value, Query: m.query}
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
	if m.events == nil {
		return
	}
	var value *string
	if v, ok := m.cursorRowValue(); ok {
		value = &v
	}
	ev := protocol.PickEvent{Action: actionID, Value: value, Query: m.query}
	m.events <- protocol.EncodePickEvent(ev)
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
	pane := m.height
	bounded := pane > 0
	if !bounded {
		pane = len(m.matches) + chromeRows
	}
	top, h = Viewport(m.cursor, m.viewportTop, len(m.matches), m.req.Cap, pane, chromeRows)
	if bounded {
		top, h = m.fitHeaderBudget(h, pane-chromeRows)
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
// cursor leave but Update's enter case can still reach directly.
func (m *Model) selectCursor() {
	if m.cursor < 0 || m.cursor >= len(m.matches) {
		return
	}
	value := m.req.Rows[m.matches[m.cursor].Index].Value
	m.result = &protocol.PickResult{Action: "select", Value: &value, Query: m.query}
}

func (m *Model) View() tea.View {
	v := tea.NewView(render(m))
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

	m := New(req)
	m.output = output
	m.events = make(chan []byte, eventBufferSize)
	writerDone := m.startEventWriter(output)

	p := tea.NewProgram(m,
		tea.WithInput(term),
		tea.WithOutput(term),
		tea.WithColorProfile(colorprofile.TrueColor),
		tea.WithoutSignalHandler(),
	)

	// The modal overlay itself is not built yet; readPatches already sees
	// "modal" lines on the wire and drops them rather than forwarding an
	// undefined shape into the program.
	go readPatches(p, input)

	if _, err := p.Run(); err != nil {
		m.drainEvents(writerDone)
		return err
	}

	m.drainEvents(writerDone)
	return m.writeResult(output)
}

// eventBufferSize is how many event lines Update can enqueue ahead of the
// writer goroutine before a send blocks. It only needs to smooth over the
// ordinary case; a full buffer applies brief backpressure to the event loop
// rather than losing or reordering anything, since the writer keeps
// draining independently of how fast events arrive.
const eventBufferSize = 16

// readPatches decodes update messages off input and forwards them into the
// running program via p.Send, which is safe to call from any goroutine --
// the same bridge session.go uses for its own mid-flight model
// replacements. It returns once input closes, which happens when the
// parent ends the connection.
func readPatches(p *tea.Program, input io.Reader) {
	br := bufio.NewReader(input)
	for {
		line, err := protocol.ReadLine(br)
		if err != nil {
			return
		}
		kind, raw, err := protocol.DecodePickLine(line)
		if err != nil || kind != "update" {
			continue
		}
		var u protocol.PickUpdate
		if json.Unmarshal(raw, &u) == nil {
			p.Send(UpdateMsg{Update: u})
		}
	}
}
