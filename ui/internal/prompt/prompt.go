// Package prompt renders the four one-shot kinds on huh inside rt's card.
// The keybind header is composed here from the spec's kind and back row;
// TS never sends key text.
package prompt

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/colorprofile"

	"rt-ui/internal/protocol"
	"rt-ui/internal/theme"
	"rt-ui/internal/tty"
)

type Outcome int

const (
	Answered Outcome = iota
	Cancelled
	Back
)

const backValue = "\x00rt-ui:back"

// legend is the key line under the title. Go composes it from the kind and
// whether a back row exists; TS never sends key text.
func legend(spec protocol.PromptSpec) string {
	switch spec.Kind {
	case "multiselect":
		return "space: toggle   enter: confirm   esc: cancel"
	case "confirm":
		return "y: yes   n: no   esc: cancel"
	case "text":
		return "enter: submit   esc: cancel"
	}
	if spec.Back != nil {
		return "enter: select   ctrl-up: back   esc: cancel"
	}
	return "enter: select   esc: cancel"
}

// Run paints the prompt on term and returns the answer. Cancelled and Back
// are outcomes, not errors; err is reserved for the terminal or huh failing,
// and for ctx being cancelled (the parent died: Bubble Tea shuts down and
// restores the terminal before Run returns).
func Run(ctx context.Context, spec protocol.PromptSpec, term *os.File) (protocol.Result, Outcome, error) {
	var (
		result  protocol.Result
		backHit bool
		// harvest reads the field's bound value once the form has run. Not a
		// defer: Go copies the return values first, so a defer's writes to
		// result and backHit would never reach the caller.
		harvest func()
		field   huh.Field
		th      = theme.Huh()
	)

	switch spec.Kind {
	case "select":
		var v string
		opts := make([]huh.Option[string], 0, len(spec.Options)+1)
		if spec.Back != nil {
			opts = append(opts, huh.NewOption(theme.GlyphBack+" "+spec.Back.Label, backValue))
		}
		for _, o := range spec.Options {
			opts = append(opts, huh.NewOption(optionLabel(o), o.Value))
		}
		v = spec.Initial
		if v == "" && len(spec.Options) > 0 {
			v = spec.Options[0].Value
		}
		field = huh.NewSelect[string]().Description(spec.Hint).Options(opts...).Value(&v)
		harvest = func() {
			if v == backValue {
				backHit = true
				return
			}
			result.Value = &v
		}
	case "multiselect":
		v := append([]string(nil), spec.InitialMany...)
		opts := make([]huh.Option[string], 0, len(spec.Options))
		for _, o := range spec.Options {
			opt := huh.NewOption(optionLabel(o), o.Value)
			for _, sel := range spec.InitialMany {
				if sel == o.Value {
					opt = opt.Selected(true)
				}
			}
			opts = append(opts, opt)
		}
		ms := huh.NewMultiSelect[string]().Description(spec.Hint).Options(opts...).Value(&v)
		if spec.Max != nil {
			ms = ms.Limit(*spec.Max)
		}
		if spec.Min != nil {
			atLeast := *spec.Min
			ms = ms.Validate(func(picked []string) error {
				if len(picked) < atLeast {
					return fmt.Errorf("pick at least %d", atLeast)
				}
				return nil
			})
		}
		field = ms
		harvest = func() {
			result.Values = v
			if result.Values == nil {
				result.Values = []string{}
			}
		}
	case "confirm":
		// A destructive confirm defaults to no unless the spec says yes outright.
		destructive := spec.Destructive != nil && *spec.Destructive
		v := spec.Default != nil && *spec.Default
		if !destructive && spec.Default == nil {
			v = true
		}
		if destructive {
			th = theme.HuhDestructive()
		}
		// The group title already carries the message; an inline confirm draws
		// only its buttons beside it.
		field = huh.NewConfirm().Description(spec.Hint).Affirmative("yes").Negative("no").Inline(true).Value(&v)
		harvest = func() { result.OK = &v }
	case "text":
		v := spec.Initial
		in := huh.NewInput().Description(spec.Hint).Placeholder(spec.Placeholder).Value(&v)
		if spec.Validate != nil {
			re, err := regexp.Compile(spec.Validate.Pattern)
			if err != nil {
				return result, Answered, fmt.Errorf("%w: validate.pattern: %v", protocol.ErrBadSpec, err)
			}
			msg := spec.Validate.Message
			in = in.Validate(func(s string) error {
				if !re.MatchString(s) {
					return errors.New(msg)
				}
				return nil
			})
		}
		field = in
		harvest = func() { result.Text = &v }
	default:
		return result, Answered, fmt.Errorf("%w: kind %q", protocol.ErrBadSpec, spec.Kind)
	}

	km := huh.NewDefaultKeyMap()
	km.Quit = key.NewBinding(key.WithKeys("ctrl+c", "esc"))

	// eraseCard needs the height of the last frame huh painted. The view hook
	// runs on every render, before huh's content reaches the view, so it is the
	// one place that height is knowable from the outside.
	var form *huh.Form
	cardHeight := 0
	viewHook := func(v tea.View) tea.View {
		if content := form.View(); content != "" {
			cardHeight = lipgloss.Height(content)
		}
		return v
	}

	var backRequested bool
	filter := func(_ tea.Model, msg tea.Msg) tea.Msg {
		switch m := msg.(type) {
		case tea.KeyPressMsg:
			// Back leaves by the same door cancel does, so huh marks itself
			// aborted either way and the exit path stays single.
			if m.String() == "ctrl+up" && spec.Back != nil {
				backRequested = true
				return tea.KeyPressMsg{Code: tea.KeyEscape}
			}
		case tea.InterruptMsg:
			// huh cancels with tea.Interrupt, which ends the program as
			// killed and skips its final flush. QuitMsg keeps the graceful
			// path, so the terminal is restored the same way an answer does it.
			return tea.QuitMsg{}
		}
		return msg
	}

	title := spec.Title
	if spec.Kind == "confirm" {
		title = spec.Message
	}
	group := huh.NewGroup(field).Title(title).Description(legend(spec)).WithShowHelp(false)
	// WithProgramOptions replaces huh's option slice rather than appending, so
	// it has to precede WithInput/WithOutput or the UI silently lands on
	// stdout, which the protocol owns.
	form = huh.NewForm(group).
		WithTheme(th).
		WithKeyMap(km).
		WithShowHelp(false).
		WithViewHook(viewHook).
		WithProgramOptions(tea.WithColorProfile(colorprofile.TrueColor), tea.WithFilter(filter)).
		WithInput(term).
		WithOutput(term)

	tty.FirstPaint()
	err := form.RunWithContext(ctx)
	eraseCard(term, cardHeight)
	switch {
	case ctx.Err() != nil:
		return result, Answered, ctx.Err()
	case backRequested:
		return result, Back, nil
	case errors.Is(err, huh.ErrUserAborted), errors.Is(err, tea.ErrInterrupted):
		return result, Cancelled, nil
	case err != nil:
		return result, Answered, err
	}
	harvest()
	if backHit {
		return result, Back, nil
	}
	if spec.Kind == "confirm" {
		writeCollapsed(term, spec.Message, result.OK != nil && *result.OK)
	}
	return result, Answered, nil
}

