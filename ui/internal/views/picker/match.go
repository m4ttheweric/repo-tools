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
