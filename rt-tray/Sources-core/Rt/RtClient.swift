import Foundation

public struct RtResult: Sendable {
    public let exitCode: Int32
    public let stdout: Data
    public let stderr: Data

    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: stdout)
    }
    /// Exit 2 carries `{ "error": {...} }` on stdout.
    public var userError: RtUserError? {
        guard exitCode == 2 else { return nil }
        return (try? JSONDecoder().decode(ErrorEnvelope.self, from: stdout))?.error
            ?? RtUserError(code: nil, message: String(decoding: stderr.prefix(2000), as: UTF8.self))
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
        if let stdin { inPipe.fileHandleForWriting.write(stdin) }
        try? inPipe.fileHandleForWriting.close()
        // Drain both pipes off the calling thread before waiting, or a chatty
        // child fills a pipe and we deadlock on waitUntilExit.
        async let stdoutData = Task.detached { out.fileHandleForReading.readDataToEndOfFile() }.value
        async let stderrData = Task.detached { err.fileHandleForReading.readDataToEndOfFile() }.value
        let (o, e) = await (stdoutData, stderrData)
        p.waitUntilExit()
        return RtResult(exitCode: p.terminationStatus, stdout: o, stderr: e)
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
                lock.lock()
                let tail = splitter.flush()
                lock.unlock()
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
