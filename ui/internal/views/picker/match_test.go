package picker

import "testing"

func TestRankScoresAndPositions(t *testing.T) {
	ms := Rank("wprov", []string{"worktree provision", "create", "provision"}, false)
	if ms[0].Index != 0 || ms[0].Score == 0 || len(ms[0].Positions) != 5 {
		t.Fatalf("%+v", ms[0])
	}
}

func TestRankEmptyQueryKeepsOrder(t *testing.T) {
	ms := Rank("", []string{"b", "a"}, false)
	if len(ms) != 2 || ms[0].Index != 0 || ms[1].Index != 1 {
		t.Fatalf("%+v", ms)
	}
}

func TestRankExactMode(t *testing.T) {
	if len(Rank("prov", []string{"worktree"}, true)) != 0 {
		t.Fatal("exact should not fuzz")
	}
}
