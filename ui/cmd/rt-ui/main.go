// rt-ui renders rt's interactive screens. stdin/stdout carry the protocol;
// every byte of UI goes to /dev/tty. Exit codes are the contract TS maps.
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

const (
	ExitOK       = 0
	ExitBadSpec  = 2
	ExitInternal = 70
	ExitCancel   = 130
	ExitBack     = 131
)

// Set by -ldflags "-X main.version=..." at release build time.
var version = "dev"

func main() {
	// A stdout write to a dead parent must surface as an error we handle
	// (restore the terminal, exit), never as a runtime SIGPIPE exit that
	// skips deferred restores.
	signal.Ignore(syscall.SIGPIPE)

	if len(os.Args) < 2 {
		usage()
		os.Exit(ExitBadSpec)
	}
	switch os.Args[1] {
	case "--version", "version":
		fmt.Fprintf(os.Stdout, "rt-ui %s protocol %d\n", version, protocolVersion)
		os.Exit(ExitOK)
	case "prompt":
		os.Exit(runPrompt())
	case "steps":
		os.Exit(runSteps())
	case "session":
		os.Exit(runSession(os.Args[2:]))
	default:
		usage()
		os.Exit(ExitBadSpec)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: rt-ui prompt | rt-ui steps | rt-ui session --view <kind> | rt-ui --version")
}
