package picker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/vt"
	"github.com/creack/pty"

	"rt-ui/internal/protocol"
	"rt-ui/internal/testutil"
)

// TestOverlayCloseLeavesNoResidueAfterAnotherOverlayOpens drives the real
// rt-ui pick binary over a pty -- not just renderView's own logical string,
// which is a pure function of Model state and can never show a stale-frame
// artifact -- because the residue this pins is a property of the actual
// terminal renderer's frame-to-frame diff, not of what render() computes.
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

// widePtySession is testutil.Session's own pty/stdin/stdout wiring, but at a
// caller-chosen terminal size instead of the fixed 100x30 testutil.Session
// always starts at -- needed here to reproduce the header-overflow bug at
// the width it was actually reported at.
type widePtySession struct {
	t      *testing.T
	stdin  io.WriteCloser
	ptmx   *os.File
	mu     sync.Mutex
	ttyBuf bytes.Buffer
	cols   int
	rows   int
}

// startWidePtySession starts argv on a pty of the given size, optionally
// preceded by priorLines lines of fake shell-prompt text written directly
// to the pty (not through argv's own stdout, which carries the picker's
// wire protocol, not its visual output) -- so the picker's own frame does
// NOT start at absolute row 0, the same way it wouldn't in a real terminal
// pane with something already on screen above it. 0 means no prior content
// -- the picker is the first thing the pty ever sees, matching a fresh
// session.
func startWidePtySession(t *testing.T, argv []string, cols, rows, priorLines int) *widePtySession {
	t.Helper()
	ptmx, pts, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	if err := pty.Setsize(ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}); err != nil {
		t.Fatal(err)
	}

	var shCmd strings.Builder
	for i := 0; i < priorLines; i++ {
		fmt.Fprintf(&shCmd, "printf 'prompt line %%d\\n' %d > /dev/tty; ", i)
	}
	shCmd.WriteString("exec ")
	for i, a := range argv {
		if i > 0 {
			shCmd.WriteString(" ")
		}
		shCmd.WriteString(a)
	}
	cmd := exec.Command("sh", "-c", shCmd.String())
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	cmd.ExtraFiles = []*os.File{pts}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 3}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pts.Close()

	s := &widePtySession{t: t, stdin: stdin, ptmx: ptmx, cols: cols, rows: rows}
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				s.mu.Lock()
				s.ttyBuf.Write(buf[:n])
				s.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		ptmx.Close()
	})
	return s
}

func (s *widePtySession) Send(line string) {
	if _, err := io.WriteString(s.stdin, line+"\n"); err != nil {
		s.t.Fatalf("send: %v", err)
	}
}

func (s *widePtySession) Type(k string) { _, _ = io.WriteString(s.ptmx, k) }

func (s *widePtySession) TTY() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.ToValidUTF8(s.ttyBuf.String(), "")
}

// Screen mirrors testutil.Screen, sized to this session's own terminal
// instead of testutil's fixed 100x30.
// Screen replays the raw stream through a same-sized vt.Emulator and
// returns the visible text with trailing blank rows trimmed -- handy for
// substring-based waits, but not for a residue check: trimming the blank
// tail is exactly what would hide a stanza sitting above the live frame if
// the trim ever cut into real content by mistake. FullGrid is the
// byte-for-byte comparison surface; Screen is the polling convenience.
func (s *widePtySession) Screen() string {
	lines := strings.Split(s.FullGrid(), "\n")
	return strings.TrimRight(strings.Join(lines, "\n"), "\n")
}

// FullGrid replays the raw stream through a same-sized vt.Emulator and
// returns EVERY row -- all s.rows of them, top row included, no trailing
// trim -- so a residue stanza left behind above the live frame (or a
// legitimate scroll that moved prior content off the top) shows up in the
// comparison rather than being silently dropped by a bottom trim that only
// ever looked at "the frame region."
func (s *widePtySession) FullGrid() string {
	em := vt.NewEmulator(s.cols, s.rows)
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		_, _ = io.Copy(io.Discard, em)
	}()
	em.Write([]byte(s.TTY()))
	out := em.String()
	em.Close()
	<-drained

	lines := strings.Split(out, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " ")
	}
	return strings.Join(lines, "\n")
}

