package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func sessionFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestDecodeSessionLineKinds(t *testing.T) {
	cases := map[string]string{
		"session-open-board.json":  "open",
		"session-model-board.json": "model",
		"session-close.json":       "close",
	}
	for name, want := range cases {
		kind, raw, err := DecodeSessionLine(sessionFixture(t, name))
		if err != nil || kind != want || len(raw) == 0 {
			t.Fatalf("%s: kind=%q err=%v", name, kind, err)
		}
	}
	if _, _, err := DecodeSessionLine([]byte(`{"nope":1}`)); err == nil {
		t.Fatal("line without t accepted")
	}
}

func TestOpenAndModelDecodeToRawModel(t *testing.T) {
	var o Open
	if err := json.Unmarshal(sessionFixture(t, "session-open-board.json"), &o); err != nil || o.View != "board" || len(o.Model) == 0 {
		t.Fatalf("open: %+v err=%v", o, err)
	}
	var m ModelMsg
	if err := json.Unmarshal(sessionFixture(t, "session-model-board.json"), &m); err != nil || len(m.Model) == 0 {
		t.Fatalf("model: err=%v", err)
	}
}

func TestEncodersMatchFixtures(t *testing.T) {
	canon := func(b []byte) string {
		var v any
		if err := json.Unmarshal(b, &v); err != nil {
			t.Fatal(err)
		}
		out, _ := json.Marshal(v)
		return string(out)
	}
	if got := EncodeHello("0.1.0", []string{"board"}); canon(got) != canon(sessionFixture(t, "session-hello.json")) {
		t.Fatalf("hello: %s", got)
	}
	if got := EncodeIntent(Intent{Name: "stop", EntryID: "e1"}); canon(got) != canon(sessionFixture(t, "session-intent-stop.json")) {
		t.Fatalf("intent stop: %s", got)
	}
	open := true
	if got := EncodeIntent(Intent{Name: "tail", EntryID: "e1", Open: &open}); canon(got) != canon(sessionFixture(t, "session-intent-tail.json")) {
		t.Fatalf("intent tail: %s", got)
	}
	if got := EncodeClosed(Closed{Reason: "quit"}); canon(got) != canon(sessionFixture(t, "session-closed-quit.json")) {
		t.Fatalf("closed: %s", got)
	}
	for _, b := range [][]byte{EncodeHello("x", nil), EncodeIntent(Intent{Name: "add"}), EncodeClosed(Closed{Reason: "closed"})} {
		if b[len(b)-1] != '\n' {
			t.Fatalf("encoder output must end with a newline: %q", b)
		}
	}
}
