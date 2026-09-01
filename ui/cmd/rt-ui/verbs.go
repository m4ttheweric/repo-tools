package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"

	"rt-ui/internal/prompt"
	"rt-ui/internal/protocol"
	"rt-ui/internal/session"
	"rt-ui/internal/steps"
	"rt-ui/internal/tty"
	"rt-ui/internal/views/board"
	"rt-ui/internal/views/picker"
)

const protocolVersion = protocol.Version

func runPrompt() int {
	line, err := protocol.ReadLine(bufio.NewReader(os.Stdin))
	if err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui prompt: no spec on stdin")
		return ExitBadSpec
	}
	spec, err := protocol.DecodePrompt(line)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui prompt:", err)
		return ExitBadSpec
	}
	term, err := tty.Open(tty.ReadWrite)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui prompt:", err)
		return ExitInternal
	}
	defer term.Close()

	// The parent closing stdin is the only EOF we can ever see. Cancelling the
	// context shuts Bubble Tea down on its own thread, which is the only path
	// that restores termios; os.Exit from this goroutine would skip it and
	// leave the shell in raw mode.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tty.WatchStdinEOF(cancel)

	// Bubble Tea's signal handler is off (see prompt.Run), so every signal is
	// ours: SIGHUP would otherwise take its default action and run no restore
	// at all. Signals take the same cancel path a dead parent does, and the
	// flag is what keeps a cancelled prompt's 130 apart from that parent's 70.
	var signalled atomic.Bool
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	go func() {
		<-signals
		signalled.Store(true)
		cancel()
	}()

	result, outcome, err := prompt.Run(ctx, spec, term)
	if err != nil {
		switch {
		case errors.Is(err, protocol.ErrBadSpec):
			fmt.Fprintln(os.Stderr, "rt-ui prompt:", err)
			return ExitBadSpec
		case signalled.Load():
			return ExitCancel
		}
		fmt.Fprintln(os.Stderr, "rt-ui prompt:", err)
		return ExitInternal
	}
	switch outcome {
	case prompt.Cancelled:
		return ExitCancel
	case prompt.Back:
		return ExitBack
	}
	if _, err := os.Stdout.Write(protocol.EncodeResult(result)); err != nil {
		// stdout gone: the parent died between our answer and our write.
		return ExitInternal
	}
	return ExitOK
}

// runPick mirrors runPrompt's spec-then-run shape: decode the opening
// request off stdin (same protocol-mismatch gate as DecodePrompt), then hand
// the rest of stdin and stdout to picker.Run, which owns /dev/tty itself.
func runPick() int {
	r := bufio.NewReader(os.Stdin)
	line, err := protocol.ReadLine(r)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui pick: no request on stdin")
		return ExitBadSpec
	}
	kind, raw, err := protocol.DecodePickLine(line)
	if err != nil || kind != "pick" {
		fmt.Fprintln(os.Stderr, "rt-ui pick: bad request")
		return ExitBadSpec
	}
	var req protocol.PickRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui pick:", err)
		return ExitBadSpec
	}
	if req.Protocol != protocol.Version {
		fmt.Fprintf(os.Stderr, "rt-ui pick: protocol %d, rt-ui speaks %d\n", req.Protocol, protocol.Version)
		return ExitBadSpec
	}

	if err := picker.Run(req, r, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui pick:", err)
		return ExitInternal
	}
	return ExitOK
}

func runSteps() int {
	r := bufio.NewReader(os.Stdin)
	first, err := protocol.ReadLine(r)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui steps: no hello on stdin")
		return ExitBadSpec
	}
	hello, err := protocol.DecodeStep(first)
	if err != nil || hello.T != "hello" || hello.Protocol != protocol.Version {
		fmt.Fprintf(os.Stderr, "rt-ui steps: bad hello %s\n", first)
		return ExitBadSpec
	}
	term, err := tty.Open(tty.WriteOnly)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui steps:", err)
		return ExitInternal
	}
	defer term.Close()

	events := make(chan protocol.StepEvent, 16)
	go func() {
		defer close(events)
		for {
			line, err := protocol.ReadLine(r)
			if err != nil {
				return
			}
			ev, err := protocol.DecodeStep(line)
			if err != nil {
				continue
			}
			events <- ev
		}
	}()
	// Cooked tty: ^C is a signal here, delivered to the whole group. Finalize
	// the line ourselves so the cursor never dies mid-spinner.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	if steps.Run(events, signals, term) == steps.Signalled {
		return ExitCancel
	}
	return ExitOK
}

func runSession(args []string) int {
	viewName := ""
	for i := 0; i < len(args); i++ {
		if args[i] == "--view" && i+1 < len(args) {
			viewName = args[i+1]
			i++
		}
	}
	if viewName == "" {
		fmt.Fprintln(os.Stderr, "rt-ui session: --view <kind> is required")
		return ExitBadSpec
	}
	term, err := tty.Open(tty.ReadWrite)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui session:", err)
		return ExitInternal
	}
	defer term.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	go func() {
		<-signals
		cancel()
	}()

	reason, _, err := session.Run(ctx, viewName, advertisedViews(), viewFor(viewName), os.Stdin, os.Stdout, term, version)
	code := session.ExitCode(reason, err)
	if code == ExitBadSpec || code == ExitInternal {
		if err != nil {
			fmt.Fprintln(os.Stderr, "rt-ui session:", err)
		}
	}
	return code
}

// advertisedViews is what the hello line offers; the echo view is a test
// fixture and only appears when the env asks for it.
func advertisedViews() []string {
	views := []string{"board"}
	if os.Getenv("RT_UI_TEST_VIEWS") == "1" {
		views = append(views, "echo")
	}
	return views
}

// viewFor maps a view name to its constructor; nil means unknown. The echo
// view only exists for the session tests and is hidden without the env.
func viewFor(name string) func(*session.Emitter) session.View {
	switch name {
	case "board":
		return func(em *session.Emitter) session.View { return board.New(em) }
	case "echo":
		if os.Getenv("RT_UI_TEST_VIEWS") != "1" {
			return func(*session.Emitter) session.View { return nil }
		}
		return func(em *session.Emitter) session.View { return session.NewEcho(em) }
	}
	return func(*session.Emitter) session.View { return nil }
}
