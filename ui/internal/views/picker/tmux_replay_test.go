package picker

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rt-ui/internal/protocol"
	"rt-ui/internal/testutil"
)

// TestRealTmuxWireModalOpenAndDismissLeavesNoResidueAboveFrame is the one
// gate in this suite that runs the real rt-ui binary inside a real, private
// tmux server and reads its rendering back via `tmux capture-pane`, instead
// of replaying a bare pty through the bundled x/vt terminal emulator the
// way every other e2e test in this package does. x/vt has never reproduced
// the overlay-residue symptom this investigation chased across several
// rounds; only a real tmux VT interpreter does, so this is the one test
// that can actually gate it.
//
// It wires the picker's stdio exactly the way production does
// (lib/ui/pick.ts's spawnPick: stdin and stdout both pipes, stdout read to
// completion by a drain goroutine, never left attached to a terminal) and
// drives a full wire-modal open-then-dismiss cycle, since dismissal is what
// writes a modal-result line down the protocol channel -- the one event in
// this cycle capable of interacting with the tty at all. It asserts the
// settled tmux grid shows the breadcrumb line exactly once and carries no
// box-drawing fragment on that line, the two symptoms every real corruption
// this investigation captured showed.
//
// Skipped, loudly and only, when no `tmux` binary exists on PATH -- never
// for any other reason, since a silent skip would hide a real regression on
// any machine that does have tmux.
func TestRealTmuxWireModalOpenAndDismissLeavesNoResidueAboveFrame(t *testing.T) {
	const cols, rows = 110, 34
	const breadcrumbLine = "rt › worktree › dispose"

	tmuxBin, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("REAL-TMUX REPLAY GATE SKIPPED: no `tmux` binary found on PATH. " +
			"This gate needs a real tmux VT interpreter -- the bare-pty (x/vt) " +
			"emulator every other e2e test in this package uses has never " +
			"reproduced the residue this pins. Install tmux to run this test; " +
			"a skip here is not a pass.")
	}

	sess := startRealTmuxPicker(t, tmuxBin, cols, rows)

	reqLine, modalLine := tmuxReproRequest()
	sess.send(t, reqLine)
	sess.waitFor(t, "bill")
	time.Sleep(300 * time.Millisecond) // let the base frame settle

	sess.send(t, modalLine)
	sess.waitFor(t, "esc dismiss")
	time.Sleep(300 * time.Millisecond) // let the open transition settle

	sess.pressEscape(t) // dismiss: writes a modal-result line down the protocol channel
	sess.waitGone(t, "esc dismiss")
	time.Sleep(300 * time.Millisecond) // let the close transition settle

	grid := sess.capture(t)

	if n := strings.Count(grid, breadcrumbLine); n != 1 {
		t.Fatalf("real tmux shows the breadcrumb line %d times (want exactly 1) -- an orphan stanza above the live frame:\n%s", n, grid)
	}
	for _, line := range strings.Split(grid, "\n") {
		if strings.Contains(line, breadcrumbLine) && strings.ContainsAny(line, "╭╮╰╯") {
			t.Fatalf("the breadcrumb row carries a box-drawing fragment from the modal (the anchor-slip symptom):\n%s", grid)
		}
	}
}

