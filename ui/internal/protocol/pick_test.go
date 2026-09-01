package protocol

import (
	"encoding/json"
	"testing"
)

func TestDecodePickLineKinds(t *testing.T) {
	cases := map[string]string{
		"pick-request.json":      "pick",
		"pick-update.json":       "update",
		"pick-modal.json":        "modal",
		"pick-event.json":        "event",
		"pick-modal-result.json": "modal-result",
		"pick-result.json":       "result",
	}
	for name, want := range cases {
		kind, raw, err := DecodePickLine(fixture(t, name))
		if err != nil || kind != want || len(raw) == 0 {
			t.Fatalf("%s: kind=%q err=%v", name, kind, err)
		}
	}
	if _, _, err := DecodePickLine([]byte(`{"nope":1}`)); err == nil {
		t.Fatal("line without t accepted")
	}
}

func TestPickFixturesDecodeAndReencode(t *testing.T) {
	check := func(name string, v any) {
		t.Helper()
		raw := fixture(t, name)
		if err := json.Unmarshal(raw, v); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		back, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if canonical(t, back) != canonical(t, raw) {
			t.Fatalf("%s: re-encode drift\n got %s\nwant %s", name, back, raw)
		}
	}
	check("pick-request.json", &PickRequest{})
	check("pick-update.json", &PickUpdate{})
	check("pick-modal.json", &PickModal{})
	check("pick-event.json", &PickEvent{})
	check("pick-modal-result.json", &PickModalResult{})
	check("pick-result.json", &PickResult{})
}

func TestPickRequestFixtureFields(t *testing.T) {
	var r PickRequest
	if err := json.Unmarshal(fixture(t, "pick-request.json"), &r); err != nil {
		t.Fatal(err)
	}
	if r.T != "pick" || r.Protocol != Version {
		t.Fatalf("t=%q protocol=%d", r.T, r.Protocol)
	}
	if len(r.Rows) < 2 || len(r.Actions) == 0 {
		t.Fatalf("rows=%d actions=%d", len(r.Rows), len(r.Actions))
	}
	if !r.Multi || r.InitialQuery == "" {
		t.Fatalf("multi=%v initialQuery=%q", r.Multi, r.InitialQuery)
	}
}

func TestPickResultValueNullRoundTrips(t *testing.T) {
	raw := []byte(`{"t":"result","action":"cancel","value":null,"query":""}`)
	var r PickResult
	if err := json.Unmarshal(raw, &r); err != nil || r.Value != nil {
		t.Fatalf("value=%v err=%v", r.Value, err)
	}
	back, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if canonical(t, back) != canonical(t, raw) {
		t.Fatalf("null round-trip drift: got %s", back)
	}
}
