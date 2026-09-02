//go:build !darwin && !linux

package tty

// expandTabs is a no-op on platforms this package has no verified termios
// tab-expansion lever for. /dev/tty itself is already Unix-only in
// practice (Open's own path never resolves elsewhere), so this only
// matters for keeping the package buildable everywhere, not for any
// platform rt-ui actually ships or tests on.
func expandTabs(int) func() { return nil }

// IsTerminal always reports false here, for the same reason expandTabs is a
// no-op: no verified termios lever on this platform, and never the platform
// rt-ui actually ships or tests on.
func IsTerminal(int) bool { return false }
