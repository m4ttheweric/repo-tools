package protocol

import (
	"encoding/json"
	"fmt"
)

// Pick messages. TS drives the picker's content (pick opens it, update
// pushes enriched rows, modal opens a submenu); Go reports what the user did
// (event mid-session, modal-result, result on close). Only PickRequest opens
// a fresh stream, so only it carries protocol -- the rest ride an already
// negotiated connection, same as session's Open/Model vs Hello.

type PickSegment struct {
	Text string `json:"text"`
	Tone string `json:"tone,omitempty"`
	Hex  string `json:"hex,omitempty"`
	Bold bool   `json:"bold,omitempty"`
}

type PickRow struct {
	Value string        `json:"value"`
	Left  []PickSegment `json:"left"`
	Right []PickSegment `json:"right,omitempty"`
	Match string        `json:"match,omitempty"`
	Group string        `json:"group,omitempty"`
}

type PickAction struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Key     string `json:"key,omitempty"`
	Scope   string `json:"scope"`
	Group   string `json:"group,omitempty"`
	Primary bool   `json:"primary,omitempty"`
}

type PickRequest struct {
	T             string       `json:"t"`
	Protocol      int          `json:"protocol"`
	Message       string       `json:"message"`
	Breadcrumb    []string     `json:"breadcrumb,omitempty"`
	Rows          []PickRow    `json:"rows"`
	Actions       []PickAction `json:"actions,omitempty"`
	Multi         bool         `json:"multi,omitempty"`
	InitialValues []string     `json:"initialValues,omitempty"`
	InitialQuery  string       `json:"initialQuery,omitempty"`
	ResumeValue   string       `json:"resumeValue,omitempty"`
	Exact         bool         `json:"exact,omitempty"`
	Cap           int          `json:"cap,omitempty"`
	SelectedPanel bool         `json:"selectedPanel,omitempty"`
}

type PickUpdate struct {
	T       string       `json:"t"`
	Rows    []PickRow    `json:"rows,omitempty"`
	Message string       `json:"message,omitempty"`
	Actions []PickAction `json:"actions,omitempty"`
}

type PickModal struct {
	T       string    `json:"t"`
	Message string    `json:"message"`
	Rows    []PickRow `json:"rows"`
}

// Value is *string, not string: the TS side's "string | null" is a required
// field that can carry null (no selection, or a dismiss), so it must stay on
// the wire unconditionally -- never omitempty -- while still telling null
// apart from "".

type PickEvent struct {
	T      string  `json:"t"`
	Action string  `json:"action"`
	Value  *string `json:"value"`
	Query  string  `json:"query"`
}

type PickModalResult struct {
	T     string  `json:"t"`
	Value *string `json:"value"`
}

type PickResult struct {
	T      string   `json:"t"`
	Action string   `json:"action"`
	Value  *string  `json:"value"`
	Values []string `json:"values,omitempty"`
	Query  string   `json:"query"`
}

// DecodePickLine returns the message kind (its "t") and the raw line for a
// second, typed decode by the caller -- mirrors DecodeSessionLine, not the
// single-union DecodePrompt: pick has six message shapes, not one.
func DecodePickLine(line []byte) (string, []byte, error) {
	var probe struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		return "", nil, fmt.Errorf("%w: %v", ErrBadSpec, err)
	}
	if probe.T == "" {
		return "", nil, fmt.Errorf("%w: pick line without t", ErrBadSpec)
	}
	return probe.T, line, nil
}

// EncodePickResult mirrors EncodeIntent/EncodeClosed: T is stamped here, not
// by the caller, so a Model can build a PickResult without knowing the wire
// discriminator.
func EncodePickResult(r PickResult) []byte {
	r.T = "result"
	b, _ := json.Marshal(r)
	return append(b, '\n')
}