func (s *widePtySession) WaitForPaint(text string) {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(s.Screen(), text) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.t.Fatalf("never painted %q:\n%s", text, s.Screen())
}

func (s *widePtySession) WaitForGone(text string) {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !strings.Contains(s.Screen(), text) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.t.Fatalf("still painted %q:\n%s", text, s.Screen())
}

// TestWireModalHeaderNeverOverflowsTheTerminalWidth is the header-overflow
// golden, reproduced at the reported terminal size (110 cols) with the
// reported request shape: a 2-row multi list with nothing selected (so the
// selected panel stays hidden) and a short TS-driven modal, injected as a
// real wire "modal" line through the stdin reader -- not constructed
// in-process -- exactly the path readPatches decodes in the shipped binary.
//
// The modal's own Message is long enough to make modalContentWidth clamp
// the box to its width ceiling: a registry menu's title is always a row's
// own short label, but a TS-driven modal's title is caller-supplied free
// text with no such bound, and modalHeaderLine used to render it
// unclipped. Once the title's natural width exceeds what the clamped box
// has left for it, the header line -- and with it the whole bordered box,
// since every box line is joined before the border is drawn around
// whichever one is widest -- renders wider than the terminal, which is
// exactly the corruption this asserts against directly rather than
// inferring it from how a terminal happens to wrap the overflow.
func TestWireModalHeaderNeverOverflowsTheTerminalWidth(t *testing.T) {
	const cols, rows = 110, 34
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Multi: true,
		Rows: []protocol.PickRow{
			{Value: "a", Left: []protocol.PickSegment{{Text: "alpha", Tone: "text"}}},
			{Value: "b", Left: []protocol.PickSegment{{Text: "bravo", Tone: "text"}}},
		},
	}
	reqLine, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}

	s := startWidePtySession(t, []string{testutil.Binary(t), "pick"}, cols, rows, 0)
	s.Send(string(reqLine))
	s.WaitForPaint("alpha")
	time.Sleep(300 * time.Millisecond) // let the first frame settle
	base := s.Screen()

	modal := protocol.PickModal{
		T:       "modal",
		Message: "Sort by column, ascending or descending, then apply and confirm the choice made across every visible row in the current view",
		Rows: []protocol.PickRow{
			{Value: "name", Left: []protocol.PickSegment{{Text: "Name"}}},
			{Value: "size", Left: []protocol.PickSegment{{Text: "Size"}}},
		},
	}
	modalLine, err := json.Marshal(modal)
	if err != nil {
		t.Fatal(err)
	}
	s.Send(string(modalLine))
	s.WaitForPaint("esc dismiss")
	time.Sleep(200 * time.Millisecond) // let the open frame settle

	screen := s.Screen()
	for i, line := range strings.Split(screen, "\n") {
		if w := lipgloss.Width(line); w > cols {
			t.Errorf("line %d is %d cols wide, wider than the %d-col terminal:\n%q\nfull screen:\n%s", i, w, cols, line, screen)
		}
	}

	s.Type("\x1b") // esc dismisses the TS modal
	s.WaitForGone("esc dismiss")
	time.Sleep(300 * time.Millisecond) // let the closing frame settle

	final := s.Screen()
	if final != base {
		t.Fatalf("final frame carries residue from the wire-modal open/dismiss cycle:\n--- base ---\n%s\n--- final ---\n%s", base, final)
	}
}

