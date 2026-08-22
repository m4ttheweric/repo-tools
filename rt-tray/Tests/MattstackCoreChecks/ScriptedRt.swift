import Foundation
import MattstackCore

/// Shared `RtRunning` test double — every `run`/`stream` call is recorded so
/// a check can assert on exact argv and stdin, and `answers` scripts `run`'s
/// reply by longest-matching-prefix key.
final class ScriptedRt: RtRunning, @unchecked Sendable {
    var answers: [String: (Int32, String)] = [:]   // key: args joined by space
    var calls: [(args: [String], stdin: String?)] = []
    /// NDJSON lines every `stream` call yields before it finishes.
    var streamLines: [String] = []

    func run(_ args: [String], stdin: Data?) async throws -> RtResult {
        calls.append((args, stdin.map { String(decoding: $0, as: UTF8.self) }))
        let key = args.joined(separator: " ")
        // Longest matching prefix wins — deterministic even when two answer
        // keys are both prefixes of the same call (e.g. "restore" and a
        // hypothetical "restore --dry-run").
        let (code, out) = answers.filter { key.hasPrefix($0.key) }.max { $0.key.count < $1.key.count }?.value ?? (1, "")
        return RtResult(exitCode: code, stdout: Data(out.utf8), stderr: Data())
    }

    func stream(_ args: [String], stdin: Data?) -> AsyncThrowingStream<String, Error> {
        calls.append((args, stdin.map { String(decoding: $0, as: UTF8.self) }))
        let lines = streamLines
        return AsyncThrowingStream { cont in
            for line in lines { cont.yield(line) }
            cont.finish()
        }
    }
}
