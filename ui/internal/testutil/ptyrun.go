package testutil

import (
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

// RunPTY starts argv in a new session whose controlling terminal is a fresh
// pty, with a pipe as stdin (kept open until exit unless closeStdin) and
// stdout captured. The pty is NOT fd 0/1/2 (those are our pipes); it is only
// the controlling tty, which is exactly what /dev/tty resolves to. stdinLines
// are written first; keys are typed to the pty after the first tty paint.
func RunPTY(t *testing.T, argv []string, stdinLines []string, keys []string, env map[string]string, closeStdin bool) (stdout, tty string, exit int) {
	t.Helper()
	ptmx, pts, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer ptmx.Close()
	if err := pty.Setsize(ptmx, &pty.Winsize{Rows: 30, Cols: 100}); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	stdinW, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	// The slave becomes fd 3 in the child; Setctty/Ctty make it the
	// controlling terminal of the child's new session.
	cmd.ExtraFiles = []*os.File{pts}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 3}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pts.Close()

	var mu sync.Mutex
	var ttyBuf bytes.Buffer
	done := make(chan struct{})
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				mu.Lock()
				ttyBuf.Write(buf[:n])
				mu.Unlock()
			}
			if err != nil {
				close(done)
				return
			}
		}
	}()
	painted := func() bool {
		mu.Lock()
		defer mu.Unlock()
		return ttyBuf.Len() > 0
	}

	for _, l := range stdinLines {
		io.WriteString(stdinW, l+"\n")
	}

	// Wait for the first paint before typing so keys are not swallowed, and
	// before closing stdin so a "parent died" test sees a painted card die,
	// not a program that never got to paint.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && !painted() {
		time.Sleep(10 * time.Millisecond)
	}
	if closeStdin {
		stdinW.Close()
	}
	for _, k := range keys {
		time.Sleep(30 * time.Millisecond)
		io.WriteString(ptmx, k)
	}
	err = cmd.Wait()
	if !closeStdin {
		stdinW.Close()
	}
	select {
	case <-done:
	case <-time.After(time.Second):
	}
	exit = 0
	if ee, ok := err.(*exec.ExitError); ok {
		exit = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("wait: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	return out.String(), strings.ToValidUTF8(ttyBuf.String(), ""), exit
}