func optionLabel(o protocol.Option) string {
	if o.Hint == "" {
		return o.Label
	}
	return o.Label + "  " + lipgloss.NewStyle().Foreground(theme.Faint).Render(o.Hint)
}

// eraseCard removes the prompt card from the terminal. Bubble Tea's inline
// renderer clamps its cursor model to the new frame height whenever a frame
// shrinks, so the empty view it flushes on quit erases only the card's last
// row, wherever the cursor already sat. Every remaining row is torn down here,
// leaving the cursor where the card began: whatever rt prints next takes the
// card's place instead of pushing the user's scrollback around.
func eraseCard(term *os.File, height int) {
	if height == 0 {
		return
	}
	if height > 1 {
		fmt.Fprintf(term, "\x1b[%dA", height-1)
	}
	fmt.Fprint(term, "\r\x1b[J")
}

// The answered confirm collapses to one line so scrollback keeps a record
// without the prompt chrome. eraseCard has already put the cursor on the row
// the card started at, so this only writes the line; moving the cursor up
// here would eat the user's previous output.
func writeCollapsed(term *os.File, message string, ok bool) {
	answer := "no"
	if ok {
		answer = "yes"
	}
	line := lipgloss.NewStyle().Foreground(theme.Mint).Render(theme.GlyphDone) + " " +
		lipgloss.NewStyle().Foreground(theme.Dim).Render(message) + " " +
		lipgloss.NewStyle().Foreground(theme.TextSoft).Render(answer)
	fmt.Fprint(term, "\r\x1b[2K"+line+"\n")
}