// TestRealTmuxCtrlSlashTogglesKeybarWithoutLatchingHeldBadge is the fallback-
// terminal gate the ctrl-/ latch fix lands behind. A real tmux pane speaks no
// Kitty keyboard protocol, so a bare modifier there reports a press but never a
// release: the buggy build inferred held from that lone press and stranded the
// "⌃ keys" physical-hold badge on forever. This drives the exact input -- a
// bare left-ctrl press (Kitty keycode 57442, which bubbletea decodes whether or
// not the handshake ever completed) followed by ctrl-/ -- and asserts the badge
// never appears while the ctrl-/ toggle still reaches the two-line grouped
// keybar. Only a real tmux VT delivers a press with no matching release; the
// bundled x/vt emulator the model tests use cannot.
func TestRealTmuxCtrlSlashTogglesKeybarWithoutLatchingHeldBadge(t *testing.T) {
	const cols, rows = 110, 20

	tmuxBin, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("REAL-TMUX REPLAY GATE SKIPPED: no `tmux` binary found on PATH. " +
			"This gate needs a real tmux VT interpreter to deliver a bare " +
			"modifier press with no matching release -- the bare-pty (x/vt) " +
			"emulator every other e2e test in this package uses cannot. " +
			"Install tmux to run this test; a skip here is not a pass.")
	}

	sess := startRealTmuxPicker(t, tmuxBin, cols, rows)

	sess.send(t, ctrlSlashReproRequest())
	sess.waitFor(t, "row0")
	time.Sleep(300 * time.Millisecond) // let the base frame settle

	if grid := sess.capture(t); strings.Contains(grid, "showing all keys") || strings.Contains(grid, "⌃ keys") {
		t.Fatalf("setup: neither the expanded keybar nor the held badge should show before any key:\n%s", grid)
	}

	// A bare left-ctrl press with no release. On the buggy build this latches
	// held.ctrl true; the fix leaves it clear because tmux never confirmed it
	// can deliver the release.
	sess.pressBareLeftCtrl(t)
	time.Sleep(300 * time.Millisecond)
	if grid := sess.capture(t); strings.Contains(grid, "⌃ keys") {
		t.Fatalf("a bare ctrl press must not latch the ⌃ keys badge in a fallback tmux (no key releases):\n%s", grid)
	}

	// ctrl-/ is a discrete keypress that toggles the two-line keybar. Neither
	// physical-hold indicator may appear: the "held: showing all keys" keybar
	// tag and the "⌃ keys" header badge both name a real ctrl hold, and nothing
	// is held here. (The toggle's rendered line1 is asserted deterministically at
	// the model level in TestExpandedKeybarHeldIndicatorGatesOnPhysicalHold; a
	// real tmux grid cannot distinguish one keybar line from two once the frame
	// height is pinned, so this gate owns the fallback badge-absence guarantee.)
	sess.pressCtrlSlash(t)
	time.Sleep(300 * time.Millisecond)

	grid := sess.capture(t)
	if strings.Contains(grid, "showing all keys") {
		t.Fatalf("the held indicator must not show on a ctrl-/ toggle in fallback (nothing held):\n%s", grid)
	}
	if strings.Contains(grid, "⌃ keys") {
		t.Fatalf("the ⌃ keys physical-hold badge must never latch on in a fallback tmux:\n%s", grid)
	}
}

// ctrlSlashReproRequest is a plain grouped-action row list wide enough to paint
// the two-line grouped keybar (and the "held: showing all keys" indicator) once
// ctrl-/ expands it, and the "⌃ keys" header badge if a hold ever engaged.
func ctrlSlashReproRequest() []byte {
	rows := make([]protocol.PickRow, 6)
	for i := range rows {
		v := fmt.Sprintf("row%d", i)
		rows[i] = protocol.PickRow{Value: v, Left: []protocol.PickSegment{{Text: v, Bold: true}}}
	}
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version, Rows: rows,
		Actions: []protocol.PickAction{
			{ID: "open", Label: "open", Key: "enter", Scope: "item", Group: "nav", Primary: true},
			{ID: "editor", Label: "open in editor", Key: "ctrl-o", Scope: "item", Group: "act"},
		},
	}
	line, _ := json.Marshal(req)
	return line
}

