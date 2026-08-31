package board

import (
	"encoding/json"
	"fmt"
	"time"
)

type TailLine struct {
	TS   string `json:"ts"`
	Text string `json:"text"`
}

type Entry struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Command   string     `json:"command"`
	Pkg       string     `json:"pkg"`
	Repo      string     `json:"repo"`
	State     string     `json:"state"`
	StartedAt *string    `json:"startedAt"`
	ExitCode  *int       `json:"exitCode"`
	Error     *string    `json:"error"`
	Tail      []TailLine `json:"tail"`
}

type Model struct {
	Workspace string  `json:"workspace"`
	Entries   []Entry `json:"entries"`
}

func decode(raw json.RawMessage) (Model, error) {
	var m Model
	err := json.Unmarshal(raw, &m)
	return m, err
}

// uptime is derived here, never pushed: the parent pushes startedAt once and
// Go ticks the display itself so a slow poll can never make seconds skip.
func (e Entry) uptime(now time.Time) string {
	if e.State != "running" || e.StartedAt == nil {
		return ""
	}
	t, err := time.Parse(time.RFC3339Nano, *e.StartedAt)
	if err != nil {
		return ""
	}
	s := int(now.Sub(t).Seconds())
	if s < 0 {
		s = 0
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}
