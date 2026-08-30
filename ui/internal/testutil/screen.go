package testutil

import (
	"io"
	"strings"

	"github.com/charmbracelet/x/vt"
)

// Screen replays raw tty bytes through a terminal emulator sized like RunPTY's
// pty and returns the visible text, trailing whitespace trimmed per line.
func Screen(tty string) string {
	em := vt.NewEmulator(100, 30)
	// The emulator answers terminal queries (DECRQM and friends) on its own
	// reader, and rt-ui's frames carry those queries. With nobody draining it,
	// the first reply blocks Write forever.
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		_, _ = io.Copy(io.Discard, em)
	}()
	em.Write([]byte(tty))
	out := em.String()
	em.Close()
	<-drained

	lines := strings.Split(out, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " ")
	}
	return strings.TrimRight(strings.Join(lines, "\n"), "\n")
}