// wireModalFullGridRequest builds the request/modal pair the two full-grid
// goldens below both drive: a 2-row multi list with nothing selected (so
// the selected panel and its chip both stay hidden) and a short TS modal --
// the shape a live 110x34 tmux drive reported residue against.
func wireModalFullGridRequest() (reqLine, modalLine []byte) {
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Multi: true,
		Rows: []protocol.PickRow{
			{Value: "a", Left: []protocol.PickSegment{{Text: "alpha", Tone: "text"}}},
			{Value: "b", Left: []protocol.PickSegment{{Text: "bravo", Tone: "text"}}},
		},
	}
	modal := protocol.PickModal{
		T: "modal", Message: "Sort",
		Rows: []protocol.PickRow{
			{Value: "name", Left: []protocol.PickSegment{{Text: "Name"}}},
			{Value: "size", Left: []protocol.PickSegment{{Text: "Size"}}},
		},
	}
	reqLine, _ = json.Marshal(req)
	modalLine, _ = json.Marshal(modal)
	return reqLine, modalLine
}

// TestFullGridStaysCleanAcrossASettledWireModalCycle is the strengthened
// residue golden: it compares the ENTIRE pty grid (every one of the 110x34
// rows, the row above the picker's own frame included -- not just the live
// frame region a byte-for-byte check of the visible frame alone would miss
// a stanza sitting above it in) across a real wire-message modal open and
// esc-dismiss, with a line of prior pane content already on screen before
// the picker's own frame starts -- the same way a real terminal pane
// running a picker after some earlier output would leave the picker's
// frame anchored below row 0, not at it. The open waits for the frame to
// settle before dismissing, mirroring a normal, unhurried session.
//
// This harness's own terminal emulation was confirmed, across many
// configurations, not to reproduce the specific residue a real tmux
// session shows for this same sequence, so this golden is not a
// RED-before/GREEN-after proof of the underlying bug by itself. It is
// kept because the invariant it checks (the full grid, not just the live
// frame slice) is strictly stronger than what came before, and it does
// catch any residue this harness is capable of producing at all.
func TestFullGridStaysCleanAcrossASettledWireModalCycle(t *testing.T) {
	const cols, rows = 110, 34
	reqLine, modalLine := wireModalFullGridRequest()

	s := startWidePtySession(t, []string{testutil.Binary(t), "pick"}, cols, rows, 1)
	s.Send(string(reqLine))
	s.WaitForPaint("alpha")
	time.Sleep(300 * time.Millisecond)
	base := s.FullGrid()

	s.Send(string(modalLine))
	s.WaitForPaint("esc dismiss")
	time.Sleep(700 * time.Millisecond) // settle before dismissing

	s.Type("\x1b")
	s.WaitForGone("esc dismiss")
	time.Sleep(700 * time.Millisecond)

	final := s.FullGrid()
	if final != base {
		t.Fatalf("full-grid residue after a settled wire-modal cycle:\n--- base ---\n%s\n--- final ---\n%s", base, final)
	}
}

// TestFullGridStaysCleanAcrossARacedWireModalCycle is
// TestFullGridStaysCleanAcrossASettledWireModalCycle's raced sibling: two
// wire modal messages fired back to back, with no wait for the first to
// settle before the second arrives -- the shape openTSModal's own clobber
// guard exists for. Same full-grid comparison, same caveat about this
// harness's own inability to reproduce the real-tmux-only symptom.
func TestFullGridStaysCleanAcrossARacedWireModalCycle(t *testing.T) {
	const cols, rows = 110, 34
	reqLine, modalLine := wireModalFullGridRequest()

	s := startWidePtySession(t, []string{testutil.Binary(t), "pick"}, cols, rows, 1)
	s.Send(string(reqLine))
	s.WaitForPaint("alpha")
	time.Sleep(300 * time.Millisecond)
	base := s.FullGrid()

	s.Send(string(modalLine))
	s.Send(string(modalLine))
	s.WaitForPaint("esc dismiss")
	time.Sleep(700 * time.Millisecond)

	s.Type("\x1b")
	s.WaitForGone("esc dismiss")
	time.Sleep(700 * time.Millisecond)

	final := s.FullGrid()
	if final != base {
		t.Fatalf("full-grid residue after a raced wire-modal cycle:\n--- base ---\n%s\n--- final ---\n%s", base, final)
	}
}

