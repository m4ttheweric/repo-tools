package picker

import (
	"errors"
	"os"

	"rt-ui/internal/tty"
)

// errStdoutSharesTTY is the host-level guard's refusal: the protocol stream
// (stdout) and the visual frame (/dev/tty) each do their own cursor
// bookkeeping, so a process that opens both against the same device has one
// corrupting the other's writes. Production (lib/ui/pick.ts) always pipes
// stdout separately from the tty it opens; a caller that leaves stdout
// attached to a real terminal at all is always the debug-harness footgun,
// never a legitimate shape, so Run refuses outright rather than rendering a
// corrupted frame.
var errStdoutSharesTTY = errors.New("refusing to run with stdout attached to the terminal; the protocol stream and the visual frame cannot share a tty (redirect stdout)")

// stdoutIsATerminal is the guard's actual test. Comparing stdout's device
// identity against a freshly opened /dev/tty cannot work: /dev/tty is a
// cloning alias whose own stat identity (Dev/Ino/Rdev) is fixed and
// unrelated to whichever real terminal device it redirects I/O to, on both
// Darwin and Linux, so it never matches the real device it proxies. Since
// production always pipes stdout, a tty on stdout at all is already the
// condition this guard exists to catch.
func stdoutIsATerminal(output *os.File) bool {
	return tty.IsTerminal(int(output.Fd()))
}
