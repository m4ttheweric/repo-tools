// Package tty owns the terminal handle. UI bytes go to /dev/tty so stdin and
// stdout stay free for the protocol, which is how fzf coexists with rt too.
package tty

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

type Mode int

const (
	ReadWrite Mode = iota
	WriteOnly
)

// Open returns the tty handle and a close func that restores whatever
// device-level termios state Open itself changed before closing the fd --
// call it (via defer) instead of f.Close directly.
func Open(mode Mode) (*os.File, func(), error) {
	flag := os.O_RDWR
	if mode == WriteOnly {
		flag = os.O_WRONLY
	}
	f, err := os.OpenFile("/dev/tty", flag, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("open /dev/tty: %w", err)
	}
	restore := expandTabs(int(f.Fd()))
	closeFn := func() {
		if restore != nil {
			restore()
		}
		_ = f.Close()
	}
	return f, closeFn, nil
}

// WatchStdinEOF calls onEOF once when the parent closes our stdin. The parent
// keeps stdin open for our whole life, so EOF only ever means it died.
func WatchStdinEOF(onEOF func()) { watchEOF(os.Stdin, onEOF) }

func watchEOF(r io.Reader, onEOF func()) {
	go func() {
		buf := make([]byte, 4096)
		for {
			if _, err := r.Read(buf); err != nil {
				onEOF()
				return
			}
		}
	}()
}

var firstPaintOnce sync.Once

// FirstPaint writes the bench hook line exactly once, only under RT_UI_BENCH=1.
func FirstPaint() { firstPaintTo(os.Stderr) }

func firstPaintTo(w io.Writer) {
	if os.Getenv("RT_UI_BENCH") != "1" {
		return
	}
	firstPaintOnce.Do(func() {
		_, _ = fmt.Fprintf(w, "first-paint %d\n", time.Now().UnixMilli())
	})
}
