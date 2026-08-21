import Foundation

public struct CommandOutcome: Equatable, Sendable {
    public let exitCode: Int32
    public let stdout: String
    public let stderr: String
    public var ok: Bool { exitCode == 0 }
    public init(exitCode: Int32, stdout: String, stderr: String) {
        self.exitCode = exitCode; self.stdout = stdout; self.stderr = stderr
    }
}

/// The one seam every non-rt subprocess goes through (launchctl, tccutil,
/// the privileged helper, deck). Checks use RecordingCommandRunner; nothing
/// under Tests/ may construct SystemCommandRunner.
public protocol CommandRunner: Sendable {
    func run(_ executable: String, _ args: [String]) async -> CommandOutcome
}

public final class RecordingCommandRunner: CommandRunner, @unchecked Sendable {
    public struct Call: Equatable, Sendable { public let executable: String; public let args: [String] }
    public private(set) var calls: [Call] = []
    public var responses: [String: CommandOutcome] = [:]
    private let lock = NSLock()
    public init() {}
    public func run(_ executable: String, _ args: [String]) async -> CommandOutcome {
        lock.lock(); defer { lock.unlock() }
        calls.append(Call(executable: executable, args: args))
        let key = (executable as NSString).lastPathComponent
        return responses[key] ?? CommandOutcome(exitCode: 127, stdout: "", stderr: "no canned response for \(key)")
    }
}

public struct SystemCommandRunner: CommandRunner {
    public init() {}
    public func run(_ executable: String, _ args: [String]) async -> CommandOutcome {
        await withCheckedContinuation { cont in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: executable)
            p.arguments = args
            let out = Pipe(), err = Pipe()
            p.standardOutput = out; p.standardError = err
            p.terminationHandler = { proc in
                let o = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                let e = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                cont.resume(returning: CommandOutcome(exitCode: proc.terminationStatus, stdout: o, stderr: e))
            }
            do { try p.run() } catch {
                cont.resume(returning: CommandOutcome(exitCode: 127, stdout: "", stderr: String(describing: error)))
            }
        }
    }
}

public enum TCCReset {
    public static func arguments(bundleId: String) -> (String, [String]) {
        ("/usr/bin/tccutil", ["reset", "All", bundleId])
    }
}