// tabOrREPSequence matches a literal tab byte or an ANSI REP (repeat
// preceding character, "ESC [ Pn b") escape sequence in a raw tty stream.
// Both are motion/repaint optimizations the renderer's own diff can choose
// on a byte-count basis; a tab-stop-relative cursor move is the one this
// package no longer lets the renderer consider at all once /dev/tty's own
// termios has tab expansion turned on.
var tabOrREPSequence = regexp.MustCompile("\t|\x1b\\[[0-9]*b")

// TestWireModalOpenEmitsNoTabOrRepSequence is the overlay-specific byte
// gate: opening a wire-message modal composited over the header row used
// to be exactly the transition that picked a tab-stop-relative cursor move
// there (clean key-opened ctrl-k menus never did) -- the real terminal's
// own tab-stop model and this renderer's own model of one have no
// guarantee of agreeing, and disagreeing by even one column on that row is
// what left a stanza behind above the live frame. Asserts directly against
// the bytes the real binary writes to its tty while the overlay opens, not
// against a synthetic string.
//
// The breadcrumb and declared actions here are deliberately not the same
// shape wireModalFullGridRequest's own goldens use: this exact combination
// (a three-segment breadcrumb, two declared actions) is what actually
// drives the differ to prefer a tab-stop-relative move over an absolute
// one on the composited header row in this harness -- a shorter
// breadcrumb never gives it a wide enough gap to make tabs the cheaper
// choice, so it would never turn this golden red before the fix either.
func TestWireModalOpenEmitsNoTabOrRepSequence(t *testing.T) {
	const cols, rows = 110, 34
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb: []string{"rt", "worktree", "dispose"},
		Rows: []protocol.PickRow{
			{Value: "a", Left: []protocol.PickSegment{{Text: "alpha"}}},
			{Value: "b", Left: []protocol.PickSegment{{Text: "bravo"}}},
		},
		Actions: []protocol.PickAction{
			{ID: "dispose", Label: "dispose", Key: "ctrl-x", Scope: "item"},
			{ID: "refresh", Label: "refresh", Key: "ctrl-r", Scope: "global"},
		},
	}
	reqLine, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	modal := protocol.PickModal{
		T: "modal", Message: "Sort by",
		Rows: []protocol.PickRow{
			{Value: "name", Left: []protocol.PickSegment{{Text: "Name"}}},
			{Value: "size", Left: []protocol.PickSegment{{Text: "Size"}}},
		},
	}
	modalLine, err := json.Marshal(modal)
	if err != nil {
		t.Fatal(err)
	}

	s := startWidePtySession(t, []string{testutil.Binary(t), "pick"}, cols, rows, 1)
	s.Send(string(reqLine))
	s.WaitForPaint("alpha")
	time.Sleep(300 * time.Millisecond)
	preOpenLen := len(s.TTY())

	s.Send(string(modalLine))
	s.WaitForPaint("esc dismiss")
	time.Sleep(300 * time.Millisecond)

	openBytes := s.TTY()[preOpenLen:]
	if m := tabOrREPSequence.FindString(openBytes); m != "" {
		t.Fatalf("wire-modal open emitted a tab or REP motion: %q\nfull transition bytes: %q", m, openBytes)
	}
}

