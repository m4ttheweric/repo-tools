// Package picker provides a headless wrapper around fzf's ranking algorithm
// so the board picker can rank and highlight rows without spawning fzf.
package picker

import (
	"sort"
	"strings"
	"sync"

	"github.com/junegunn/fzf/src/algo"
	"github.com/junegunn/fzf/src/util"
)

// Match is one target's rank result: its original index, its fzf score, and
// the byte positions (ascending, matching Positions in fzf's own terminal.go)
// that should be highlighted.
type Match struct {
	Index     int
	Score     int
	Positions []int
}

var algoInit sync.Once

// algo.Init mutates package-level scoring tables; every call site must run
// through the same scheme exactly once or later calls silently no-op.
func initAlgo() {
	algoInit.Do(func() {
		algo.Init("default")
	})
}

// Rank scores targets against query using fzf's FuzzyMatchV2 (or
// ExactMatchNaive when exact is true) and returns them sorted by score
// descending, ties broken by original index ascending for stability.
// An empty query short-circuits to all rows in their original order with
// no positions, matching fzf's own "no filter" behavior.
func Rank(query string, targets []string, exact bool) []Match {
	matches := make([]Match, 0, len(targets))

	if query == "" {
		for i := range targets {
			matches = append(matches, Match{Index: i})
		}
		return matches
	}

	initAlgo()

	// fzf assumes the pattern is pre-lowered when caseSensitive is false;
	// lowering the target too keeps matching purely case-insensitive since
	// smart-case is out of scope here.
	pattern := []rune(strings.ToLower(query))

	matchFn := algo.FuzzyMatchV2
	if exact {
		matchFn = algo.ExactMatchNaive
	}

	for i, target := range targets {
		chars := util.ToChars([]byte(strings.ToLower(target)))
		result, pos := matchFn(false, true, true, &chars, pattern, true, nil)
		if result.Score == 0 {
			continue
		}

		var positions []int
		if pos != nil {
			positions = *pos
			sort.Ints(positions)
		}

		matches = append(matches, Match{Index: i, Score: result.Score, Positions: positions})
	}

	sort.SliceStable(matches, func(a, b int) bool {
		return matches[a].Score > matches[b].Score
	})

	return matches
}

// GroupContiguous reorders ranked matches so every group's matched rows form
// one contiguous block, so the list renders one header per group instead of
// fuzzy score interleaving a group and repeating its header down the list.
// groups[i] is the group label of original row i, the label a match's Index
// reads back into. Blocks follow the caller's group order -- each group's
// first appearance in groups -- so a pinned group (run's queue ahead of
// packages) holds the top even when a later group out-scores it; within a
// block the incoming Rank score order is kept, best first. Rows with an empty
// label collapse into their own block the same way. One distinct group (or
// none) returns matches unchanged.
func GroupContiguous(matches []Match, groups []string) []Match {
	order := make(map[string]int)
	for _, g := range groups {
		if _, seen := order[g]; !seen {
			order[g] = len(order)
		}
	}
	if len(order) <= 1 {
		return matches
	}
	buckets := make([][]Match, len(order))
	for _, mt := range matches {
		slot := order[groups[mt.Index]]
		buckets[slot] = append(buckets[slot], mt)
	}
	out := make([]Match, 0, len(matches))
	for _, b := range buckets {
		out = append(out, b...)
	}
	return out
}
