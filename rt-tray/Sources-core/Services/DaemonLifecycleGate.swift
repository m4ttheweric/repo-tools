import Foundation

/// The three things anything can ask of the daemon LaunchAgent.
public enum DaemonLifecycleOp: String, Sendable, Codable {
    case start, stop, restart
}

/// Who asked. Every lifecycle log line carries one, so a restart in the log
/// can be told from a restart someone requested over the socket without
/// correlating timestamps against the rt CLI log.
public enum DaemonOrigin {
    /// The tray's own gear menu.
    public static let menu = "gear menu"
    /// A flavor handover retiring this bundle's agent.
    public static let flavorRetire = "flavor retire"

    /// A request that arrived on tray.sock. rt's clients identify themselves
    /// in `X-RT-Client` (`rt-cli/<pid>`, `rt-client/<pid>`); a caller that
    /// sends nothing is named as such rather than silently borrowing the
    /// shape of one that did.
    public static func http(clientHeader: String?) -> String {
        let trimmed = clientHeader?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "socket (unidentified client)" : "socket \(trimmed)"
    }

    /// Case-insensitive header lookup over a raw HTTP request. TrayServer's
    /// legacy route path never parses headers into a dictionary — it matches
    /// on the request line and keeps the whole request as one string — so the
    /// lookup has to work off that string.
    public static func header(_ name: String, in rawRequest: String) -> String? {
        let headerBlock = rawRequest.components(separatedBy: "\r\n\r\n").first ?? rawRequest
        for line in headerBlock.components(separatedBy: "\r\n").dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            guard line[..<colon].lowercased() == name.lowercased() else { continue }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            return value.isEmpty ? nil : value
        }
        return nil
    }
}

/// Serializes daemon LaunchAgent lifecycle work and collapses a herd of
/// concurrent starts into one.
///
/// Both behaviors are the same incident (2026-09-09). A restart whose
/// kickstart fails falls back to unregister-then-register, and every rt client
/// that finds the daemon socket down POSTs `/daemon/start`, which registers
/// and kickstarts. With ~26 watchers those two interleaved: a register landed,
/// the restart's unregister landed next, and the register's own kickstart then
/// failed with "Could not find service …", leaving the job unregistered — the
/// tray reporting "not registered" for ~20s of what should have been a 1s
/// in-place restart.
///
/// So: one op at a time, and a `.start` arriving while a start is already
/// queued or running gets that start's result instead of issuing its own
/// register+kickstart.
public actor DaemonLifecycleGate {
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var startPending = false
    private var startJoiners: [CheckedContinuation<Bool, Never>] = []

    public init() {}

    public func run(_ op: DaemonLifecycleOp, _ body: @Sendable () async -> Bool) async -> Bool {
        if op == .start {
            if startPending {
                return await withCheckedContinuation { startJoiners.append($0) }
            }
            startPending = true
        }

        await acquire()
        let result = await body()
        release()

        if op == .start {
            startPending = false
            let joiners = startJoiners
            startJoiners = []
            for joiner in joiners { joiner.resume(returning: result) }
        }
        return result
    }

    private func acquire() async {
        // A loop, not an `if`: `release` resumes one waiter, but a caller that
        // was never parked can take the slot in between, so the waiter has to
        // re-check rather than assume the slot it was woken for is still free.
        while busy {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in waiters.append(c) }
        }
        busy = true
    }

    private func release() {
        busy = false
        if !waiters.isEmpty { waiters.removeFirst().resume() }
    }
}
