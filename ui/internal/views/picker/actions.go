package picker

import (
	"strings"

	"charm.land/lipgloss/v2"

	"rt-ui/internal/protocol"
	"rt-ui/internal/theme"
)

// Built-in action ids the picker offers even when a request declares no
// registry at all.
const (
	idSelect     = "select"
	idWithArgs   = "with-args"
	idCancel     = "cancel"
	idBack       = "back"
	idToggle     = "toggle"
	idToggleNext = "toggle-next"
	idToggleAll  = "toggle-all"
)

// isInjectedDefaultID reports whether id names one of the built-in defaults
// the picker or the command-tree dispatcher injects. These are keybar
// affordances only: the ctrl-k menu is caller-declared actions, so an
// injected default that reaches deriveMenu (showPicker declares
// select/with-args/back on the wire, so they arrive as m.req.Actions) is
// dropped there rather than listed as if the caller had asked for it.
func isInjectedDefaultID(id string) bool {
	switch id {
	case idSelect, idWithArgs, idCancel, idBack, idToggle, idToggleNext, idToggleAll:
		return true
	}
	return false
}

// defaultActions is what a bare request renders: select always exists, and
// cancel is always the last word (the terminal escape hatch). back is never
// synthesized here -- it is caller-declared only (in the request's own
// Actions), never derived from breadcrumb depth.
func defaultActions(req protocol.PickRequest) []protocol.PickAction {
	if isMultiRequest(req) {
		return multiDefaultActions(req)
	}
	return []protocol.PickAction{
		{ID: idSelect, Label: "select", Key: "enter", Scope: "item"},
		{ID: idCancel, Label: "quit", Key: "esc", Scope: "global"},
	}
}

// multiDefaultActions is the Multi board's "mark" footer cluster. space,
// tab, and ctrl-a never reach the registry dispatch path -- Update handles
// them directly, ahead of actionForKey -- so these entries exist purely to
// put them in the footer legend; MenuHidden keeps them out of the ctrl-k
// menu, since selecting one there would fall through to the generic
// registry dispatch instead of the hardcoded handler the key actually
// runs. enter still dispatches through the registry as idSelect (and does
// belong in the menu, unlike the other three), just labeled "confirm" here
// instead of "select". back is never synthesized here, same as the
// non-multi defaults -- caller-declared only.
func multiDefaultActions(req protocol.PickRequest) []protocol.PickAction {
	return []protocol.PickAction{
		{ID: idToggle, Label: "toggle", Key: "space", Scope: "item", Group: "mark", MenuHidden: true},
		{ID: idToggleNext, Label: "toggle & next", Key: "tab", Scope: "item", Group: "mark", MenuHidden: true},
		{ID: idToggleAll, Label: "all/none", Key: "ctrl-a", Scope: "global", Group: "mark", MenuHidden: true},
		{ID: idSelect, Label: "confirm", Key: "enter", Scope: "item", Group: "mark", Primary: true},
		{ID: idCancel, Label: "quit", Key: "esc", Scope: "global"},
	}
}

// effectiveActions is the request's declared registry plus whichever
// defaults it hasn't already claimed -- by id or by key, so a caller that
// renames "select" or rebinds enter to its own action owns that slot
// instead of getting a duplicate alongside it.
func effectiveActions(req protocol.PickRequest) []protocol.PickAction {
	out := append([]protocol.PickAction(nil), req.Actions...)

	claimedID := make(map[string]bool, len(req.Actions))
	claimedKey := make(map[string]bool, len(req.Actions))
	for _, a := range req.Actions {
		claimedID[a.ID] = true
		if a.Key != "" {
			claimedKey[a.Key] = true
		}
	}

	for _, d := range defaultActions(req) {
		if claimedID[d.ID] || claimedKey[d.Key] {
			continue
		}
		out = append(out, d)
	}
	return out
}

// keybarCluster is one lav-labeled run of key/label pairs in the footer
// legend: a caller-declared group (label set) or the ungrouped run that
// pins to the right (label empty, no lav prefix).
type keybarCluster struct {
	label   string
	actions []protocol.PickAction
}

// keybarClusters splits the keyed actions into the left side's declared
// groups (in first-seen order) and the right side's ungrouped run. The
// built-in defaults land in the ungrouped run unless a caller gives them a
// group of their own, which is what pins back/cancel to the right by
// default. Keyless actions never reach the footer; they are menu-only, and
// FooterHidden actions stay bound but out of the legend the same way.
func keybarClusters(actions []protocol.PickAction) (left []keybarCluster, right []protocol.PickAction) {
	order := make([]string, 0, len(actions))
	byGroup := make(map[string][]protocol.PickAction, len(actions))
	for _, a := range actions {
		if a.Key == "" || a.FooterHidden {
			continue
		}
		if a.Group == "" {
			right = append(right, a)
			continue
		}
		if _, ok := byGroup[a.Group]; !ok {
			order = append(order, a.Group)
		}
		byGroup[a.Group] = append(byGroup[a.Group], a)
	}
	for _, g := range order {
		left = append(left, keybarCluster{label: g, actions: byGroup[g]})
	}
	return left, right
}

