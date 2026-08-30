// Package protocol is the rt-ui wire contract: one JSON object per line.
// Field names and shapes are frozen by ui/fixtures/*.json, which the TS side
// tests against too; change both or neither.
package protocol

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
)

const Version = 1

type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Hint  string `json:"hint,omitempty"`
}

type Back struct {
	Label string `json:"label"`
}

type Validate struct {
	Pattern string `json:"pattern"`
	Message string `json:"message"`
}

// PromptSpec is the union of the four kinds; unused fields stay zero and
// are omitted on re-encode so fixtures round-trip byte-for-byte.
type PromptSpec struct {
	T        string `json:"t"`
	Protocol int    `json:"protocol"`
	Kind     string `json:"kind"`
	Hint     string `json:"hint,omitempty"`

	// select, multiselect, text
	Title   string   `json:"title,omitempty"`
	Options []Option `json:"options,omitempty"`

	// select
	Initial string `json:"initial,omitempty"`
	Back    *Back  `json:"back,omitempty"`

	// multiselect
	InitialMany []string `json:"-"`
	Min         *int     `json:"min,omitempty"`
	Max         *int     `json:"max,omitempty"`

	// confirm
	Message     string `json:"message,omitempty"`
	Default     *bool  `json:"default,omitempty"`
	Destructive *bool  `json:"destructive,omitempty"`

	// text
	Placeholder string    `json:"placeholder,omitempty"`
	Validate    *Validate `json:"validate,omitempty"`
}

// initial is a string for select/text and a string array for multiselect;
// the custom (un)marshal keeps one struct while honoring both fixtures.
func (p *PromptSpec) UnmarshalJSON(b []byte) error {
	type alias PromptSpec
	var a alias
	var raw struct {
		Initial json.RawMessage `json:"initial"`
	}
	if err := json.Unmarshal(b, &a); err != nil {
		// a multiselect initial is an array, which the string field rejects
		var probe map[string]json.RawMessage
		if err2 := json.Unmarshal(b, &probe); err2 != nil {
			return err
		}
		delete(probe, "initial")
		stripped, _ := json.Marshal(probe)
		if err3 := json.Unmarshal(stripped, &a); err3 != nil {
			return err3
		}
	}
	if err := json.Unmarshal(b, &raw); err == nil && len(raw.Initial) > 0 && raw.Initial[0] == '[' {
		if err := json.Unmarshal(raw.Initial, &a.InitialMany); err != nil {
			return err
		}
		a.Initial = ""
	}
	*p = PromptSpec(a)
	return nil
}

func (p PromptSpec) MarshalJSON() ([]byte, error) {
	type alias PromptSpec
	m := map[string]any{}
	b, err := json.Marshal(alias(p))
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	if p.Kind == "multiselect" {
		delete(m, "initial")
		if len(p.InitialMany) > 0 {
			m["initial"] = p.InitialMany
		}
	}
	return json.Marshal(m)
}

var ErrBadSpec = errors.New("bad prompt spec")

func DecodePrompt(line []byte) (PromptSpec, error) {
	var s PromptSpec
	if err := json.Unmarshal(line, &s); err != nil {
		return s, fmt.Errorf("%w: %v", ErrBadSpec, err)
	}
	if s.T != "prompt" {
		return s, fmt.Errorf("%w: t=%q", ErrBadSpec, s.T)
	}
	if s.Protocol != Version {
		return s, fmt.Errorf("%w: protocol %d, rt-ui speaks %d", ErrBadSpec, s.Protocol, Version)
	}
	switch s.Kind {
	case "select", "multiselect", "confirm", "text":
		return s, nil
	}
	return s, fmt.Errorf("%w: kind %q", ErrBadSpec, s.Kind)
}

// Result is one of value/values/ok/text; exactly one is set.
type Result struct {
	Value  *string  `json:"value,omitempty"`
	Values []string `json:"values,omitempty"`
	OK     *bool    `json:"ok,omitempty"`
	Text   *string  `json:"text,omitempty"`
}

func EncodeResult(r Result) []byte {
	m := map[string]any{"t": "result"}
	switch {
	case r.Value != nil:
		m["value"] = *r.Value
	case r.Values != nil:
		m["values"] = r.Values
	case r.OK != nil:
		m["ok"] = *r.OK
	case r.Text != nil:
		m["text"] = *r.Text
	}
	b, _ := json.Marshal(m)
	return append(b, '\n')
}

type StepEvent struct {
	T        string `json:"t"`
	Protocol int    `json:"protocol,omitempty"`
	Title    string `json:"title,omitempty"`
	Hint     string `json:"hint,omitempty"`
	Level    string `json:"level,omitempty"`
	Text     string `json:"text,omitempty"`
}

func DecodeStep(line []byte) (StepEvent, error) {
	var e StepEvent
	if err := json.Unmarshal(line, &e); err != nil {
		return e, fmt.Errorf("%w: %v", ErrBadSpec, err)
	}
	switch e.T {
	case "hello", "start", "log", "done", "fail":
		return e, nil
	}
	return e, fmt.Errorf("%w: step t=%q", ErrBadSpec, e.T)
}

// ReadLine returns one line without its newline; io.EOF when the writer is gone.
func ReadLine(r *bufio.Reader) ([]byte, error) {
	line, err := r.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	return line[:len(line)-1], nil
}
