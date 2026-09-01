package picker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
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

func startWidePtySession(t *testing.T, argv []string, cols, rows int) *widePtySession {
	t.Helper()
	ptmx, pts, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	if err := pty.Setsize(ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
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
func (s *widePtySession) Screen() string {
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
	return strings.TrimRight(strings.Join(lines, "\n"), "\n")
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

	s := startWidePtySession(t, []string{testutil.Binary(t), "pick"}, cols, rows)
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
