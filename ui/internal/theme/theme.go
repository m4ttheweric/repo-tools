// Package theme is the rt-ui token sheet: lib/tui/palette.ts in Go. Every
// color and glyph rt-ui paints comes from here; nothing crosses the wire.
package theme

import (
	"fmt"
	"image/color"

	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"
)

var (
	Bg       = lipgloss.Color("#161224")
	BgSubtle = lipgloss.Color("#1C162C")
	SelBg    = lipgloss.Color("#37284B")
	WarnBg   = lipgloss.Color("#2A2033")
	Rule     = lipgloss.Color("#2A2340")
	Panel    = lipgloss.Color("#34304E")

	Pink     = lipgloss.Color("#FF6B9D")
	PinkSoft = lipgloss.Color("#FF9EC0")
	Mint     = lipgloss.Color("#62E6A8")
	Coral    = lipgloss.Color("#FF7979")
	Peach    = lipgloss.Color("#FFB77A")
	Cyan     = lipgloss.Color("#5AAAFF")
	Lav      = lipgloss.Color("#BD93F9")

	Text     = lipgloss.Color("#E6E0FF")
	TextSoft = lipgloss.Color("#D2CDEB")
	Dim      = lipgloss.Color("#A8A0C6")
	Dimmer   = lipgloss.Color("#8B84A8")
	Faint    = lipgloss.Color("#6E668C")
)

const (
	GlyphRunning = "●"
	GlyphStopped = "○"
	GlyphCrashed = "✗"
	GlyphBar     = "▌"
	GlyphChevron = "❯"
	GlyphOn      = "◉"
	GlyphDone    = "✓"
	GlyphWarn    = "⚠"
	GlyphBack    = "↩"
)

var SpinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"}

// CardWidth caps the prompt card so it reads as a card on a wide terminal
// rather than a stripe across it. The fzf pickers stay full width: fzf has no
// max-width, and a fixed --margin collapses the box when the window narrows.
const CardWidth = 88

// Hex renders a palette color back as #RRGGBB; used by tests and the --version banner.
func Hex(c color.Color) string {
	r, g, b, _ := c.RGBA()
	return fmt.Sprintf("#%02X%02X%02X", r>>8, g>>8, b>>8)
}

// Huh returns the huh theme that makes its four fields paint with rt's tokens.
// The form base is the prompt card: a rounded pink border, the same frame rt's
// fzf pickers draw (--border=rounded). It has to live there because huh renders
// Group.Base around the group footer alone, which would frame an empty box
// under the prompt instead of framing the prompt. The group title is the prompt
// title and the group description is the key legend Go composes.
func Huh() huh.Theme { return themed(Pink) }

// HuhDestructive is the same card with peach accents: the default-no confirm.
func HuhDestructive() huh.Theme { return themed(Peach) }

// CardFrame is how many columns the card's border and padding occupy. huh sizes
// its groups from the terminal width and knows nothing about the form base
// wrapped around them, so a layout has to hand back this much less.
func CardFrame() int { return themed(Pink).Theme(true).Form.Base.GetHorizontalFrameSize() }

func themed(accent color.Color) huh.Theme {
	return huh.ThemeFunc(func(isDark bool) *huh.Styles {
		s := huh.ThemeBase(isDark)
		base := lipgloss.NewStyle()
		s.Form.Base = base.Border(lipgloss.RoundedBorder()).BorderForeground(accent).Padding(0, 1)
		s.Group.Base = base
		s.Group.Title = base.Foreground(accent)
		s.Group.Description = base.Foreground(Faint)
		s.Focused.Base = base
		s.Blurred.Base = base
		s.Focused.Title = base.Foreground(Text).Bold(true)
		s.Blurred.Title = base.Foreground(Dim)
		s.Focused.Description = base.Foreground(Faint)
		s.Blurred.Description = base.Foreground(Faint)
		s.Focused.ErrorMessage = base.Foreground(Coral)
		s.Focused.ErrorIndicator = base.Foreground(Coral)
		s.Focused.SelectSelector = base.Foreground(Pink).SetString(GlyphBar + " ")
		s.Focused.Option = base.Foreground(Text)
		s.Focused.MultiSelectSelector = base.Foreground(Pink).SetString(GlyphBar + " ")
		s.Focused.SelectedOption = base.Foreground(PinkSoft)
		s.Focused.SelectedPrefix = base.Foreground(Mint).SetString(GlyphOn + " ")
		s.Focused.UnselectedOption = base.Foreground(Text)
		s.Focused.UnselectedPrefix = base.Foreground(Faint).SetString(GlyphStopped + " ")
		s.Focused.FocusedButton = base.Foreground(Bg).Background(accent).Bold(true).Padding(0, 1)
		s.Focused.BlurredButton = base.Foreground(Dim).Padding(0, 1)
		s.Focused.TextInput.Cursor = base.Foreground(accent)
		s.Focused.TextInput.Placeholder = base.Foreground(Faint)
		s.Focused.TextInput.Prompt = base.Foreground(accent).SetString(GlyphChevron + " ")
		s.Focused.TextInput.Text = base.Foreground(Text)
		s.Help.ShortKey = base.Foreground(Faint)
		s.Help.ShortDesc = base.Foreground(Dim)
		s.Help.ShortSeparator = base.Foreground(Faint)
		return s
	})
}
