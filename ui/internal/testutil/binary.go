// Package testutil runs the real rt-ui binary under a pty. Black-box on
// purpose: the contract is the bytes and the exit code, not Go internals.
package testutil

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
)

var (
	buildOnce sync.Once
	binPath   string
	buildErr  error
)

func Binary(t *testing.T) string {
	t.Helper()
	buildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "rt-ui-test-")
		if err != nil {
			buildErr = err
			return
		}
		binPath = filepath.Join(dir, "rt-ui")
		root, _ := filepath.Abs(filepath.Join("..", ".."))
		cmd := exec.Command("go", "build", "-o", binPath, "./cmd/rt-ui")
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			buildErr = err
			t.Logf("build output: %s", out)
		}
	})
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	return binPath
}
