package tty

import (
	"os"
	"testing"
	"time"
)

func TestWatchStdinEOFFiresWhenStdinCloses(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	fired := make(chan struct{}, 1)
	watchEOF(r, func() { fired <- struct{}{} })
	w.Close()
	select {
	case <-fired:
	case <-time.After(2 * time.Second):
		t.Fatal("EOF watcher never fired")
	}
}

func TestFirstPaintIsSilentWithoutBenchEnv(t *testing.T) {
	t.Setenv("RT_UI_BENCH", "")
	r, w, _ := os.Pipe()
	firstPaintTo(w)
	w.Close()
	buf := make([]byte, 64)
	n, _ := r.Read(buf)
	if n != 0 {
		t.Fatalf("wrote %q without RT_UI_BENCH", buf[:n])
	}
}

func TestFirstPaintWritesOnceWithBenchEnv(t *testing.T) {
	t.Setenv("RT_UI_BENCH", "1")
	r, w, _ := os.Pipe()
	firstPaintTo(w)
	firstPaintTo(w)
	w.Close()
	buf := make([]byte, 256)
	n, _ := r.Read(buf)
	out := string(buf[:n])
	if len(out) == 0 || out[:12] != "first-paint " {
		t.Fatalf("got %q", out)
	}
	if countLines(out) != 1 {
		t.Fatalf("expected one line, got %q", out)
	}
}

func countLines(s string) int {
	n := 0
	for _, c := range s {
		if c == '\n' {
			n++
		}
	}
	return n
}
