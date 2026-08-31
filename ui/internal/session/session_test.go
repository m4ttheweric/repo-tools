package session_test

import (
	"strings"
	"syscall"
	"testing"
	"time"

	"rt-ui/internal/testutil"
)

const openEcho = `{"t":"open","view":"echo","model":{"text":"hello board"}}`

func start(t *testing.T) *testutil.Session {
	return testutil.StartSession(t, []string{testutil.Binary(t), "session", "--view", "echo"}, map[string]string{"RT_UI_TEST_VIEWS": "1"})
}

func TestHelloIsTheFirstLineAndCarriesTheView(t *testing.T) {
	s := start(t)
	line, ok := s.ReadLine(2 * time.Second)
	if !ok || !strings.Contains(line, `"t":"hello"`) || !strings.Contains(line, `"protocol":1`) || !strings.Contains(line, `"echo"`) {
		t.Fatalf("hello: %q ok=%v", line, ok)
	}
	if s.TTY() != "" {
		t.Fatalf("painted before open: %q", s.TTY())
	}
	s.Send(`{"t":"close"}`)
	if exit := s.Wait(); exit != 2 {
		t.Fatalf("close before open should be a protocol error, exit %d", exit)
	}
}

func TestOpenPaintsAltScreenAndCloseLeavesIt(t *testing.T) {
	s := start(t)
	s.ReadLine(2 * time.Second)
	s.Send(openEcho)
	s.WaitForPaint("hello board")
	if !strings.Contains(s.TTY(), "\x1b[?1049h") {
		t.Fatalf("alt screen never entered: %q", s.TTY())
	}
	s.Send(`{"t":"model","model":{"text":"second model"}}`)
	s.WaitForPaint("second model")
	// The parent ends stdin right after close, exactly as spawn.ts does;
	// that EOF must read as a clean close, never as a dead parent.
	s.Send(`{"t":"close"}`)
	s.CloseStdin()
	line, ok := s.ReadLine(2 * time.Second)
	if !ok || !strings.Contains(line, `"reason":"closed"`) {
		t.Fatalf("closed line: %q", line)
	}
	if exit := s.Wait(); exit != 0 {
		t.Fatalf("exit %d", exit)
	}
	if !strings.Contains(s.TTY(), "\x1b[?1049l") || !strings.Contains(s.TTY(), "\x1b[?25h") {
		t.Fatalf("alt screen not left / cursor not shown: %q", s.TTY())
	}
}

func TestViewQuitEmitsClosedQuit(t *testing.T) {
	s := start(t)
	s.ReadLine(2 * time.Second)
	s.Send(openEcho)
	s.WaitForPaint("hello board")
	s.Type("q")
	line, _ := s.ReadLine(2 * time.Second)
	if !strings.Contains(line, `"t":"intent"`) || !strings.Contains(line, `"quit"`) {
		t.Fatalf("expected a quit intent first: %q", line)
	}
	line, _ = s.ReadLine(2 * time.Second)
	if !strings.Contains(line, `"reason":"quit"`) {
		t.Fatalf("closed: %q", line)
	}
	if exit := s.Wait(); exit != 0 {
		t.Fatalf("exit %d", exit)
	}
}

func TestParentDeathIsClosedErrorExit70(t *testing.T) {
	s := start(t)
	s.ReadLine(2 * time.Second)
	s.Send(openEcho)
	s.WaitForPaint("hello board")
	s.CloseStdin()
	line, _ := s.ReadLine(2 * time.Second)
	if !strings.Contains(line, `"reason":"error"`) {
		t.Fatalf("closed: %q", line)
	}
	if exit := s.Wait(); exit != 70 {
		t.Fatalf("exit %d", exit)
	}
	if !strings.Contains(s.TTY(), "\x1b[?1049l") || !strings.Contains(s.TTY(), "\x1b[?25h") {
		t.Fatalf("terminal not restored: %q", s.TTY())
	}
}

func TestExternalSignalIsClosedCancelExit130(t *testing.T) {
	s := start(t)
	s.ReadLine(2 * time.Second)
	s.Send(openEcho)
	s.WaitForPaint("hello board")
	s.Kill(syscall.SIGTERM)
	line, _ := s.ReadLine(2 * time.Second)
	if !strings.Contains(line, `"reason":"cancel"`) {
		t.Fatalf("closed: %q", line)
	}
	if exit := s.Wait(); exit != 130 {
		t.Fatalf("exit %d", exit)
	}
}

func TestUnknownViewIsExit2(t *testing.T) {
	s := testutil.StartSession(t, []string{testutil.Binary(t), "session", "--view", "nope"}, nil)
	line, _ := s.ReadLine(2 * time.Second)
	if !strings.Contains(line, `"t":"hello"`) {
		t.Fatalf("hello: %q", line)
	}
	s.Send(`{"t":"open","view":"nope","model":{}}`)
	line, _ = s.ReadLine(2 * time.Second)
	if !strings.Contains(line, `"reason":"error"`) {
		t.Fatalf("closed: %q", line)
	}
	if exit := s.Wait(); exit != 2 {
		t.Fatalf("exit %d", exit)
	}
}
