package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDecodePickLineKinds(t *testing.T) {
	cases := map[string]string{
		"pick-request.json":      "pick",
		"pick-update.json":       "update",
		"pick-update-nav.json":   "update",
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
	check("pick-update-nav.json", &PickUpdate{})
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
	if !r.CrumbEvents {
		t.Fatalf("crumbEvents=%v, want true", r.CrumbEvents)
	}
	if !r.AcceptNoMatch {
		t.Fatalf("acceptNoMatch=%v, want true", r.AcceptNoMatch)
	}
	var dispose, refresh *PickAction
	for i := range r.Actions {
		switch r.Actions[i].ID {
		case "dispose":
			dispose = &r.Actions[i]
		case "refresh":
			refresh = &r.Actions[i]
		}
	}
	if dispose == nil || !dispose.Event {
		t.Fatalf("dispose action should carry event:true: %+v", dispose)
	}
	if refresh == nil || refresh.Event {
		t.Fatalf("refresh action should omit event (false): %+v", refresh)
	}
}

// TestPickRowWithArgsFixtureFields pins the Go/TS parity fixture for
// PickRow.WithArgs: one row claims it, the other omits it (defaulting to
// false), so a schema drift between the two languages' decoders shows up as
// a fixture assertion failure here rather than a silent divergence.
func TestPickRowWithArgsFixtureFields(t *testing.T) {
	var r PickRequest
	if err := json.Unmarshal(fixture(t, "pick-request.json"), &r); err != nil {
		t.Fatal(err)
	}
	var bill, cho *PickRow
	for i := range r.Rows {
		switch {
		case strings.HasSuffix(r.Rows[i].Value, "/bill"):
			bill = &r.Rows[i]
		case strings.HasSuffix(r.Rows[i].Value, "/cho"):
			cho = &r.Rows[i]
		}
	}
	if bill == nil || !bill.WithArgs {
		t.Fatalf("bill row should carry withArgs:true: %+v", bill)
	}
	if cho == nil || cho.WithArgs {
		t.Fatalf("cho row should default withArgs to false (omitted on the wire): %+v", cho)
	}
	if strings.Contains(string(fixture(t, "pick-request.json")), `"withArgs":false`) {
		t.Fatal("withArgs must never be written false on the wire (omitempty)")
	}
}

func TestPickUpdateFixtureActionsCarryEventFlag(t *testing.T) {
	var u PickUpdate
	if err := json.Unmarshal(fixture(t, "pick-update.json"), &u); err != nil {
		t.Fatal(err)
	}
	var cd, refresh *PickAction
	for i := range u.Actions {
		switch u.Actions[i].ID {
		case "cd":
			cd = &u.Actions[i]
		case "refresh":
			refresh = &u.Actions[i]
		}
	}
	if cd == nil || cd.Event {
		t.Fatalf("cd action should omit event (false): %+v", cd)
	}
	if refresh == nil || !refresh.Event {
		t.Fatalf("refresh action should carry event:true: %+v", refresh)
	}
	if len(u.Breadcrumb) == 0 {
		t.Fatalf("breadcrumb missing: %+v", u.Breadcrumb)
	}
	if !u.ResetQuery {
		t.Fatalf("resetQuery=%v, want true", u.ResetQuery)
	}
}

// TestPickUpdateNavHeaderFields pins the Go/TS parity fixture for the nav
// header rulings: an update carries the faint idle count ("N folders · M
// files") and the faint sort suffix, while the non-nav cd update omits both
// (they must never reach the wire empty -- omitempty) so those goldens stay
// byte-identical.
func TestPickUpdateNavHeaderFields(t *testing.T) {
	var nav PickUpdate
	if err := json.Unmarshal(fixture(t, "pick-update-nav.json"), &nav); err != nil {
		t.Fatal(err)
	}
	if nav.IdleCount != "10 folders · 2 files" {
		t.Fatalf("idleCount = %q", nav.IdleCount)
	}
	if nav.CrumbSuffix != " (Size, largest first)" {
		t.Fatalf("crumbSuffix = %q", nav.CrumbSuffix)
	}

	var cd PickUpdate
	if err := json.Unmarshal(fixture(t, "pick-update.json"), &cd); err != nil {
		t.Fatal(err)
	}
	if cd.IdleCount != "" || cd.CrumbSuffix != "" {
		t.Fatalf("the cd update must omit the nav header fields: idle=%q suffix=%q", cd.IdleCount, cd.CrumbSuffix)
	}

	back, err := json.Marshal(PickUpdate{T: "update"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(back), "idleCount") || strings.Contains(string(back), "crumbSuffix") {
		t.Fatalf("empty nav header fields must be omitted from the wire: %s", back)
	}
}

// TestPickActionEventOmitEmptyRoundTrips pins the false/absent case
// directly, since the fixture round-trip above only proves the true case:
// a false Event must never appear on the wire, or a parent parsing the line
// itself (not through this package) could mistake its mere presence for a
// signal.
func TestPickActionEventOmitEmptyRoundTrips(t *testing.T) {
	a := PickAction{ID: "x", Label: "x", Scope: "item"}
	b, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "event") {
		t.Fatalf("event must be omitted when false: %s", b)
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
