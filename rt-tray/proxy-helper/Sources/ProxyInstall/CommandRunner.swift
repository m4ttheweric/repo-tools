import Foundation

struct CommandResult: Equatable {
    let status: Int32
    /// stdout and stderr merged. The escalator gives the helper no stderr
    /// channel, so a child's diagnostics only survive by being captured here and
    /// reprinted on our stdout.
    let output: String
}

// The subprocess seam. Everything privileged this helper does that is not a
// filesystem write happens through here, so InstallOp's sequence and rollbacks
// are testable without root.
protocol CommandRunner {
    /// `timeout` nil waits as long as the child takes. A stated timeout is for
    /// the calls that raise a dialog: nobody may ever answer it, and a helper
    /// blocked on one holds the escalated session and the whole Install with it.
    func run(_ argv: [String], env: [String: String], timeout: TimeInterval?) throws -> CommandResult
}

extension CommandRunner {
    func run(_ argv: [String], env: [String: String]) throws -> CommandResult {
        try run(argv, env: env, timeout: nil)
    }
}

struct RealCommandRunner: CommandRunner {
    /// Reported instead of a real exit status, which a killed child does not
    /// have; negative so it can never collide with one.
    static let timedOutStatus: Int32 = -2

    func run(_ argv: [String], env: [String: String], timeout: TimeInterval?) throws -> CommandResult {
        guard let executable = argv.first else { throw ProxyInstallError("empty command") }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = Array(argv.dropFirst())
        process.environment = env
        // Captured, never inherited: an inherited child stdout would interleave
        // with this helper's own lines on the escalator's pipe, where the last
        // line carries the exit contract.
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice
        try process.run()

        // The read has to happen off this thread: readDataToEndOfFile only
        // returns when the child closes the pipe, so a timeout could never fire
        // while it is the thing being waited on.
        var data = Data()
        let drained = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            data = pipe.fileHandleForReading.readDataToEndOfFile()
            drained.signal()
        }

        if let timeout, drained.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            if drained.wait(timeout: .now() + 5) == .timedOut {
                kill(process.processIdentifier, SIGKILL)
                drained.wait()
            }
            process.waitUntilExit()
            return CommandResult(status: Self.timedOutStatus, output: "timed out after \(Int(timeout))s")
        }
        if timeout == nil { drained.wait() }

        process.waitUntilExit()
        return CommandResult(status: process.terminationStatus, output: String(decoding: data, as: UTF8.self))
    }
}
