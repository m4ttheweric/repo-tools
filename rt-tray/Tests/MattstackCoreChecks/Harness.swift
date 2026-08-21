import Foundation

public struct CheckFailure: Sendable {
    public let check: String
    public let message: String
    public let file: String
    public let line: Int
}

/// Thrown by `require`, which has already recorded the failure — the throw only
/// unwinds the body so a soft assertion is never followed by the hard access
/// (a subscript, a force-unwrap) it was guarding.
public struct CheckAbort: Error, Sendable {
    public let message: String
}

public struct Check: Sendable {
    public let name: String
    public let body: @Sendable (CheckContext) async throws -> Void
    public init(_ name: String, _ body: @escaping @Sendable (CheckContext) async throws -> Void) {
        self.name = name
        self.body = body
    }
}

public final class CheckContext: @unchecked Sendable {
    public let name: String
    public private(set) var failures: [CheckFailure] = []
    private let lock = NSLock()
    init(name: String) { self.name = name }

    public func expect(_ condition: Bool, _ message: @autoclosure () -> String = "expected true",
                       file: String = #filePath, line: Int = #line) {
        guard !condition else { return }
        record(message(), file, line)
    }
    public func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: @autoclosure () -> String = "",
                                          file: String = #filePath, line: Int = #line) {
        guard actual != expected else { return }
        record("\(message()) expected \(expected) got \(actual)", file, line)
    }
    public func fail(_ message: String, file: String = #filePath, line: Int = #line) { record(message, file, line) }

    /// Records like `expect` and then aborts the check. Use it wherever the
    /// next statement would trap on a false condition — indexing an array whose
    /// count was just asserted, unwrapping an optional just checked.
    public func require(_ condition: Bool, _ message: @autoclosure () -> String = "requirement failed",
                        file: String = #filePath, line: Int = #line) throws {
        guard !condition else { return }
        let text = message()
        record(text, file, line)
        throw CheckAbort(message: text)
    }
    public func requireEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: @autoclosure () -> String = "",
                                           file: String = #filePath, line: Int = #line) throws {
        guard actual != expected else { return }
        let text = "\(message()) expected \(expected) got \(actual)"
        record(text, file, line)
        throw CheckAbort(message: text)
    }
    private func record(_ message: String, _ file: String, _ line: Int) {
        lock.lock(); defer { lock.unlock() }
        failures.append(CheckFailure(check: name, message: message, file: file, line: line))
    }
}

public struct CheckReport: Sendable {
    public let passed: Int
    public let failures: [CheckFailure]
    public var ok: Bool { failures.isEmpty }
}

public func runAllChecks(filter: String? = nil) async -> CheckReport {
    var passed = 0
    var failures: [CheckFailure] = []
    for check in allChecks where filter == nil || check.name.contains(filter!) {
        let ctx = CheckContext(name: check.name)
        // Named on stderr before the body runs so a process-level trap or hang
        // still identifies which check owned it; the harness itself can only
        // report checks that return.
        FileHandle.standardError.write(Data("check: \(check.name)\n".utf8))
        do { try await check.body(ctx) } catch is CheckAbort {
            // require() already recorded it; the throw only unwound the body.
        } catch {
            ctx.fail("threw \(error)")
        }
        if ctx.failures.isEmpty { passed += 1 } else { failures.append(contentsOf: ctx.failures) }
    }
    return CheckReport(passed: passed, failures: failures)
}
