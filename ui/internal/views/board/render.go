package board

import (
	"fmt"
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"

	"rt-ui/internal/theme"
)

const (
	nameW  = 10
	pkgW   = 24
	rightW = 9
	tailN  = 6
)

var onBg = lipgloss.NewStyle().Background(theme.Bg)

func fg(c color.Color) lipgloss.Style {
	return onBg.Foreground(c)
}

func render(b *Board) string {
	if b.width == 0 {
		return ""
	}
	top := []string{header(b), rule(b.width)}
	if len(b.model.Entries) == 0 {
		top = append(top, emptyState(b.width))
	}
	for i := range b.model.Entries {
		top = append(top, row(b, i))
	}
	if b.tailOpen {
		if e := b.selectedEntry(); e != nil {
			top = append(top, tailBox(b, e))
		}
	}
	var bottom string
	if b.confirm {
		bottom = confirmLayer(b)
	} else {
		bottom = lipgloss.JoinVertical(lipgloss.Left, rule(b.width), keybar(b))
	}
	body := lipgloss.Place(b.width, b.height-lipgloss.Height(bottom), lipgloss.Left, lipgloss.Top,
		lipgloss.JoinVertical(lipgloss.Left, top...), lipgloss.WithWhitespaceStyle(onBg))
	return lipgloss.JoinVertical(lipgloss.Left, body, bottom)
}

func header(b *Board) string {
	left := fg(theme.Text).Bold(true).Render("rt runner") + fg(theme.Faint).Render(" · ") + fg(theme.Dimmer).Render(b.model.Workspace)
	var counts []string
	if n := b.count("running"); n > 0 {
		counts = append(counts, fg(theme.Mint).Render(fmt.Sprintf("● %d running", n)))
	}
	if n := b.count("stopped"); n > 0 {
		counts = append(counts, fg(theme.Dim).Render(fmt.Sprintf("○ %d stopped", n)))
	}
	if n := b.count("crashed"); n > 0 {
		counts = append(counts, fg(theme.Coral).Render(fmt.Sprintf("✗ %d crashed", n)))
	}
	if len(b.model.Entries) == 0 {
		counts = append(counts, fg(theme.Faint).Render("0 commands"))
	}
	return justify(b.width, left, strings.Join(counts, fg(theme.Faint).Render(" · ")))
}

func rule(width int) string {
	return fg(theme.Rule).Render(strings.Repeat("─", width))
}

func emptyState(width int) string {
	lines := []string{
		"",
		fg(theme.TextSoft).Render("  Nothing running."),
		fg(theme.Dimmer).Render("  Press ") + fg(theme.PinkSoft).Render("a") + fg(theme.Dimmer).Render(" to add a command."),
	}
	return lipgloss.JoinVertical(lipgloss.Left, lines...)
}

func row(b *Board, i int) string {
	e := b.model.Entries[i]
	sel := e.ID == b.selected
	bg := theme.Bg
	nameC, cmdC := theme.Text, theme.Dim
	if sel {
		bg = theme.SelBg
		nameC, cmdC = theme.PinkSoft, theme.TextSoft
	}
	on := lipgloss.NewStyle().Background(bg)
	prefix := on.Render("  ")
	if sel {
		prefix = on.Foreground(theme.Pink).Render("▌ ")
	}
	glyph, glyphC := "●", theme.Mint
	right, rightC := e.uptime(b.now), theme.TextSoft
	switch e.State {
	case "stopped":
		glyph, glyphC = "○", theme.Dim
		right, rightC = "stopped", theme.Dimmer
	case "crashed":
		glyph, glyphC = "✗", theme.Coral
		right, rightC = fmt.Sprintf("exited %d", deref(e.ExitCode)), theme.Coral
	case "starting":
		glyph, glyphC = b.spin.View(), theme.Mint
		right, rightC = "starting", theme.Dimmer
	case "stopping":
		glyph, glyphC = b.spin.View(), theme.Coral
		right, rightC = "stopping", theme.Dimmer
	}
	if e.Error != nil {
		right, rightC = clip(*e.Error, rightW), theme.Coral
	}
	cmdW := b.width - (2 + 1 + 2 + nameW + 2 + 2 + pkgW + 2 + rightW + 1)
	if cmdW < 4 {
		cmdW = 4
	}
	return prefix +
		on.Foreground(glyphC).Render(glyph) + on.Render("  ") +
		on.Foreground(nameC).Width(nameW).Render(clip(e.Name, nameW)) + on.Render("  ") +
		on.Foreground(cmdC).Width(cmdW).Render(clip(e.Command, cmdW)) + on.Render("  ") +
		on.Foreground(theme.Faint).Width(pkgW).Render(clip(e.Pkg+" · "+e.Repo, pkgW)) + on.Render("  ") +
		on.Foreground(rightC).Width(rightW).Align(lipgloss.Right).Render(right) + on.Render(" ")
}

