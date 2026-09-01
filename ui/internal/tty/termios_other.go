//go:build !darwin && !linux

package tty

// expandTabs is a no-op on platforms this package has no verified termios
// tab-expansion lever for. /dev/tty itself is already Unix-only in
// practice (Open's own path never resolves elsewhere), so this only
// matters for keeping the package buildable everywhere, not for any
// platform rt-ui actually ships or tests on.
func expandTabs(int) {}
