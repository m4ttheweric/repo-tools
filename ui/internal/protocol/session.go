package protocol

import (
	"encoding/json"
	"fmt"
)

// Session messages. The wire is one JSON object per line; the view's model
// travels as raw JSON so this package never learns a view's shape.

type Hello struct {
	T        string   `json:"t"`
	Protocol int      `json:"protocol"`
	Version  string   `json:"version"`
	Views    []string `json:"views"`
}

type Open struct {
	T     string          `json:"t"`
	View  string          `json:"view"`
	Model json.RawMessage `json:"model"`
}

type ModelMsg struct {
	T     string          `json:"t"`
	Model json.RawMessage `json:"model"`
}

type Intent struct {
	T       string `json:"t"`
	Name    string `json:"name"`
	EntryID string `json:"entryId,omitempty"`
	Open    *bool  `json:"open,omitempty"`
	Command string `json:"command,omitempty"`
}

type Closed struct {
	T       string `json:"t"`
	Reason  string `json:"reason"`
	Message string `json:"message,omitempty"`
}

// DecodeSessionLine returns the message kind (its "t") and the raw line for
// a second, typed decode by the caller.
func DecodeSessionLine(line []byte) (string, []byte, error) {
	var probe struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		return "", nil, fmt.Errorf("%w: %v", ErrBadSpec, err)
	}
	if probe.T == "" {
		return "", nil, fmt.Errorf("%w: session line without t", ErrBadSpec)
	}
	return probe.T, line, nil
}

func EncodeHello(version string, views []string) []byte {
	if views == nil {
		views = []string{}
	}
	b, _ := json.Marshal(Hello{T: "hello", Protocol: Version, Version: version, Views: views})
	return append(b, '\n')
}

func EncodeIntent(in Intent) []byte {
	in.T = "intent"
	b, _ := json.Marshal(in)
	return append(b, '\n')
}

func EncodeClosed(c Closed) []byte {
	c.T = "closed"
	b, _ := json.Marshal(c)
	return append(b, '\n')
}