// TestPickerFramesNeverEmitATabByte is the simpler, global byte gate: no
// picker session -- list navigation, a key-opened menu, and a wire-message
// modal, opened and closed -- ever writes a literal tab byte (0x09) to its
// tty at all, across the whole raw stream. /dev/tty's own termios now has
// tab expansion on for every view that opens one (see internal/tty), so
// this isn't specific to overlays; it's the property the fix actually
// establishes. Same request/modal shape as
// TestWireModalOpenEmitsNoTabOrRepSequence, for the same reason: it's the
// one this harness has confirmed actually drives the differ to reach for a
// tab in the first place, so a narrower shape would pass whether or not
// the fix is doing anything.
func TestPickerFramesNeverEmitATabByte(t *testing.T) {
	const cols, rows = 110, 34
	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Breadcrumb: []string{"rt", "worktree", "dispose"},
		Rows: []protocol.PickRow{
			{Value: "a", Left: []protocol.PickSegment{{Text: "alpha"}}},
			{Value: "b", Left: []protocol.PickSegment{{Text: "bravo"}}},
		},
		Actions: []protocol.PickAction{
			{ID: "dispose", Label: "dispose", Key: "ctrl-x", Scope: "item"},
			{ID: "refresh", Label: "refresh", Key: "ctrl-r", Scope: "global"},
		},
	}
	reqLine, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}

	s := startWidePtySession(t, []string{testutil.Binary(t), "pick"}, cols, rows, 1)
	s.Send(string(reqLine))
	s.WaitForPaint("alpha")
	time.Sleep(150 * time.Millisecond)

	s.Type("\x1b[B") // down arrow
	s.Type("\x1b[B")
	time.Sleep(100 * time.Millisecond)

	s.Type("\x0b") // ctrl-k opens the registry menu
	s.WaitForPaint("esc dismiss")
	time.Sleep(150 * time.Millisecond)
	s.Type("\x1b")
	s.WaitForGone("esc dismiss")
	time.Sleep(150 * time.Millisecond)

	modal := protocol.PickModal{
		T: "modal", Message: "Sort by",
		Rows: []protocol.PickRow{
			{Value: "name", Left: []protocol.PickSegment{{Text: "Name"}}},
			{Value: "size", Left: []protocol.PickSegment{{Text: "Size"}}},
		},
	}
	modalLine, err := json.Marshal(modal)
	if err != nil {
		t.Fatal(err)
	}
	s.Send(string(modalLine))
	s.WaitForPaint("esc dismiss")
	time.Sleep(150 * time.Millisecond)
	s.Type("\x1b")
	s.WaitForGone("esc dismiss")
	time.Sleep(150 * time.Millisecond)

	tty := s.TTY()
	if strings.ContainsRune(tty, '\t') {
		t.Fatalf("session emitted a tab byte somewhere in its tty stream:\n%q", tty)
	}
}

// TestPickRefusesWhenStdoutIsTheSameDeviceAsTheTTY reproduces the debug-
// harness footgun directly: stdout wired to the same pty the child opens as
// its controlling terminal (via Setctty on fd 3, the same mechanism every
// other test here uses to give the child a /dev/tty) is exactly the shape
// that corrupted the frame, so the host guard must refuse to start rather
// than let the protocol stream and the visual frame share a cursor.
func TestPickRefusesWhenStdoutIsTheSameDeviceAsTheTTY(t *testing.T) {
	ptmx, pts, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer ptmx.Close()
	if err := pty.Setsize(ptmx, &pty.Winsize{Rows: 30, Cols: 100}); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(testutil.Binary(t), "pick")
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stdout = pts // the same device the child opens as /dev/tty below
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.ExtraFiles = []*os.File{pts}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 3}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pts.Close()

	req := protocol.PickRequest{
		T: "pick", Protocol: protocol.Version,
		Rows: []protocol.PickRow{{Value: "a"}},
	}
	reqLine, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(stdin, string(reqLine)+"\n"); err != nil {
		t.Fatal(err)
	}
	stdin.Close()

	waitErr := cmd.Wait()
	exit := 0
	if ee, ok := waitErr.(*exec.ExitError); ok {
		exit = ee.ExitCode()
	} else if waitErr != nil {
		t.Fatalf("wait: %v", waitErr)
	}
	if exit == 0 {
		t.Fatalf("expected a non-zero exit when stdout shares the tty, stderr: %s", stderr.String())
	}
	if !strings.Contains(stderr.String(), "refusing to run with stdout attached to the terminal") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}
