package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func canonical(t *testing.T, b []byte) string {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(v)
	return string(out)
}

func TestPromptFixturesDecodeAndReencode(t *testing.T) {
	for _, name := range []string{"prompt-select.json", "prompt-multiselect.json", "prompt-confirm.json", "prompt-text.json"} {
		raw := fixture(t, name)
		spec, err := DecodePrompt(raw)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if spec.Protocol != Version {
			t.Fatalf("%s: protocol %d", name, spec.Protocol)
		}
		back, err := json.Marshal(spec)
		if err != nil {
			t.Fatal(err)
		}
		if canonical(t, back) != canonical(t, raw) {
			t.Fatalf("%s: re-encode drift\n got %s\nwant %s", name, back, raw)
		}
	}
}

func TestDecodePromptRejectsWrongProtocolAndKind(t *testing.T) {
	if _, err := DecodePrompt([]byte(`{"t":"prompt","protocol":2,"kind":"select","title":"x","options":[]}`)); err == nil {
		t.Fatal("protocol 2 accepted")
	}
	if _, err := DecodePrompt([]byte(`{"t":"prompt","protocol":1,"kind":"slider"}`)); err == nil {
		t.Fatal("unknown kind accepted")
	}
	if _, err := DecodePrompt([]byte(`{"t":"nope"}`)); err == nil {
		t.Fatal("wrong t accepted")
	}
}

func TestResultFixturesMatchEncodeResult(t *testing.T) {
	cases := map[string]Result{
		"result-select.json":      {Value: strPtr("1h")},
		"result-multiselect.json": {Values: []string{"pre-commit", "pre-push"}},
		"result-confirm.json":     {OK: boolPtr(true)},
		"result-text.json":        {Text: strPtr("linear-tools")},
	}
	for name, r := range cases {
		got := EncodeResult(r)
		if !bytes.HasSuffix(got, []byte("\n")) {
			t.Fatalf("%s: no trailing newline", name)
		}
		if canonical(t, got) != canonical(t, fixture(t, name)) {
			t.Fatalf("%s: got %s", name, got)
		}
	}
}

func TestStepsFixtureDecodes(t *testing.T) {
	var lines []json.RawMessage
	if err := json.Unmarshal(fixture(t, "steps-stream.json"), &lines); err != nil {
		t.Fatal(err)
	}
	want := []string{"hello", "start", "log", "done"}
	for i, raw := range lines {
		ev, err := DecodeStep(raw)
		if err != nil {
			t.Fatal(err)
		}
		if ev.T != want[i] {
			t.Fatalf("line %d: t=%q want %q", i, ev.T, want[i])
		}
	}
}

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }
