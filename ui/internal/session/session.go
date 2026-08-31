// Package session runs one alt-screen view for as long as the parent keeps
// the conversation open: hello first, then a view opened by the parent's
// first line, models replaced wholesale, intents emitted as the user acts.
package session

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/colorprofile"

	"rt-ui/internal/protocol"
)

type Reason string

const (
	ReasonQuit   Reason = "quit"
	ReasonCancel Reason = "cancel"
	ReasonClosed Reason = "closed"
	ReasonError  Reason = "error"
)

// ModelUpdate carries a full replacement model into the view.
type ModelUpdate struct{ Raw json.RawMessage }

// CloseRequest is the parent asking the view to leave the screen.
type CloseRequest struct{}

// View is what a view kind implements on top of tea.Model. Reason is read
// after the program returns to decide the closed line and exit code.
type View interface {
	tea.Model
	SetModel(raw json.RawMessage) error
	Reason() Reason
}

// Emitter serializes intent writes; Bubble Tea commands run concurrently and
// never wait on each other, so an intent that must land before the closed
// line (a "quit" intent, above all) MUST be issued as
// tea.Sequence(emit, ..., tea.Quit), never as a bare or batched Cmd raced
// against an independent Quit elsewhere: Sequence is the only construct here
// that runs its Cmds strictly in order on one goroutine, so it is the only
// way to guarantee a write happens before the Quit that follows it.
// TestViewQuitEmitsClosedQuit is the regression test for this contract.
type Emitter struct {
	mu sync.Mutex
	w  io.Writer
}

func (e *Emitter) Emit(in protocol.Intent) tea.Cmd {
	return func() tea.Msg {
		e.mu.Lock()
		defer e.mu.Unlock()
		_, _ = e.w.Write(protocol.EncodeIntent(in))
		return nil
	}
}

// ErrBadOpen is a protocol error before any view ran: exit 2.
var ErrBadOpen = errors.New("bad open")

// Run speaks the session protocol on in/out and paints the view on term.
// views is the list the hello advertises; viewName is the one this process
// was started for. The returned reason is what the closed line carried;
// stdinEOF says whether the loop ended because the parent went away.
func Run(ctx context.Context, viewName string, views []string, mk func(*Emitter) View, in io.Reader, out io.Writer, term *os.File, version string) (reason Reason, stdinEOF bool, err error) {
	em := &Emitter{w: out}
	closed := func(r Reason, msg string) {
		em.mu.Lock()
		defer em.mu.Unlock()
		_, _ = out.Write(protocol.EncodeClosed(protocol.Closed{Reason: string(r), Message: msg}))
	}

	if _, err := out.Write(protocol.EncodeHello(version, views)); err != nil {
		return ReasonError, false, err
	}

	r := bufio.NewReader(in)

	// The blocking read for the open line has nothing else to select on, so
	// a signal arriving in this window (cancelling ctx) would otherwise sit
	// unobserved forever: run the read on its own goroutine and race it
	// against ctx.Done() so an external kill before open still produces
	// closed{cancel} instead of a hang. The goroutine leaks harmlessly on
	// that path: nobody else reads r afterward and the process is exiting.
	type firstLine struct {
		line []byte
		err  error
	}
	firstCh := make(chan firstLine, 1)
	go func() {
		line, err := protocol.ReadLine(r)
		firstCh <- firstLine{line, err}
	}()

	var first []byte
	select {
	case res := <-firstCh:
		first, err = res.line, res.err
	case <-ctx.Done():
		closed(ReasonCancel, "")
		return ReasonCancel, false, nil
	}
	if err != nil {
		// EOF here is the parent dying before it ever sent open, the same
		// "parent died" row as an EOF after open: exit 70, not the exit-2
		// protocol error, which is reserved for a wrong or malformed open
		// actually received over the wire.
		closed(ReasonError, "stdin closed before open")
		return ReasonError, true, err
	}
	kind, raw, err := protocol.DecodeSessionLine(first)
	if err != nil || kind != "open" {
		closed(ReasonError, "first line must be open")
		return ReasonError, false, ErrBadOpen
	}
	var open protocol.Open
	if err := json.Unmarshal(raw, &open); err != nil || open.View != viewName {
		closed(ReasonError, fmt.Sprintf("view %q is not %q", open.View, viewName))
		return ReasonError, false, ErrBadOpen
	}
	view := mk(em)
	if view == nil {
		closed(ReasonError, "unknown view "+viewName)
		return ReasonError, false, ErrBadOpen
	}
	if err := view.SetModel(open.Model); err != nil {
		closed(ReasonError, "bad model: "+err.Error())
		return ReasonError, false, ErrBadOpen
	}

	// Signals are ours (see WithoutSignalHandler): the parent's cancel and an
	// external kill both end the program through ctx, which restores termios.
	p := tea.NewProgram(view,
		tea.WithInput(term),
		tea.WithOutput(term),
		tea.WithContext(ctx),
		tea.WithColorProfile(colorprofile.TrueColor),
		tea.WithoutSignalHandler(),
	)

	// A close line ends the reader: the parent may end stdin right after it,
	// and that EOF must never be mistaken for a dead parent.
	var eof atomic.Bool
	go func() {
		for {
			line, err := protocol.ReadLine(r)
			if err != nil {
				eof.Store(true)
				p.Send(CloseRequest{})
				return
			}
			kind, raw, err := protocol.DecodeSessionLine(line)
			if err != nil {
				continue
			}
			switch kind {
			case "model":
				var m protocol.ModelMsg
				if json.Unmarshal(raw, &m) == nil {
					p.Send(ModelUpdate{Raw: m.Model})
				}
			case "close":
				p.Send(CloseRequest{})
				return
			}
		}
	}()

	_, runErr := p.Run()
	switch {
	case eof.Load():
		closed(ReasonError, "stdin closed")
		return ReasonError, true, nil
	case ctx.Err() != nil, errors.Is(runErr, tea.ErrInterrupted):
		closed(ReasonCancel, "")
		return ReasonCancel, false, nil //nolint:nilerr // intentional: ReasonCancel carries the outcome, not the error
	case runErr != nil:
		closed(ReasonError, runErr.Error())
		return ReasonError, false, runErr
	}
	rs := view.Reason()
	closed(rs, "")
	return rs, false, nil
}

// ExitCode maps a reason to the contract: quit/closed 0, cancel 130, error 70
// for a dead parent and 2 for a protocol error. The 2-vs-70 split rides
// entirely on ErrBadOpen and r; Run's stdinEOF return is for callers that
// want to log or test the distinction, not for this mapping.
func ExitCode(r Reason, err error) int {
	switch {
	case errors.Is(err, ErrBadOpen):
		return 2
	case r == ReasonCancel:
		return 130
	case r == ReasonError:
		return 70
	}
	return 0
}
