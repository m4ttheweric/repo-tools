package steps_test

import (
	"strings"
	"testing"

	"rt-ui/internal/testutil"
)

const hello = `{"t":"hello","protocol":1}`

func TestDoneStepPrintsCheckLineAndExitsZero(t *testing.T) {
	lines := []string{hello, `{"t":"start","title":"fetching origin…"}`, `{"t":"done","title":"origin fetched","hint":"3 new commits"}`}
	stdout, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "steps"}, lines, nil, nil, true)
	if exit != 0 || stdout != "" {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
	if !strings.Contains(tty, "✓") || !strings.Contains(tty, "origin fetched") || !strings.Contains(tty, "3 new commits") {
		t.Fatalf("tty %q", tty)
	}
}

func TestFailStepPrintsCrossLine(t *testing.T) {
	lines := []string{hello, `{"t":"start","title":"rebasing…"}`, `{"t":"fail","title":"rebase stopped","hint":"conflict in lib/state/db.ts"}`}
	_, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "steps"}, lines, nil, nil, true)
	if exit != 0 || !strings.Contains(tty, "✗") || !strings.Contains(tty, "rebase stopped") {
		t.Fatalf("exit %d tty %q", exit, tty)
	}
}

func TestLogLinesAppearAboveTheActiveStep(t *testing.T) {
	lines := []string{hello, `{"t":"start","title":"pushing…"}`, `{"t":"log","level":"warn","text":"diverged from origin/main"}`, `{"t":"done","title":"pushed"}`}
	_, tty, _ := testutil.RunPTY(t, []string{testutil.Binary(t), "steps"}, lines, nil, nil, true)
	warnAt := strings.Index(tty, "diverged from origin/main")
	doneAt := strings.LastIndex(tty, "pushed")
	if warnAt < 0 || doneAt < 0 || warnAt > doneAt {
		t.Fatalf("order wrong: %q", tty)
	}
	if !strings.Contains(tty, "⚠") {
		t.Fatalf("warn glyph missing: %q", tty)
	}
}

func TestEOFWithoutDoneIsInterrupted(t *testing.T) {
	lines := []string{hello, `{"t":"start","title":"fetching origin…"}`}
	_, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "steps"}, lines, nil, nil, true)
	if exit != 0 || !strings.Contains(tty, "interrupted") {
		t.Fatalf("exit %d tty %q", exit, tty)
	}
}

func TestFastStepNeverPaintsASpinnerFrame(t *testing.T) {
	// start and done arrive together: the final line is all that is painted.
	lines := []string{hello, `{"t":"start","title":"fetching origin…"}`, `{"t":"done","title":"origin fetched"}`}
	_, tty, _ := testutil.RunPTY(t, []string{testutil.Binary(t), "steps"}, lines, nil, nil, true)
	for _, f := range []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"} {
		if strings.Contains(tty, f) {
			t.Fatalf("spinner frame %q painted for an instant step: %q", f, tty)
		}
	}
}

func TestBadHelloExits2(t *testing.T) {
	_, _, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "steps"}, []string{`{"t":"hello","protocol":7}`}, nil, nil, true)
	if exit != 2 {
		t.Fatalf("exit %d", exit)
	}
}

func TestCtrlCFinalizesInterruptedAndExits130(t *testing.T) {
	// The tty is cooked, so ^C on the pty is a SIGINT to the process group,
	// not a key: rt-ui must finalize the active line and exit 130 while the
	// parent (who keeps stdin open here) handles its own SIGINT.
	lines := []string{hello, `{"t":"start","title":"fetching origin…"}`}
	_, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "steps"}, lines, []string{"\x03"}, nil, false)
	if exit != 130 {
		t.Fatalf("exit %d, want 130", exit)
	}
	if !strings.Contains(tty, "interrupted") || !strings.HasSuffix(strings.TrimRight(tty, "\r"), "\n") {
		t.Fatalf("line not finalized with a newline: %q", tty)
	}
}
