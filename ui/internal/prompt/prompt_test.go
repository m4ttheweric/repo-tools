package prompt_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rt-ui/internal/testutil"
)

// The fixtures are pretty-printed for humans; the wire is one JSON per line,
// so a fixture only becomes a spec once compacted.
func spec(t *testing.T, name string) string {
	b, err := os.ReadFile(filepath.Join("..", "..", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, b); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}

const (
	keyEnter  = "\r"
	keyDown   = "\x1b[B"
	keyEsc    = "\x1b"
	keyCtrlC  = "\x03"
	keyCtrlUp = "\x1b[1;5A"
)

func TestSelectEnterReturnsInitialAndExitsZero(t *testing.T) {
	stdout, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{keyEnter}, nil, false)
	if exit != 0 {
		t.Fatalf("exit %d", exit)
	}
	var r map[string]any
	if err := json.Unmarshal([]byte(stdout), &r); err != nil {
		t.Fatalf("stdout %q: %v", stdout, err)
	}
	if r["value"] != "1h" {
		t.Fatalf("value %v", r["value"])
	}
	if !strings.Contains(tty, "Access duration") || !strings.Contains(tty, "╭") {
		t.Fatalf("card not painted: %q", tty)
	}
	if !strings.Contains(tty, "back to resources") {
		t.Fatalf("back row missing: %q", tty)
	}
}

func TestSelectDownEnterPicksSecond(t *testing.T) {
	stdout, _, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{keyDown, keyEnter}, nil, false)
	if exit != 0 || !strings.Contains(stdout, `"value":"4h"`) {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
}

// Every exit must leave no card on screen: cancel and back go through the
// same graceful Quit + empty-view path an answer takes, never an interrupt
// (which skips Bubble Tea's final flush and strands the card).
func assertCardGone(t *testing.T, tty string) {
	t.Helper()
	if screen := testutil.Screen(tty); strings.Contains(screen, "╭") || strings.Contains(screen, "Access duration") {
		t.Fatalf("card still on screen after exit:\n%s", screen)
	}
}

func TestSelectEscExits130WithNoStdoutAndClearsCard(t *testing.T) {
	stdout, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{keyEsc}, nil, false)
	if exit != 130 || stdout != "" {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
	assertCardGone(t, tty)
}

func TestSelectCtrlCExits130(t *testing.T) {
	_, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{keyCtrlC}, nil, false)
	if exit != 130 {
		t.Fatalf("exit %d", exit)
	}
	assertCardGone(t, tty)
}

func TestSelectCtrlUpExits131AndClearsCard(t *testing.T) {
	stdout, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{keyCtrlUp}, nil, false)
	if exit != 131 || stdout != "" {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
	assertCardGone(t, tty)
}

func TestSelectAnswerClearsCard(t *testing.T) {
	_, tty, _ := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{keyEnter}, nil, false)
	assertCardGone(t, tty)
}

func TestSelectBackRowExits131(t *testing.T) {
	// The ↩ row is the first option; the cursor starts on the initial ("1h"), one below it.
	_, _, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{"\x1b[A", keyEnter}, nil, false)
	if exit != 131 {
		t.Fatalf("exit %d", exit)
	}
}

