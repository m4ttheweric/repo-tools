import Foundation

// The escalator pipes ONLY stdout and derives the exit code from the
// MATTSTACK_EXIT trailer; a missing trailer parses as success, so every
// termination path must run through finish().
enum Report {
    static func trailer(_ code: Int32) -> String { "MATTSTACK_EXIT=\(code)" }
    /// The trust outcome travels beside the exit code because a declined trust
    /// is a successful install: the exit code cannot carry both.
    static func trustLine(_ outcome: TrustOutcome) -> String { "MATTSTACK_TRUST=\(outcome.rawValue)" }
    // synchronizeFile() throws NSFileHandleOperationException when stdout is
    // a pipe (the escalator's shape); fflush is the pipe-safe equivalent.
    static func step(_ line: String) { print(line); fflush(stdout) }
    static func finish(_ code: Int32) -> Never {
        print(trailer(code))
        exit(code)
    }
}

// sysexits(3), reaching the app only through that trailer.
enum ExitCode {
    static let ok: Int32 = 0
    static let usage: Int32 = 64
    /// A rendered file the system refused (visudo).
    static let dataErr: Int32 = 65
    static let unavailable: Int32 = 69
    /// This helper's own failure: a refused payload, a write that did not land.
    static let software: Int32 = 70
    /// A privileged command the OS ran and failed (launchctl, the trust run).
    static let osErr: Int32 = 71
    static let noPerm: Int32 = 77
    /// No console user to install for.
    static let config: Int32 = 78
}
