package picker

import (
	"bufio"
	"io"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/colorprofile"

	"rt-ui/internal/protocol"
	"rt-ui/internal/tty"
)

// modalState is Task 10's submenu overlay (opened by a PickModal message,
// closed with a PickModalResult); left empty until that task defines what
// it needs to render and dismiss.
type modalState struct{}

// heldModifiers is Task 12's cross-event modifier tracking (shift/alt held
// across mouse and key events, driving range-select); left empty until that
// task defines its fields.
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

	result *protocol.PickResult
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
	case tea.KeyPressMsg:
		switch msg.String() {
		case "down":
			m.moveCursor(1)
		case "up":
			m.moveCursor(-1)
		case "enter":
			m.selectCursor()
			return m, tea.Quit
		}
	}
	return m, nil
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

	p := tea.NewProgram(m,
		tea.WithInput(term),
		tea.WithOutput(term),
		tea.WithColorProfile(colorprofile.TrueColor),
		tea.WithoutSignalHandler(),
	)

	// Tasks 8/9 parse update/modal/event messages off input and forward them
	// into the program; for this scaffold, draining keeps a parent that
	// streams pick-update lines from blocking on a full pipe.
	go drain(input)

	if _, err := p.Run(); err != nil {
		return err
	}

	result := m.result
	if result == nil {
		result = &protocol.PickResult{Action: "cancel", Query: m.query}
	}
	_, err = output.Write(protocol.EncodePickResult(*result))
	return err
}

func drain(r io.Reader) {
	br := bufio.NewReader(r)
	for {
		if _, err := protocol.ReadLine(br); err != nil {
			return
		}
	}
}