func tailBox(b *Board, e *Entry) string {
	title := fg(theme.Cyan).Render("tail") + fg(theme.Faint).Render(" · ") + fg(theme.TextSoft).Render(e.Name)
	rightT := fg(theme.Faint).Render("refreshing 1s")
	border := fg(theme.Panel)
	fill := b.width - 8 - lipgloss.Width(title) - lipgloss.Width(rightT)
	if fill < 0 {
		fill = 0
	}
	top := border.Render("╭─ ") + title + border.Render(" "+strings.Repeat("─", fill)+" ") + rightT + border.Render(" ─╮")
	lines := e.Tail
	if len(lines) > tailN {
		lines = lines[len(lines)-tailN:]
	}
	inner := b.width - 4
	var body []string
	for _, l := range lines {
		text := fg(theme.Faint).Render(l.TS+" ") + fg(theme.TextSoft).Render(l.Text)
		body = append(body, onBg.Width(inner).Render(clip(text, inner)))
	}
	for len(body) < tailN {
		body = append(body, onBg.Width(inner).Render(""))
	}
	boxed := onBg.Border(lipgloss.RoundedBorder()).BorderTop(false).BorderForeground(theme.Panel).BorderBackground(theme.Bg).Padding(0, 1).
		Render(strings.Join(body, "\n"))
	return lipgloss.JoinVertical(lipgloss.Left, top, boxed)
}

func keybar(b *Board) string {
	group := fg(theme.Lav)
	key := func(k, l string) string {
		return fg(theme.Faint).Render(k) + onBg.Render(" ") + fg(theme.Dim).Render(l)
	}
	left := group.Render("navigate") + onBg.Render(" ") + key("j/k", "up·down") + onBg.Render("   ") +
		group.Render("process") + onBg.Render(" ") + strings.Join([]string{key("a", "add"), key("s", "restart"), key("x", "stop"), key("f", "focus"), key("t", "tail")}, onBg.Render("  "))
	return justify(b.width, left, key("q", "quit"))
}

func confirmLayer(b *Board) string {
	on := lipgloss.NewStyle().Background(theme.WarnBg)
	n := b.count("running") + b.count("starting")
	left := on.Foreground(theme.Peach).Render("⚠ ") + on.Foreground(theme.Text).Render(fmt.Sprintf("Quit and stop %d running processes?", n))
	right := on.Foreground(theme.Pink).Bold(true).Render("y") + on.Render(" ") + on.Foreground(theme.Dim).Render("yes, stop all") + on.Render("   ") +
		on.Foreground(theme.Dim).Bold(true).Render("n") + on.Render(" ") + on.Foreground(theme.Dim).Render("keep running")
	inner := b.width - 4
	line := left + lipgloss.PlaceHorizontal(inner-lipgloss.Width(left), lipgloss.Right, right, lipgloss.WithWhitespaceStyle(on))
	return on.Border(lipgloss.RoundedBorder()).BorderForeground(theme.Peach).BorderBackground(theme.WarnBg).Padding(0, 1).Render(line)
}

func justify(width int, left, right string) string {
	avail := width - 3 - lipgloss.Width(left)
	if avail < 0 {
		avail = 0
	}
	return onBg.Render("  ") + left + lipgloss.PlaceHorizontal(avail, lipgloss.Right, right, lipgloss.WithWhitespaceStyle(onBg)) + onBg.Render(" ")
}

func clip(s string, w int) string {
	return lipgloss.NewStyle().Inline(true).MaxWidth(w).Render(s)
}

func deref(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}