// renderKeybarCluster paints one cluster's key/label run: a lav group label
// (skipped when unlabeled) followed by each action's faint key and dim
// label, double-spaced ahead of the next action -- the grammar both the
// Branch and Scrolling boards render.
func renderKeybarCluster(c keybarCluster) string {
	var b strings.Builder
	if c.label != "" {
		b.WriteString(fg(theme.Lav).Render(c.label))
	}
	for i, a := range c.actions {
		if i == 0 {
			if c.label != "" {
				b.WriteString(" ")
			}
		} else {
			b.WriteString("  ")
		}
		b.WriteString(fg(theme.Faint).Render(a.Key))
		b.WriteString(fg(theme.Dim).Render(" " + a.Label))
	}
	return b.String()
}

// renderKeybarLeft joins every declared group's cluster, left to right.
func renderKeybarLeft(groups []keybarCluster) string {
	parts := make([]string, len(groups))
	for i, g := range groups {
		parts[i] = renderKeybarCluster(g)
	}
	return strings.Join(parts, "  ")
}

// keybarLeftMargins is justify's own 2-column left margin plus 1-column
// trailing margin -- the fixed overhead every keybar line's left/right split
// has to divide the remaining width around, budget-wise.
const keybarLeftMargins = 3

// keybarLeftBudget is how many columns the left legend may spend once the
// right-pinned run -- which always renders in full -- has claimed its own
// space, mirroring justify's arithmetic solved for the other side.
func keybarLeftBudget(width int, right string) int {
	budget := width - keybarLeftMargins - lipgloss.Width(right)
	if budget < 0 {
		budget = 0
	}
	return budget
}

// truncateKeybarGroups keeps the longest whole-group prefix of groups that
// fits within avail columns, measured in the same "  "-joined layout
// renderKeybarLeft paints. A group that would only partly fit is dropped in
// full rather than clipped mid-key, so the legend never ends on a broken
// token -- the truncation boundary is a group, never a character.
func truncateKeybarGroups(groups []keybarCluster, avail int) []keybarCluster {
	used, kept := 0, 0
	for i, g := range groups {
		w := lipgloss.Width(renderKeybarCluster(g))
		if i > 0 {
			w += lipgloss.Width("  ")
		}
		if used+w > avail {
			break
		}
		used += w
		kept = i + 1
	}
	return groups[:kept]
}

// keybarRightSep joins the range/held indicator to the ungrouped action run
// on the footer's right side. mouse.go's zone layout reuses this exact
// literal to find where the ungrouped run starts, so the two must never
// drift apart into separately-hand-tuned spacing.
const keybarRightSep = "  ·  "

// renderKeybarRight composes the footer's right-pinned side: the scroll
// range (when the list overflows the viewport) and the ungrouped action
// run, separated by a faint middle dot when both are present -- the
// Scrolling board's footer integration.
func renderKeybarRight(rangeText, actionsText string) string {
	switch {
	case rangeText == "":
		return actionsText
	case actionsText == "":
		return rangeText
	default:
		return rangeText + fg(theme.Faint).Render(keybarRightSep) + actionsText
	}
}

// MenuRow is one row of a ctrl-k / right-click menu: either an action
// (ActionID set) or the rule separating item-scope rows from global ones
// (Rule true, every other field zero). The modal that paints these rows is
// built separately; this only orders and shapes the data.
type MenuRow struct {
	ActionID string
	Label    string
	Key      string
	Rule     bool
}

// deriveMenu orders a ctrl-k/right-click menu's rows from the action
// registry: item-scope actions (the row under the cursor) first, in
// declaration order, then a rule, then global-scope actions -- keyless
// actions included, since the menu is the only surface that shows them.
// cursorRow < 0 means there is no row to act on, so the item half is
// dropped entirely rather than rendering an empty section above the rule.
// MenuHidden actions never become a row here regardless of scope: the menu
// dispatches whatever it shows through the generic registry path, which
// would mis-fire for an action a hardcoded key already owns. An injected
// default id (select/with-args/back/cancel and the multi mark cluster) is
// excluded the same way, so the dispatcher's own select/with-args/back never
// list as menu rows and a request that declares nothing opens no menu at all.
func deriveMenu(actions []protocol.PickAction, cursorRow int) []MenuRow {
	var item, global []MenuRow
	for _, a := range actions {
		if a.MenuHidden || isInjectedDefaultID(a.ID) {
			continue
		}
		row := MenuRow{ActionID: a.ID, Label: a.Label, Key: a.Key}
		switch a.Scope {
		case "item":
			if cursorRow >= 0 {
				item = append(item, row)
			}
		case "global":
			global = append(global, row)
		}
	}
	rows := item
	if len(item) > 0 && len(global) > 0 {
		rows = append(rows, MenuRow{Rule: true})
	}
	return append(rows, global...)
}