func TestConfirmYAndNAndCollapse(t *testing.T) {
	stdout, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-confirm.json")}, []string{"y"}, nil, false)
	if exit != 0 || !strings.Contains(stdout, `"ok":true`) {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
	// Bubble Tea erases the inline card on exit (\x1b[J); the collapsed line
	// is written after that erase and nothing may move the cursor up first.
	checkAt := strings.LastIndex(tty, "✓")
	if checkAt < 0 {
		t.Fatalf("collapsed line missing: %q", tty)
	}
	eraseAt := strings.LastIndex(tty[:checkAt], "\x1b[J")
	if eraseAt < 0 || !strings.Contains(tty[checkAt:], "Run sdm login now?") {
		t.Fatalf("collapsed line must follow the card erase: %q", tty)
	}
	// Bubble Tea's own inline repaints may move the cursor up while the card is
	// live; after its final erase, nothing may (that would eat the user's
	// previous line).
	if strings.Contains(tty[eraseAt:], "\x1b[1A") || strings.Contains(tty[eraseAt:], "\x1b[A") {
		t.Fatalf("collapse moved the cursor up after the final erase: %q", tty[eraseAt:])
	}
	if screen := testutil.Screen(tty); !strings.Contains(screen, "✓") || strings.Contains(screen, "╭") {
		t.Fatalf("final screen should be the collapsed line only:\n%s", screen)
	}
	stdout, _, exit = testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-confirm.json")}, []string{"n"}, nil, false)
	if exit != 0 || !strings.Contains(stdout, `"ok":false`) {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
}

func TestConfirmDestructiveDefaultsNoAndPaintsPeach(t *testing.T) {
	destructive := `{"t":"prompt","protocol":1,"kind":"confirm","message":"Locate assured-dev at ~/x? This moves 3 worktrees.","destructive":true}`
	stdout, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{destructive}, []string{keyEnter}, nil, false)
	if exit != 0 || !strings.Contains(stdout, `"ok":false`) {
		t.Fatalf("destructive confirm must default to no: exit %d stdout %q", exit, stdout)
	}
	if !strings.Contains(tty, "\x1b[38;2;255;183;122m") {
		t.Fatalf("destructive confirm is not peach: %q", tty)
	}
}

func TestSelectLegendNamesCtrlUpOnlyWhenBackIsOffered(t *testing.T) {
	_, tty, _ := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{keyEnter}, nil, false)
	if !strings.Contains(tty, "ctrl-up: back") || !strings.Contains(tty, "esc: cancel") {
		t.Fatalf("legend missing ctrl-up/esc: %q", tty)
	}
	noBack := `{"t":"prompt","protocol":1,"kind":"select","title":"Pick","options":[{"value":"a","label":"A"}]}`
	_, tty, _ = testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{noBack}, []string{keyEnter}, nil, false)
	if strings.Contains(tty, "ctrl-up") {
		t.Fatalf("legend advertises ctrl-up with no back row: %q", tty)
	}
}

func TestTextValidatesPatternThenAccepts(t *testing.T) {
	stdout, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-text.json")}, []string{"Bad Name", keyEnter, "\x15", "linear-tools", keyEnter}, nil, false)
	if exit != 0 || !strings.Contains(stdout, `"text":"linear-tools"`) {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
	if !strings.Contains(tty, "must be kebab-case") {
		t.Fatalf("validation message never shown: %q", tty)
	}
}

func TestMultiselectSpaceTogglesAndEnterSubmits(t *testing.T) {
	stdout, _, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-multiselect.json")}, []string{keyDown, " ", keyEnter}, nil, false)
	if exit != 0 {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
	if !strings.Contains(stdout, `"pre-commit"`) || !strings.Contains(stdout, `"pre-push"`) {
		t.Fatalf("stdout %q", stdout)
	}
}

func TestBadSpecExits2(t *testing.T) {
	_, _, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{`{"t":"prompt","protocol":9,"kind":"select"}`}, nil, nil, false)
	if exit != 2 {
		t.Fatalf("exit %d", exit)
	}
}

func TestParentDeathRestoresTerminal(t *testing.T) {
	// Closing stdin while the card is up is "the brain died": rt-ui must shut
	// the form down THROUGH Bubble Tea (which restores termios and erases the
	// inline card) and exit 70. A raw os.Exit from the watcher would leave the
	// shell in raw mode, which is the failure this test exists to catch.
	_, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, nil, nil, true)
	if exit != 70 {
		t.Fatalf("exit %d, want 70", exit)
	}
	if !strings.Contains(tty, "\x1b[J") || !strings.Contains(tty, "\x1b[?25h") {
		t.Fatalf("Bubble Tea's inline close (erase below + cursor show) never ran: %q", tty)
	}
}
