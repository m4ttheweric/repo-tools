package testutil

import (
	"bufio"
	"bytes"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
)

// Session drives a long-lived rt-ui verb: lines go down stdin while it runs,
// stdout lines come back one at a time, keys go to the controlling pty.
type Session struct {
	t      *testing.T
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	lines  chan string
	ptmx   *os.File
	mu     sync.Mutex
	ttyBuf bytes.Buffer
	done   chan struct{}
}

func StartSession(t *testing.T, argv []string, env map[string]string) *Session {
	t.Helper()
	ptmx, pts, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	if err := pty.Setsize(ptmx, &pty.Winsize{Rows: 30, Cols: 100}); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = io.Discard
	cmd.ExtraFiles = []*os.File{pts}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 3}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pts.Close()

	s := &Session{t: t, cmd: cmd, stdin: stdin, lines: make(chan string, 64), ptmx: ptmx, done: make(chan struct{})}
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			s.lines <- sc.Text()
		}
		close(s.lines)
	}()
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
				close(s.done)
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

func (s *Session) Send(line string) {
	if _, err := io.WriteString(s.stdin, line+"\n"); err != nil {
		s.t.Fatalf("send: %v", err)
	}
}

func (s *Session) CloseStdin() { s.stdin.Close() }

// ReadLine returns the next stdout line, or ok=false when the child's stdout
// closed or the timeout passed.
func (s *Session) ReadLine(timeout time.Duration) (string, bool) {
	select {
	case l, ok := <-s.lines:
		return l, ok
	case <-time.After(timeout):
		return "", false
	}
}

// WaitForPaint blocks until the emulated screen shows text, so keys are
// never typed before the view is up. It reads the screen, not the raw
// stream: styled text arrives as several SGR-separated writes and a
// diffing renderer overwrites cells in place, so a substring match on the
// bytes would miss what a user plainly sees.
func (s *Session) WaitForPaint(text string) {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(s.Screen(), text) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.t.Fatalf("never painted %q:\n%s", text, s.Screen())
}

// WaitForGone is the negative of WaitForPaint: it returns once text has left
// the emulated screen, for asserting a dismissed layer without a fixed sleep.
func (s *Session) WaitForGone(text string) {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !strings.Contains(s.Screen(), text) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	s.t.Fatalf("still painted %q:\n%s", text, s.Screen())
}

func (s *Session) Type(keys ...string) {
	for _, k := range keys {
		time.Sleep(30 * time.Millisecond)
		io.WriteString(s.ptmx, k)
	}
}

func (s *Session) Kill(sig syscall.Signal) {
	if err := syscall.Kill(s.cmd.Process.Pid, sig); err != nil {
		s.t.Fatal(err)
	}
}

func (s *Session) Wait() int {
	err := s.cmd.Wait()
	select {
	case <-s.done:
	case <-time.After(time.Second):
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	if err != nil {
		s.t.Fatalf("wait: %v", err)
	}
	return 0
}

func (s *Session) TTY() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.ToValidUTF8(s.ttyBuf.String(), "")
}

func (s *Session) Screen() string { return Screen(s.TTY()) }