// tmuxReproRequest mirrors the request/modal shape a live 110x34 tmux drive
// actually reported the residue against: a three-segment breadcrumb, a
// grouped row list with a right-aligned tag, and a short wire-driven modal
// opened over it.
func tmuxReproRequest() (reqLine, modalLine []byte) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb: []string{"rt", "worktree", "dispose"},
		Rows: []protocol.PickRow{
			{
				Value: "bill", Group: "on-deck",
				Left:  []protocol.PickSegment{{Text: "bill", Bold: true}},
				Right: []protocol.PickSegment{{Text: "[Local Only]"}},
			},
			{
				Value: "cho", Group: "on-deck",
				Left:  []protocol.PickSegment{{Text: "cho", Bold: true}},
				Right: []protocol.PickSegment{{Text: "[Local Only]"}},
			},
		},
		Actions: []protocol.PickAction{
			{ID: "dispose", Label: "dispose", Key: "ctrl-x", Scope: "item"},
			{ID: "refresh", Label: "refresh", Key: "ctrl-r", Scope: "global"},
		},
	}
	modal := protocol.PickModal{
		T: "modal", Message: "Sort by",
		Rows: []protocol.PickRow{
			{Value: "name", Left: []protocol.PickSegment{{Text: "Name"}}},
			{Value: "size", Left: []protocol.PickSegment{{Text: "Size"}}},
		},
	}
	reqLine, _ = json.Marshal(req)
	modalLine, _ = json.Marshal(modal)
	return reqLine, modalLine
}

// realTmuxPickerSession runs the real rt-ui binary as a tmux pane's own
// command, wired the way production actually spawns it (lib/ui/pick.ts's
// spawnPick: stdin is a pipe fed request/modal lines, stdout is a pipe read
// to completion by a background drain, never left attached to the pane's
// own tty). A named pipe stands in for stdin's pipe; stdout is redirected
// to a plain file the pane's shell drains on its own, standing in for the
// parent process's read loop.
type realTmuxPickerSession struct {
	tmuxBin string
	sock    string
	fifo    *os.File
}

// startRealTmuxPicker builds the current rt-ui binary, creates a named pipe
// for its stdin, and starts it as a fresh private tmux server's one pane at
// cols x rows. The pipe is opened for writing once and kept open for the
// life of the session -- opening and closing it per message would deliver
// an EOF to rt-ui's stdin reader between messages, which ends its read loop
// permanently (by design: that's how a real caller signals "done"), so a
// second message after a first open-write-close would never be seen at
// all.
func startRealTmuxPicker(t *testing.T, tmuxBin string, cols, rows int) *realTmuxPickerSession {
	t.Helper()

	binPath := testutil.Binary(t)
	dir := t.TempDir()
	fifoPath := filepath.Join(dir, "req.fifo")
	if out, err := exec.Command("mkfifo", fifoPath).CombinedOutput(); err != nil {
		t.Fatalf("mkfifo: %v: %s", err, out)
	}
	stdoutPath := filepath.Join(dir, "stdout.jsonl")

	sock := tmuxSocketPath(t)
	t.Cleanup(func() {
		_ = exec.Command(tmuxBin, "-S", sock, "kill-server").Run()
		_ = os.Remove(sock)
	})

	shellCmd := fmt.Sprintf("'%s' pick < '%s' > '%s'", binPath, fifoPath, stdoutPath)
	newSession := exec.Command(tmuxBin, "-S", sock, "new-session", "-d",
		"-x", fmt.Sprintf("%d", cols), "-y", fmt.Sprintf("%d", rows), shellCmd)
	if out, err := newSession.CombinedOutput(); err != nil {
		t.Fatalf("tmux new-session: %v: %s", err, out)
	}

	// The pane's shell has already begun its own "< fifoPath" open-for-read
	// as part of starting the command above, so this open-for-write should
	// unblock almost immediately; a stuck open here (no reader ever
	// arrived) would otherwise hang the test forever, so it's raced against
	// a deadline instead of called bare.
	type openResult struct {
		f   *os.File
		err error
	}
	opened := make(chan openResult, 1)
	go func() {
		f, err := os.OpenFile(fifoPath, os.O_WRONLY, 0)
		opened <- openResult{f, err}
	}()
	var fifo *os.File
	select {
	case r := <-opened:
		if r.err != nil {
			t.Fatalf("open fifo for writing: %v", r.err)
		}
		fifo = r.f
	case <-time.After(5 * time.Second):
		t.Fatal("timed out opening the request fifo for writing -- the tmux pane never opened it for reading")
	}
	t.Cleanup(func() { _ = fifo.Close() })

	return &realTmuxPickerSession{tmuxBin: tmuxBin, sock: sock, fifo: fifo}
}

