//go:build darwin || linux

package tty

import (
	"github.com/charmbracelet/x/termios"
	"golang.org/x/sys/unix"
)

// expandTabs sets the tty's own TABDLY field to TAB3 (hardware tab
// expansion -- OXTABS on Darwin/BSD, XTABS on Linux) so that any tab byte
// the process writes is expanded to spaces by the kernel line discipline
// before it ever reaches the terminal.
//
// This is the same flag bubbletea's own inline renderer reads once, at
// startup, to decide whether hard-tab cursor motion is safe to use at all
// (Oflag&TABDLY == TAB0 means "no expansion, hardware tabs pass through
// untouched"). When it believes that, the renderer's diff can choose a
// tab-stop-relative cursor move over an absolute cursor-forward one purely
// because it costs fewer bytes -- and a tab stop is a property of the real
// terminal, not something the renderer can measure from here, so its own
// column math and the terminal's own tab-stop math have no guarantee of
// agreeing. A composited overlay's own header row hit exactly that: the two
// disagreed by a column, the terminal auto-wrapped the row, and every later
// relative cursor move in that frame landed one row short of where the
// renderer believed it was -- a slip that compounds every time the overlay
// reopens.
//
// Expanding tabs removes the ambiguity at its source rather than papering
// over one call site: with TABDLY no longer TAB0, bubbletea's own probe
// decides hard tabs aren't worth it and sticks to absolute moves for the
// whole session, and even a hard tab some other path still emitted would
// already have been rewritten to literal spaces by the kernel before
// reaching the terminal -- so the terminal's own tab-stop model is never
// consulted at all.
// expandTabs returns a restore func that undoes the TABDLY change on the
// real tty device -- Close on the fd does not, since this is device state,
// not per-fd state, and would otherwise persist past process exit. Returns
// nil (nothing to restore) when the flag was already TAB3 or either ioctl
// fails.
func expandTabs(fd int) func() {
	term, err := termios.GetTermios(fd)
	if err != nil {
		return nil
	}
	if term.Oflag&unix.TABDLY == unix.TAB3 {
		return nil
	}
	origTABDLY := term.Oflag & unix.TABDLY
	term.Oflag = (term.Oflag &^ unix.TABDLY) | unix.TAB3
	if unix.IoctlSetTermios(fd, setTermiosRequest, term) != nil {
		return nil
	}
	return func() {
		restored, err := termios.GetTermios(fd)
		if err != nil {
			return
		}
		restored.Oflag = (restored.Oflag &^ unix.TABDLY) | origTABDLY
		_ = unix.IoctlSetTermios(fd, setTermiosRequest, restored)
	}
}

// IsTerminal reports whether fd refers to a terminal device -- the standard
// isatty test (a termios ioctl succeeds only against a tty). This is the
// only reliable way to compare a fd against "the terminal": /dev/tty is a
// cloning alias whose own stat identity (Dev/Ino/Rdev) is fixed and
// unrelated to whichever real terminal device it redirects I/O to, on both
// Darwin and Linux, so no stat-based comparison against an opened /dev/tty
// can ever match the real device it proxies.
func IsTerminal(fd int) bool {
	_, err := termios.GetTermios(fd)
	return err == nil
}
