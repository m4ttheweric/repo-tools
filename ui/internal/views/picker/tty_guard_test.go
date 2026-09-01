package picker

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/creack/pty"
)

// TestStdoutIsATerminalDistinguishesAPtyFromARegularFile is the guard's
// pure test in isolation: a real tty (the slave side of a pty, standing in
// for a debug harness that left stdout on the terminal) reports true, a
// regular file (standing in for production's own piped stdout) reports
// false. Comparing device identity against an opened /dev/tty was the
// spec's first-cut approach; it doesn't work on Darwin or Linux (see
// tty_guard.go's own comment), so this exercises the isatty-based
// replacement directly instead.
func TestStdoutIsATerminalDistinguishesAPtyFromARegularFile(t *testing.T) {
	_, pts, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer pts.Close()
	if !stdoutIsATerminal(pts) {
		t.Fatal("a pty's slave side must report as a terminal")
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "not-a-tty")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if stdoutIsATerminal(f) {
		t.Fatal("a regular file must never report as a terminal")
	}
}
