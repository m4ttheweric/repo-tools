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
    func run(_ argv: [String], env: [String: String]) throws -> CommandResult
}

struct RealCommandRunner: CommandRunner {
    func run(_ argv: [String], env: [String: String]) throws -> CommandResult {
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
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return CommandResult(status: process.terminationStatus, output: String(decoding: data, as: UTF8.self))
    }
}
