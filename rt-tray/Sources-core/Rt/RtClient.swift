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
    public var userError: RtUserError? { userError(redactStderr: false) }

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
            let outHandle = out.fileHandleForReading, errHandle = err.fileHandleForReading
            let state = StreamDrainState(continuation) {
                outHandle.readabilityHandler = nil
                errHandle.readabilityHandler = nil
            }

            // The readability handler is the ONE reader of each fd. Process exit
            // and pipe EOF are independent events in either order, so nothing
            // here may read stdout a second time to "catch up" at termination:
            // a second read races the in-flight readability callback and steals
            // bytes it would have parsed, dropping lines already past the
            // splitter but not yet yielded (rt's terminal `done` among them).
            out.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty {
                    handle.readabilityHandler = nil
                    state.stdoutClosed()
                } else {
                    state.appendStdout(data)
                }
            }
            err.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty {
                    handle.readabilityHandler = nil
                    state.stderrClosed()
                } else {
                    state.appendStderr(data)
                }
            }
            p.terminationHandler = { proc in state.exited(proc.terminationStatus) }

            do { try p.run() } catch {
                state.failedToLaunch(RtClientError.spawnFailed(String(describing: error)))
                return
            }
            if let stdin { inPipe.fileHandleForWriting.write(stdin) }
            try? inPipe.fileHandleForWriting.close()
            continuation.onTermination = { _ in if p.isRunning { p.terminate() } }
        }
    }
}

/// Serializes `stream`'s three callers — the stdout reader, the stderr reader
/// and terminationHandler, each on its own queue — so the NDJSON splitter has a
/// single owner, every line is yielded before the stream finishes, and the
/// continuation finishes exactly once. Finishing waits for both pipes to reach
/// EOF *and* the process to exit, in whatever order those land; finishing on
/// exit alone would strand bytes the reader had not been handed yet. A grace
/// timer bounds that wait, since a pipe an outliving grandchild holds may never
/// reach EOF at all.
private final class StreamDrainState: @unchecked Sendable {
    private enum Outcome { case clean, failed(Int32, String) }

    /// Only this much stderr can reach the error copy; the rest is read and
    /// dropped so a chatty child never blocks on a full pipe.
    private static let stderrCap = 4000
    /// A grandchild that inherited rt's pipes holds them open past rt's exit,
    /// so EOF may never arrive. After this long the exit status becomes the
    /// answer on its own — a bounded tail rather than a stream that never ends
    /// and a Process/Pipe/continuation cycle that never releases.
    private static let exitGrace = DispatchTimeInterval.seconds(2)

    private let lock = NSLock()
    private let continuation: AsyncThrowingStream<String, Error>.Continuation
    /// Nils both readabilityHandlers, breaking the handler→state→handle cycle.
    /// Invoked only outside the lock: a reader callback may be waiting on it.
    private let releaseReaders: @Sendable () -> Void
    private var splitter = NDJSONSplitter()
    private var stderrBytes = Data()
    private var stdoutAtEOF = false
    private var stderrAtEOF = false
    private var exitStatus: Int32?
    private var finished = false

    init(_ continuation: AsyncThrowingStream<String, Error>.Continuation,
         releaseReaders: @escaping @Sendable () -> Void) {
        self.continuation = continuation
        self.releaseReaders = releaseReaders
    }

    func appendStdout(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        for line in splitter.feed(data) { continuation.yield(line) }
    }

    func stdoutClosed() {
        lock.lock()
        if let tail = splitter.flush() { continuation.yield(tail) }
        stdoutAtEOF = true
        let outcome = settle()
        lock.unlock()
        deliver(outcome)
    }

    func appendStderr(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        guard stderrBytes.count < Self.stderrCap else { return }
        stderrBytes.append(data)
    }

    func stderrClosed() {
        lock.lock()
        stderrAtEOF = true
        let outcome = settle()
        lock.unlock()
        deliver(outcome)
    }

    func exited(_ status: Int32) {
        lock.lock()
        exitStatus = status
        let outcome = settle()
        lock.unlock()
        if let outcome { deliver(outcome); return }
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.exitGrace) { [weak self] in
            self?.finishOnExitStatusAlone()
        }
    }

    /// The process never started, so neither EOF nor termination will ever fire.
    func failedToLaunch(_ error: Error) {
        lock.lock()
        let first = !finished
        finished = true
        lock.unlock()
        guard first else { return }
        continuation.finish(throwing: error)
        releaseReaders()
    }

    /// The grace period expired with a pipe still open. Whatever is holding it
    /// is not rt, so the exit status is all the answer there will ever be.
    private func finishOnExitStatusAlone() {
        lock.lock()
        guard !finished, let status = exitStatus else { lock.unlock(); return }
        if let tail = splitter.flush() { continuation.yield(tail) }
        stdoutAtEOF = true
        stderrAtEOF = true
        finished = true
        let outcome = outcome(for: status)
        lock.unlock()
        deliver(outcome)
    }

    /// Caller holds the lock. Returns the outcome only for the one call that
    /// closes the last of {stdout EOF, stderr EOF, exit}.
    private func settle() -> Outcome? {
        guard !finished, stdoutAtEOF, stderrAtEOF, let status = exitStatus else { return nil }
        finished = true
        return outcome(for: status)
    }

    private func outcome(for status: Int32) -> Outcome {
        switch status {
        case 0, 2: return .clean
        default: return .failed(status, String(decoding: stderrBytes.prefix(Self.stderrCap), as: UTF8.self))
        }
    }

    /// Runs outside the lock. Safe because `finished` implies both EOFs, so no
    /// reader can still be yielding by the time this finishes the stream.
    private func deliver(_ outcome: Outcome?) {
        guard let outcome else { return }
        switch outcome {
        case .clean: continuation.finish()
        case .failed(let status, let stderr):
            continuation.finish(throwing: RtClientError.exited(status, stderr: stderr))
        }
        releaseReaders()
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
