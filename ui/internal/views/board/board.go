// Package board is the runner view: a flat list of headless commands with a
// tail peek and a quit-confirm layer. Everything here is UI state; the
// entries themselves arrive from the parent and are replaced wholesale.
package board

import (
	"encoding/json"
	"time"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"

	"rt-ui/internal/protocol"
	"rt-ui/internal/session"
	"rt-ui/internal/theme"
)

type tickMsg time.Time

type Board struct {
	em       *session.Emitter
	model    Model
	selected string
	tailOpen bool
	confirm  bool
	width    int
	height   int
	spin     spinner.Model
	now      time.Time
	reason   session.Reason
}

func New(em *session.Emitter) *Board {
	return &Board{
		em:     em,
		spin:   spinner.New(spinner.WithSpinner(spinner.Spinner{Frames: theme.SpinnerFrames, FPS: 80 * time.Millisecond})),
		now:    time.Now(),
		reason: session.ReasonClosed,
	}
}

func (b *Board) SetModel(raw json.RawMessage) error {
	m, err := decode(raw)
	if err != nil {
		return err
	}
	b.model = m
	b.clampSelection()
	return nil
}

func (b *Board) Reason() session.Reason { return b.reason }

func tick() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (b *Board) Init() tea.Cmd {
	return tea.Batch(tick(), b.spinCmd())
}

func (b *Board) spinCmd() tea.Cmd {
	if b.anyTransitional() {
		return b.spin.Tick
	}
	return nil
}

func (b *Board) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch m := msg.(type) {
	case tea.WindowSizeMsg:
		b.width, b.height = m.Width, m.Height
	case tickMsg:
		b.now = time.Time(m)
		return b, tick()
	case spinner.TickMsg:
		if !b.anyTransitional() {
			return b, nil
		}
		var cmd tea.Cmd
		b.spin, cmd = b.spin.Update(m)
		return b, cmd
	case session.ModelUpdate:
		prev := b.selected
		wasTransitional := b.anyTransitional()
		if err := b.SetModel(m.Raw); err != nil {
			return b, nil
		}
		var cmds []tea.Cmd
		if b.tailOpen && b.selected != prev {
			cmds = append(cmds, b.tailIntent(true))
		}
		if !wasTransitional && b.anyTransitional() {
			cmds = append(cmds, b.spin.Tick)
		}
		return b, tea.Batch(cmds...)
	case session.CloseRequest:
		b.reason = session.ReasonClosed
		return b, tea.Quit
	case tea.KeyPressMsg:
		return b.key(m.String())
	}
	return b, nil
}

func (b *Board) key(k string) (tea.Model, tea.Cmd) {
	if b.confirm {
		switch k {
		case "y":
			return b.quit()
		case "n", "esc":
			b.confirm = false
		}
		return b, nil
	}
	switch k {
	case "j", "down":
		b.move(1)
		if b.tailOpen {
			return b, b.tailIntent(true)
		}
	case "k", "up":
		b.move(-1)
		if b.tailOpen {
			return b, b.tailIntent(true)
		}
	case "t":
		if b.selected == "" {
			return b, nil
		}
		b.tailOpen = !b.tailOpen
		return b, b.tailIntent(b.tailOpen)
	case "a":
		return b, b.em.Emit(protocol.Intent{Name: "add"})
	case "s", "x", "f":
		if b.selected == "" {
			return b, nil
		}
		name := map[string]string{"s": "restart", "x": "stop", "f": "focus"}[k]
		return b, b.em.Emit(protocol.Intent{Name: name, EntryID: b.selected})
	case "o":
		e := b.selectedEntry()
		if e == nil || e.Url == nil || *e.Url == "" {
			return b, nil
		}
		return b, b.em.Emit(protocol.Intent{Name: "open", EntryID: b.selected})
	case "q", "ctrl+c":
		if b.count("running")+b.count("starting") > 0 {
			b.confirm = true
			return b, nil
		}
		return b.quit()
	}
	return b, nil
}

func (b *Board) quit() (tea.Model, tea.Cmd) {
	b.reason = session.ReasonQuit
	return b, tea.Sequence(b.em.Emit(protocol.Intent{Name: "quit"}), tea.Quit)
}

func (b *Board) tailIntent(open bool) tea.Cmd {
	o := open
	return b.em.Emit(protocol.Intent{Name: "tail", EntryID: b.selected, Open: &o})
}

func (b *Board) index() int {
	for i, e := range b.model.Entries {
		if e.ID == b.selected {
			return i
		}
	}
	return -1
}

func (b *Board) move(delta int) {
	n := len(b.model.Entries)
	if n == 0 {
		return
	}
	i := b.index() + delta
	if i < 0 {
		i = 0
	}
	if i >= n {
		i = n - 1
	}
	b.selected = b.model.Entries[i].ID
}

// The cursor follows an entry id, not a row: a model that reorders or
// removes rows can never leave it pointing at the wrong command.
func (b *Board) clampSelection() {
	if len(b.model.Entries) == 0 {
		b.selected = ""
		b.tailOpen = false
		return
	}
	if b.index() < 0 {
		b.selected = b.model.Entries[0].ID
	}
}

func (b *Board) selectedEntry() *Entry {
	if i := b.index(); i >= 0 {
		return &b.model.Entries[i]
	}
	return nil
}

func (b *Board) count(state string) int {
	n := 0
	for _, e := range b.model.Entries {
		if e.State == state {
			n++
		}
	}
	return n
}

func (b *Board) anyTransitional() bool {
	return b.count("starting")+b.count("stopping") > 0
}

func (b *Board) View() tea.View {
	v := tea.NewView(render(b))
	v.AltScreen = true
	return v
}
