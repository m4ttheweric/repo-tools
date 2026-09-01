//go:build linux

package tty

import "golang.org/x/sys/unix"

// setTermiosRequest is the ioctl request Linux termios expects for writing
// a *unix.Termios back to a tty -- the request code differs by platform,
// unlike the Termios fields and TABDLY/TAB3 values themselves.
const setTermiosRequest = unix.TCSETS
