package session

import (
	"encoding/json"

	tea "charm.land/bubbletea/v2"

	"rt-ui/internal/protocol"
)

// Echo paints its model's text and quits on q; it exists so the session
// loop can be tested without a real view.
type Echo struct {
	em     *Emitter
	text   string
	reason Reason
}

func NewEcho(em *Emitter) *Echo { return &Echo{em: em, reason: ReasonClosed} }

func (e *Echo) SetModel(raw json.RawMessage) error {
	var m struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return err
	}
	e.text = m.Text
	return nil
}

func (e *Echo) Reason() Reason { return e.reason }
func (e *Echo) Init() tea.Cmd  { return nil }

func (e *Echo) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch m := msg.(type) {
	case ModelUpdate:
		_ = e.SetModel(m.Raw)
	case CloseRequest:
		e.reason = ReasonClosed
		return e, tea.Quit
	case tea.KeyPressMsg:
		if m.String() == "q" {
			e.reason = ReasonQuit
			return e, tea.Sequence(e.em.Emit(protocol.Intent{Name: "quit"}), tea.Quit)
		}
	}
	return e, nil
}

func (e *Echo) View() tea.View {
	v := tea.NewView(e.text)
	v.AltScreen = true
	return v
}
