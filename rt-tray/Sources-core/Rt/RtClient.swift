import Foundation

public struct RtResult: Sendable {
    public let exitCode: Int32
    public let stdout: Data
    public let stderr: Data

    public init(exitCode: Int32, stdout: Data, stderr: Data) {
        self.exitCode = exitCode; self.stdout = stdout; self.stderr = stderr
    }

    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: stdout)
    }
    /// Exit 2 carries `{ "error": {...} }` on stdout.
    public var userError: RtUserError? {
        guard exitCode == 2 else { return nil }
        return (try? JSONDecoder().decode(ErrorEnvelope.self, from: stdout))?.error
            ?? RtUserError(code: nil, message: String(decoding: stderr.prefix(2000), as: UTF8.self))
    }

    /// Copy for a non-`userError` failure: a nonzero exit gets a trimmed
    /// stderr excerpt (real signal about what broke); exit 0 with no usable
    /// reply gets its own sentence rather than the nonsensical "failed (exit 0)".
    public func failureCopy(verb: String) -> String {
        guard exitCode != 0 else { return "rt \(verb) returned an unexpected reply." }
        let excerpt = String(decoding: stderr.prefix(200), as: UTF8.self)
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !excerpt.isEmpty else { return "rt \(verb) failed (exit \(exitCode))." }
        return "rt \(verb) failed (exit \(exitCode)): \(excerpt)"
    }
}

public enum RtClientError: Error, Equatable {
    case spawnFailed(String)
    case exited(Int32, stderr: String)
}

public protocol RtRunning: Sendable {
    func run(_ args: [String], stdin: Data?) async throws -> RtResult
    func stream(_ args: [String], stdin: Data?) -> AsyncThrowingStream<String, Error>
}

public enum RtSource: Equatable, Sendable { case bundled, legacyBundled, devWrapper, stub }

public struct RtLocation: Equatable, Sendable {
    public let executable: URL
    public let argumentPrefix: [String]
    public let source: RtSource
    public init(executable: URL, argumentPrefix: [String], source: RtSource) {
        self.executable = executable; self.argumentPrefix = argumentPrefix; self.source = source
    }
}

/// Spawns rt by absolute path. Secrets travel on stdin only; nothing here
/// ever puts a token or code into argv.
public final class RtClient: RtRunning, @unchecked Sendable {
    public let location: RtLocation
    private let environment: [String: String]

    public init(location: RtLocation, environment: [String: String]) {
        self.location = location
        self.environment = environment
    }

    private func makeProcess(_ args: [String]) -> Process {
        let p = Process()
        p.executableURL = location.executable
        p.arguments = location.argumentPrefix + args
        var env = ProcessInfo.processInfo.environment
        for (k, v) in environment { env[k] = v }
        p.environment = env
        return p
    }

    public func run(_ args: [String], stdin: Data?) async throws -> RtResult {
        let p = makeProcess(args)
        let out = Pipe(), err = Pipe(), inPipe = Pipe()
        p.standardOutput = out; p.standardError = err; p.standardInput = inPipe
        do { try p.run() } catch { throw RtClientError.spawnFailed(String(describing: error)) }

        // waitUntilExit() runs its own nested run loop and can starve the
        // Swift Concurrency cooperative pool if called from an async context;
        // drain both pipes via readabilityHandler and finish on terminationHandler
        // instead, same shape as SystemCommandRunner.
        let state = RunDrainState()
        let group = DispatchGroup()
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

        if let stdin { inPipe.fileHandleForWriting.write(stdin) }
        try? inPipe.fileHandleForWriting.close()

        return await withCheckedContinuation { cont in
            group.notify(queue: .global()) {
                let (code, o, e) = state.result()
                cont.resume(returning: RtResult(exitCode: code, stdout: o, stderr: e))
            }
        }
    }

    public func stream(_ args: [String], stdin: Data?) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let p = makeProcess(args)
            let out = Pipe(), err = Pipe(), inPipe = Pipe()
            p.standardOutput = out; p.standardError = err; p.standardInput = inPipe
            var splitter = NDJSONSplitter()
            let lock = NSLock()
            out.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                lock.lock(); defer { lock.unlock() }
                if data.isEmpty {
                    handle.readabilityHandler = nil
                    if let tail = splitter.flush() { continuation.yield(tail) }
                    return
                }
                for line in splitter.feed(data) { continuation.yield(line) }
            }
            p.terminationHandler = { proc in
                // readabilityHandler delivery lags process exit; a fast child's
                // trailing bytes (including the terminal event) can still be
                // unread here, so drain the fd directly before finishing.
                out.fileHandleForReading.readabilityHandler = nil
                lock.lock()
                let lines = splitter.feed(out.fileHandleForReading.readDataToEndOfFile())
                let tail = splitter.flush()
                lock.unlock()
                for line in lines { continuation.yield(line) }
                if let tail { continuation.yield(tail) }
                let stderr = String(decoding: err.fileHandleForReading.readDataToEndOfFile().prefix(4000), as: UTF8.self)
                switch proc.terminationStatus {
                case 0, 2: continuation.finish()
                default: continuation.finish(throwing: RtClientError.exited(proc.terminationStatus, stderr: stderr))
                }
            }
            do { try p.run() } catch {
                continuation.finish(throwing: RtClientError.spawnFailed(String(describing: error)))
                return
            }
            if let stdin { inPipe.fileHandleForWriting.write(stdin) }
            try? inPipe.fileHandleForWriting.close()
            continuation.onTermination = { _ in if p.isRunning { p.terminate() } }
        }
    }
}

/// Guards `run`'s two Data buffers and exit code across the readabilityHandler
/// and terminationHandler callbacks, which land on different queues.
private final class RunDrainState: @unchecked Sendable {
    private let lock = NSLock()
    private var outData = Data()
    private var errData = Data()
    private var code: Int32 = 0

    func appendOut(_ d: Data) { lock.lock(); outData.append(d); lock.unlock() }
    func appendErr(_ d: Data) { lock.lock(); errData.append(d); lock.unlock() }
    func setExitCode(_ c: Int32) { lock.lock(); code = c; lock.unlock() }
    func result() -> (Int32, Data, Data) {
        lock.lock(); defer { lock.unlock() }
        return (code, outData, errData)
    }
}
