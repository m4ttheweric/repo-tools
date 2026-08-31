package board

import (
	"testing"

	"charm.land/lipgloss/v2"
)

// A one-cell window has no room beside the ellipsis: MaxWidth(0) does not
// truncate, so without the w==1 guard clip returns the full string plus "…".
func TestClipOneCellIsJustTheMarker(t *testing.T) {
	if got := clip("hello", 1); got != "…" {
		t.Fatalf("clip(\"hello\", 1) = %q, want the ellipsis alone", got)
	}
	if w := lipgloss.Width(clip("hello", 1)); w != 1 {
		t.Fatalf("one-cell clip width = %d, want 1", w)
	}
	// Wider windows keep content plus the marker and stay within w cells.
	if w := lipgloss.Width(clip("hello world", 6)); w > 6 {
		t.Fatalf("clip overflowed a 6-cell window: width %d", w)
	}
}
