package picker

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rt-ui/internal/testutil"
)

// TestFullCliPickerHoldsFootprintAndErasesOnQuit drives the WHOLE rt CLI --
// the TypeScript dispatcher included, not rt-ui directly the way every other
// e2e test in this package does -- inside a real, private tmux, and reads the
// rendering back with `tmux capture-pane`. Both layers that clear the screen
// then run together (the dispatcher's own ESC[2J and the picker's inline frame
// erase), so a footprint or residue symptom is attributable to the right one
// -- the exact picker-vs-dispatcher confusion the F2 diagnosis had to untangle
// by hand.
//
// It runs `rt worktree`, whose omitted subcommand takes the dispatcher's
// structural subcommand picker: a static, side-effect-free list (no daemon, no
// repo work -- esc just cancels the tree walk). It filters the list so the
// body shrinks, then quits, and asserts the two picker-owned properties the F2
// fix restores:
//
//  1. the keybar sits on the SAME pane row before and after the filter shrinks
//     the match set -- the reserved-height filler is interior now, so the
//     on-screen footprint holds instead of riding up with the match count; and
//  2. after quit the whole card is gone -- quit()'s in-loop tea.ClearScreen
//     erases the frame region, where the pre-fix shutdown flush left it for the
//     next chained stage to stack under.
//
// It deliberately does NOT assert that content seeded above the frame survives:
// the dispatcher's own clearScreen destroys it (command-tree.ts), which is out
// of this fix's scope. The seed is there only for realism.
//
// The CLI runs from source via `bun run cli.ts` under an isolated HOME, with
// RT_UI_BIN pinned to the freshly built rt-ui so the dispatcher paints THIS
// tree's picker rather than a stale installed helper. Skipped, loudly and only,
// when tmux or bun is missing or the source cli.ts is not found -- never for any
// other reason, since a silent skip would hide a real regression.
func TestFullCliPickerHoldsFootprintAndErasesOnQuit(t *testing.T) {
	const cols, rows = 110, 34

	tmuxBin, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("FULL-CLI GATE SKIPPED: no `tmux` on PATH. This gate needs a real tmux VT " +
			"to read the picker's own rendering back; a skip here is not a pass.")
	}
	bunBin, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("FULL-CLI GATE SKIPPED: no `bun` on PATH. This gate drives the TypeScript " +
			"dispatcher from source so the layer attribution is real; a skip here is not a pass.")
	}
	cliTs := findCliTs()
	if cliTs == "" {
		t.Skip("FULL-CLI GATE SKIPPED: cli.ts not found above the test directory (not a " +
			"source checkout); a skip here is not a pass.")
	}

	rtui := testutil.Binary(t)
	home := t.TempDir()

	sock := tmuxSocketPath(t)
	t.Cleanup(func() {
		_ = exec.Command(tmuxBin, "-S", sock, "kill-server").Run()
		_ = os.Remove(sock)
	})

	// Seed three lines above the frame (realism only -- not asserted, the
	// dispatcher clears them), then run the CLI, then hold the pane with sleep so
	// the settled post-quit screen can still be captured after the CLI exits.
	shellCmd := fmt.Sprintf(
		"printf 'SEED-L1\\nSEED-L2\\nSEED-L3\\n' > /dev/tty; HOME=%q RT_UI_BIN=%q %q run %q worktree; sleep 300",
		home, rtui, bunBin, cliTs,
	)
	newSession := exec.Command(tmuxBin, "-S", sock, "new-session", "-d",
		"-x", fmt.Sprintf("%d", cols), "-y", fmt.Sprintf("%d", rows), shellCmd)
	if out, err := newSession.CombinedOutput(); err != nil {
		t.Fatalf("tmux new-session: %v: %s", err, out)
	}

	s := &realTmuxPickerSession{tmuxBin: tmuxBin, sock: sock}

	s.waitForWithin(t, "provision", 25*time.Second) // bun cold start + dispatch + first paint
	openGrid := s.capture(t)
	openKeybar := lineWith(openGrid, "select")
	if openKeybar < 0 {
		t.Fatalf("the open frame has no keybar row (looked for \"select\"):\n%s", openGrid)
	}

	s.typeKeys(t, "dispose") // filter: the body shrinks from nine rows to two
	s.waitGone(t, "provision")
	filterGrid := s.capture(t)
	filterKeybar := lineWith(filterGrid, "select")
	if filterKeybar < 0 {
		t.Fatalf("the filtered frame has no keybar row:\n%s", filterGrid)
	}

	// The crux: the model tests stayed green on this bug because renderView's
	// string height never moved; only a real terminal, which strips a trailing
	// pad, showed the keybar ride. Interior filler is what holds it steady.
	if filterKeybar != openKeybar {
		t.Fatalf("the keybar rode from pane row %d to %d as the list shrank -- the footprint is not "+
			"holding its reserved height:\n--- open ---\n%s\n--- filtered ---\n%s",
			openKeybar, filterKeybar, openGrid, filterGrid)
	}

	s.pressEscape(t)
	s.waitGone(t, "worktree")
	quitGrid := s.capture(t)
	for _, marker := range []string{"worktree", "provision", "dispose", "select"} {
		if strings.Contains(quitGrid, marker) {
			t.Fatalf("after quit the frame left residue (%q still on screen) -- the card was not "+
				"erased, so the next chained stage would stack under it:\n%s", marker, quitGrid)
		}
	}
}

// findCliTs walks up from the test's working directory to the source checkout's
// cli.ts, returning "" when there is none (a build that is not run from a
// checkout), which the gate treats as a loud skip.
func findCliTs() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		cand := filepath.Join(dir, "cli.ts")
		if _, err := os.Stat(cand); err == nil {
			return cand
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// lineWith returns the 0-based index of the first captured line containing sub,
// or -1. The two callers compare the index across a filter, so only its
// consistency between captures matters, not the absolute row.
func lineWith(grid, sub string) int {
	for i, line := range strings.Split(grid, "\n") {
		if strings.Contains(line, sub) {
			return i
		}
	}
	return -1
}

// typeKeys sends literal characters into the pane's own input (-l, so a
// multi-character query is not mistaken for a key name), the same path a
// person's keyboard takes -- distinct from send, which writes the wire protocol
// down a separate pipe.
func (s *realTmuxPickerSession) typeKeys(t *testing.T, text string) {
	t.Helper()
	if out, err := exec.Command(s.tmuxBin, "-S", s.sock, "send-keys", "-l", text).CombinedOutput(); err != nil {
		t.Fatalf("tmux send-keys -l %q: %v: %s", text, err, out)
	}
}

// waitForWithin is waitFor with a caller-chosen deadline, for the CLI's own
// cold start (bun boot + dispatch) which outlasts waitFor's fixed window.
func (s *realTmuxPickerSession) waitForWithin(t *testing.T, text string, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	var last string
	for time.Now().Before(deadline) {
		last = s.capture(t)
		if strings.Contains(last, text) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("tmux pane never painted %q within %s:\n%s", text, within, last)
}
