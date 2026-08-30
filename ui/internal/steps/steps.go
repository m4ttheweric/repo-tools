// Package steps renders one step: a spinner line while the parent works,
// then a final ✓/✗ line. The tty is write-only and cooked, so Ctrl-C stays a
// signal to the whole group and the parent's own SIGINT handling runs.
package steps

import (
	"fmt"
	"os"
	"time"

	"charm.land/lipgloss/v2"

	"rt-ui/internal/protocol"
	"rt-ui/internal/theme"
	"rt-ui/internal/tty"
)

type Outcome int

const (
	Done Outcome = iota
	Failed
	Interrupted // parent went away (stdin EOF)
	Signalled   // SIGINT/SIGTERM/SIGHUP reached us
)

const frameEvery = 80 * time.Millisecond

var (
	spinStyle = lipgloss.NewStyle().Foreground(theme.Mint)
	textStyle = lipgloss.NewStyle().Foreground(theme.Text)
	hintStyle = lipgloss.NewStyle().Foreground(theme.Faint)
	okGlyph   = lipgloss.NewStyle().Foreground(theme.Mint).Render(theme.GlyphDone)
	badGlyph  = lipgloss.NewStyle().Foreground(theme.Coral).Render(theme.GlyphCrashed)
	warnGlyph = lipgloss.NewStyle().Foreground(theme.Peach).Render(theme.GlyphWarn)
	infoGlyph = lipgloss.NewStyle().Foreground(theme.Faint).Render("•")
)

// Run consumes events until done/fail, the channel closes (parent gone), or
// a signal arrives. The spinner line is only ever painted once the first
// frame tick fires, so a step that finishes inside 80 ms paints its final
// line and nothing else.
func Run(events <-chan protocol.StepEvent, signals <-chan os.Signal, term *os.File) Outcome {
	var title string
	painted := false
	frame := 0
	ticker := time.NewTicker(frameEvery)
	defer ticker.Stop()

	clearActive := func() {
		if painted {
			fmt.Fprint(term, "\r\x1b[2K")
		}
	}
	final := func(glyph, t, hint string) {
		clearActive()
		line := "  " + glyph + " " + textStyle.Render(t)
		if hint != "" {
			line += "  " + hintStyle.Render(hint)
		}
		fmt.Fprint(term, line+"\n")
	}

	for {
		select {
		case <-ticker.C:
			if title == "" {
				continue
			}
			if !painted {
				tty.FirstPaint()
			}
			painted = true
			f := theme.SpinnerFrames[frame%len(theme.SpinnerFrames)]
			frame++
			fmt.Fprint(term, "\r\x1b[2K  "+spinStyle.Render(f)+" "+textStyle.Render(title))
		case <-signals:
			if title != "" {
				final(badGlyph, title, "interrupted")
			}
			return Signalled
		case ev, ok := <-events:
			if !ok {
				if title != "" {
					final(badGlyph, title, "interrupted")
				}
				return Interrupted
			}
			switch ev.T {
			case "start":
				title = ev.Title
			case "log":
				clearActive()
				g := infoGlyph
				switch ev.Level {
				case "warn":
					g = warnGlyph
				case "error":
					g = badGlyph
				case "success":
					g = okGlyph
				}
				fmt.Fprint(term, "  "+g+" "+textStyle.Render(ev.Text)+"\n")
				painted = false
			case "done":
				t := ev.Title
				if t == "" {
					t = title
				}
				final(okGlyph, t, ev.Hint)
				return Done
			case "fail":
				t := ev.Title
				if t == "" {
					t = title
				}
				final(badGlyph, t, ev.Hint)
				return Failed
			}
		}
	}
}
