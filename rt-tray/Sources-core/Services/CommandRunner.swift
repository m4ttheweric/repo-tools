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

            let state = PipeDrainState()
            let group = DispatchGroup()

            // A chatty child (launchctl, the privileged helper, deck) can fill
            // the ~64KB pipe buffer; draining stdout/stderr as data arrives,
            // rather than in terminationHandler after waiting for exit, is
            // what keeps the child from blocking on a full pipe and the
            // continuation from hanging forever.
            func drain(_ pipe: Pipe, into append: @escaping (Data) -> Void) {
                group.enter()
                pipe.fileHandleForReading.readabilityHandler = { handle in
                    let data = handle.availableData
                    if data.isEmpty {
                        handle.readabilityHandler = nil
                        group.leave()
                    } else {
                        append(data)
                    }
                }
            }
            drain(out, into: state.appendOut)
            drain(err, into: state.appendErr)

            group.enter()
            p.terminationHandler = { proc in
                state.setExitCode(proc.terminationStatus)
                group.leave()
            }

            group.notify(queue: .global()) {
                guard state.markResumedOnce() else { return }
                cont.resume(returning: state.outcome())
            }

            do {
                try p.run()
            } catch {
                out.fileHandleForReading.readabilityHandler = nil
                err.fileHandleForReading.readabilityHandler = nil
                state.setExitCode(127)
                state.appendErr(Data(String(describing: error).utf8))
                // the process never started, so termination/EOF will never
                // fire on their own — settle the group's outstanding enters
                // so group.notify still runs the single resume path above.
                group.leave(); group.leave(); group.leave()
            }
        }
    }
}

/// Guards the pieces `SystemCommandRunner` touches from multiple queues
/// (readabilityHandler callbacks, terminationHandler, the catch path) so the
/// checked continuation resumes exactly once.
private final class PipeDrainState: @unchecked Sendable {
    private let lock = NSLock()
    private var outData = Data()
    private var errData = Data()
    private var code: Int32 = 127
    private var resumed = false

    func appendOut(_ d: Data) { lock.lock(); outData.append(d); lock.unlock() }
    func appendErr(_ d: Data) { lock.lock(); errData.append(d); lock.unlock() }
    func setExitCode(_ c: Int32) { lock.lock(); code = c; lock.unlock() }
    func markResumedOnce() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if resumed { return false }
        resumed = true
        return true
    }
    func outcome() -> CommandOutcome {
        lock.lock(); defer { lock.unlock() }
        return CommandOutcome(exitCode: code, stdout: String(decoding: outData, as: UTF8.self), stderr: String(decoding: errData, as: UTF8.self))
    }
}

public enum TCCReset {
    public static func arguments(bundleId: String) -> (String, [String]) {
        ("/usr/bin/tccutil", ["reset", "All", bundleId])
    }
}
