package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"

	"rt-ui/internal/prompt"
	"rt-ui/internal/protocol"
	"rt-ui/internal/tty"
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

	result, outcome, err := prompt.Run(ctx, spec, term)
	if err != nil {
		if errors.Is(err, protocol.ErrBadSpec) {
			fmt.Fprintln(os.Stderr, "rt-ui prompt:", err)
			return ExitBadSpec
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

func runSteps() int { return ExitInternal }
