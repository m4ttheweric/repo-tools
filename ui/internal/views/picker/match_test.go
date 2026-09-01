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

// TestGroupContiguousPartitionsGroupsInCallerOrder proves the ruling: a ranked
// order that interleaves two groups (packages out-scoring queue) is partitioned
// into one contiguous block per group, queue kept ahead of packages by caller
// order, and each block keeps its incoming score order.
func TestGroupContiguousPartitionsGroupsInCallerOrder(t *testing.T) {
	// Original rows: queue at 0,1 then packages at 2,3 -- caller order is
	// queue-before-packages. A fuzzy Rank interleaves them by score, and puts
	// queue row 1 ahead of queue row 0 within the group.
	groups := []string{"queue", "queue", "packages", "packages"}
	ranked := []Match{{Index: 2}, {Index: 1}, {Index: 3}, {Index: 0}}

	got := GroupContiguous(ranked, groups)

	wantIdx := []int{1, 0, 2, 3} // queue block (1 before 0), then packages (2, 3)
	if len(got) != len(wantIdx) {
		t.Fatalf("GroupContiguous returned %d matches, want %d", len(got), len(wantIdx))
	}
	for i, w := range wantIdx {
		if got[i].Index != w {
			gotIdx := make([]int, len(got))
			for j, mt := range got {
				gotIdx[j] = mt.Index
			}
			t.Fatalf("GroupContiguous order = %v, want %v", gotIdx, wantIdx)
		}
	}
}

// TestGroupContiguousLeavesUngroupedOrderUntouched pins the no-op path: a list
// whose rows share one group (or none) is returned in the incoming Rank order,
// never reshuffled.
func TestGroupContiguousLeavesUngroupedOrderUntouched(t *testing.T) {
	groups := []string{"", "", ""}
	ranked := []Match{{Index: 2}, {Index: 0}, {Index: 1}}
	got := GroupContiguous(ranked, groups)
	for i := range ranked {
		if got[i].Index != ranked[i].Index {
			t.Fatalf("ungrouped list was reordered: got %+v", got)
		}
	}
}
