import Foundation

// The escalator pipes ONLY stdout and derives the exit code from the
// MATTSTACK_EXIT trailer; a missing trailer parses as success, so every
// termination path must run through finish().
enum Report {
    static func trailer(_ code: Int32) -> String { "MATTSTACK_EXIT=\(code)" }
    static func step(_ line: String) { print(line); FileHandle.standardOutput.synchronizeFile() }
    static func finish(_ code: Int32) -> Never {
        print(trailer(code))
        exit(code)
    }
}
