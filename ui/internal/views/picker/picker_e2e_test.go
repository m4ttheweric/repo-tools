package picker

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"rt-ui/internal/protocol"
	"rt-ui/internal/testutil"
)

// TestOverlayCloseLeavesNoResidueAfterAnotherOverlayOpens is the Fix-2
// golden. It drives the real rt-ui pick binary over a pty -- not just
// renderView's own logical string, which is a pure function of Model state
// and can never show a stale-frame artifact -- because the residue this
// pins is a property of the actual terminal renderer's frame-to-frame diff,
// not of what render() computes.
//
// It captures the base frame, opens the ctrl-k menu, dismisses it, opens a
// TS-driven modal taller than the list underneath it, dismisses that too,
// and asserts the final screen is byte-for-byte the pre-menu base frame.
// The taller modal is what actually reproduces the bug: the compositor's
// canvas grows to fit it (see lipgloss's Compositor.flatten, which unions
// every layer's bounds), so the frame that follows dismissal is genuinely
// shorter than the one before it -- and without a full-frame clear on that
// transition, the vacated rows kept showing the taller frame's own content:
// a second, stale copy of the breadcrumb/list/keybar printed below the
// live one.
func TestOverlayCloseLeavesNoResidueAfterAnotherOverlayOpens(t *testing.T) {
	rows := make([]protocol.PickRow, 12)
	for i := range rows {
		v := fmt.Sprintf("row%02d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v, Tone: "text"}}}
	}
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb: []string{"rt", "worktree"},
		Rows:       rows,
		Actions: []protocol.PickAction{
			{ID: "dispose", Label: "dispose", Key: "ctrl-x", Scope: "item"},
			{ID: "refresh", Label: "refresh", Key: "ctrl-r", Scope: "global"},
		},
	}
	reqLine, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}

	s := testutil.StartSession(t, []string{testutil.Binary(t), "pick"}, nil)
	s.Send(string(reqLine))
	s.WaitForPaint("row00")
	time.Sleep(150 * time.Millisecond) // let the first frame settle
	base := s.Screen()

	s.Type("\x0b") // ctrl-k opens the registry menu
	// "esc dismiss" is the overlay's own header text (modalHeaderLine), not
	// "dispose": that label also lives in the ordinary keybar (the action
	// carries a key), so it never leaves the screen and can't mark the menu
	// closing.
	s.WaitForPaint("esc dismiss")
	time.Sleep(80 * time.Millisecond)
	s.Type("\x1b") // esc dismisses it
	s.WaitForGone("esc dismiss")

	modalRows := make([]protocol.PickRow, 20)
	for i := range modalRows {
		v := fmt.Sprintf("opt%02d", i)
		modalRows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v}}}
	}
	modal := protocol.PickModal{T: "modal", Message: "Sort by", Rows: modalRows}
	modalLine, err := json.Marshal(modal)
	if err != nil {
		t.Fatal(err)
	}
	s.Send(string(modalLine))
	s.WaitForPaint("Sort by")
	time.Sleep(80 * time.Millisecond)
	s.Type("\x1b") // esc dismisses the TS modal
	s.WaitForGone("Sort by")
	time.Sleep(150 * time.Millisecond) // let the closing frame settle

	final := s.Screen()
	if final != base {
		t.Fatalf("final frame carries residue from the overlay cycle:\n--- base ---\n%s\n--- final ---\n%s", base, final)
	}
}
