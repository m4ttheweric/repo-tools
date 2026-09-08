import Foundation

// The escalator pipes ONLY stdout and derives the exit code from the
// MATTSTACK_EXIT trailer; a missing trailer parses as success, so every
// termination path must run through finish().
enum Report {
    static func trailer(_ code: Int32) -> String { "MATTSTACK_EXIT=\(code)" }
    // synchronizeFile() throws NSFileHandleOperationException when stdout is
    // a pipe (the escalator's shape); fflush is the pipe-safe equivalent.
    static func step(_ line: String) { print(line); fflush(stdout) }
    static func finish(_ code: Int32) -> Never {
        print(trailer(code))
        exit(code)
    }
}
