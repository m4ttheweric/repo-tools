package theme

import (
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
)

func TestPaletteMatchesTokenSheet(t *testing.T) {
	want := map[string]string{
		"pink": "#FF6B9D", "mint": "#62E6A8", "coral": "#FF7979", "peach": "#FFB77A",
		"cyan": "#5AAAFF", "lav": "#BD93F9", "text": "#E6E0FF", "dim": "#A8A0C6",
		"bg": "#161224", "selBg": "#37284B", "warnBg": "#2A2033", "panel": "#34304E",
	}
	got := map[string]string{
		"pink": Hex(Pink), "mint": Hex(Mint), "coral": Hex(Coral), "peach": Hex(Peach),
		"cyan": Hex(Cyan), "lav": Hex(Lav), "text": Hex(Text), "dim": Hex(Dim),
		"bg": Hex(Bg), "selBg": Hex(SelBg), "warnBg": Hex(WarnBg), "panel": Hex(Panel),
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %s, want %s", k, got[k], v)
		}
	}
}

func TestSpinnerFrames(t *testing.T) {
	if strings.Join(SpinnerFrames, "") != "⠋⠙⠹⠸⠼⠴⠦⠧⠣⠏" {
		t.Fatalf("frames %q", SpinnerFrames)
	}
}

func TestHuhFormBaseIsThePinkRoundedCard(t *testing.T) {
	styles := Huh().Theme(true)
	out := styles.Form.Base.Render("body")
	if !strings.Contains(out, "╭") || !strings.Contains(out, "╰") {
		t.Fatalf("no rounded border in %q", out)
	}
	if !strings.Contains(out, "\x1b[38;2;255;107;157m") {
		t.Fatalf("border is not pink truecolor: %q", out)
	}
	if lipgloss.Width(out) < 8 {
		t.Fatalf("card too narrow: %q", out)
	}
}

func TestHuhDestructiveUsesPeachAccents(t *testing.T) {
	styles := HuhDestructive().Theme(true)
	if !strings.Contains(styles.Focused.FocusedButton.Render("no"), "\x1b[48;2;255;183;122m") {
		t.Fatalf("destructive button is not peach: %q", styles.Focused.FocusedButton.Render("no"))
	}
	if !strings.Contains(styles.Form.Base.Render("x"), "\x1b[38;2;255;183;122m") {
		t.Fatalf("destructive card border is not peach")
	}
}
