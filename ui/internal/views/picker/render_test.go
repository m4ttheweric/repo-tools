package picker

import "testing"

func TestClipRunesZeroBudget(t *testing.T) {
	kept, truncated := clipRunes("hello", 0)
	if kept != "" {
		t.Errorf("kept = %q, want empty string", kept)
	}
	if !truncated {
		t.Error("truncated = false, want true for a non-empty string at a zero budget")
	}
}

func TestClipRunesZeroBudgetEmptyString(t *testing.T) {
	kept, truncated := clipRunes("", 0)
	if kept != "" {
		t.Errorf("kept = %q, want empty string", kept)
	}
	if truncated {
		t.Error("truncated = true, want false for an already-empty string")
	}
}

func TestClipRunesNegativeBudget(t *testing.T) {
	kept, truncated := clipRunes("hello", -3)
	if kept != "" {
		t.Errorf("kept = %q, want empty string", kept)
	}
	if !truncated {
		t.Error("truncated = false, want true for a non-empty string at a negative budget")
	}
}