func (s *realTmuxPickerSession) send(t *testing.T, line []byte) {
	t.Helper()
	if _, err := s.fifo.Write(append(append([]byte{}, line...), '\n')); err != nil {
		t.Fatalf("write to request fifo: %v", err)
	}
}

// pressEscape sends a real ESC keystroke into the tmux pane's own input --
// the same path a person's keyboard takes -- as opposed to send, which
// writes down the separate stdin pipe carrying the wire protocol.
func (s *realTmuxPickerSession) pressEscape(t *testing.T) {
	t.Helper()
	if out, err := exec.Command(s.tmuxBin, "-S", s.sock, "send-keys", "Escape").CombinedOutput(); err != nil {
		t.Fatalf("tmux send-keys Escape: %v: %s", err, out)
	}
}

// pressBareLeftCtrl sends the Kitty keyboard protocol's own bare left-ctrl
// press sequence (CSI 57442 u) as literal bytes into the pane's input -- a
// press with no matching release, the input a real fallback tmux delivers when
// its outer terminal forwards Kitty presses but tmux never confirmed the
// protocol to this program. bubbletea decodes 57442 to KeyLeftCtrl regardless
// of whether the handshake completed.
func (s *realTmuxPickerSession) pressBareLeftCtrl(t *testing.T) {
	t.Helper()
	// ESC [ 5 7 4 4 2 u
	s.sendHex(t, "1b", "5b", "35", "37", "34", "34", "32", "75")
}

// pressCtrlSlash sends ctrl-/ (byte 0x1F) as a literal byte into the pane's
// input -- the discrete keypress that toggles the two-line grouped keybar,
// independent of any physical-hold state.
func (s *realTmuxPickerSession) pressCtrlSlash(t *testing.T) {
	t.Helper()
	s.sendHex(t, "1f")
}

// sendHex sends the given hex byte values into the pane's input literally
// (send-keys -H), the raw-byte counterpart to pressEscape's named-key send.
func (s *realTmuxPickerSession) sendHex(t *testing.T, hexBytes ...string) {
	t.Helper()
	args := append([]string{"-S", s.sock, "send-keys", "-H"}, hexBytes...)
	if out, err := exec.Command(s.tmuxBin, args...).CombinedOutput(); err != nil {
		t.Fatalf("tmux send-keys -H %v: %v: %s", hexBytes, err, out)
	}
}

func (s *realTmuxPickerSession) capture(t *testing.T) string {
	t.Helper()
	out, err := exec.Command(s.tmuxBin, "-S", s.sock, "capture-pane", "-p").Output()
	if err != nil {
		t.Fatalf("tmux capture-pane: %v", err)
	}
	return string(out)
}

func (s *realTmuxPickerSession) waitFor(t *testing.T, text string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		last = s.capture(t)
		if strings.Contains(last, text) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("tmux pane never painted %q:\n%s", text, last)
}

func (s *realTmuxPickerSession) waitGone(t *testing.T, text string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		last = s.capture(t)
		if !strings.Contains(last, text) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("tmux pane never cleared %q:\n%s", text, last)
}

// tmuxSocketPath allocates a short-enough path for tmux's own control
// socket. t.TempDir() alone regularly overflows AF_UNIX's ~104-byte path
// limit once this package's own (long) name and the test name are nested
// into it, which fails with an opaque "File name too long" from tmux
// itself rather than a clear one from this test -- os.CreateTemp against
// the system temp root keeps the path short and unique instead.
func tmuxSocketPath(t *testing.T) string {
	t.Helper()
	f, err := os.CreateTemp("", "rtui-tmux-*.sock")
	if err != nil {
		t.Fatalf("allocate tmux socket path: %v", err)
	}
	path := f.Name()
	_ = f.Close()
	_ = os.Remove(path) // tmux creates the socket itself; only the name is wanted
	return path
}
