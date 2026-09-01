import Foundation

/// One repo whose team-authored `ready` ladder the daemon is holding pending
/// approval. Mirrors the `worktreeReadyHeld` entries on `tray:status`.
public struct ReadyHeldRepo: Equatable, Sendable, Codable {
    /// Serialized repo identity. The ledger keys on it; nothing displays it.
    public let repo: String
    /// Decoded display name, as the daemon labelled it.
    public let label: String
    public let hash: String
    /// The exact command that clears this hold, resolvable as spelled.
    public let approveCommand: String

    public init(repo: String, label: String, hash: String, approveCommand: String) {
        self.repo = repo
        self.label = label
        self.hash = hash
        self.approveCommand = approveCommand
    }
}

/// Decides which held ladders deserve a notification, given what has already
/// been announced (RT-98).
///
/// The hold is a state, not an event: it can persist for days, and every
/// worktree claim made while it lasts silently skips the declared steps. So a
/// banner that can be dismissed once is not enough, and the ledger re-arms on
/// an interval rather than latching forever.
public enum ReadyHeldNotifier {

    /// How long a given (repo, ladder) stays quiet after being announced.
    public static let reNagInterval: TimeInterval = 24 * 60 * 60

    /// Keyed by hash first: a hash is fixed-width hex, so the repo's own
    /// punctuation can never be mistaken for the separator.
    public static func ledgerKey(_ held: ReadyHeldRepo) -> String {
        "\(held.hash):\(held.repo)"
    }

    /// The repos to notify about now, plus the ledger to persist.
    ///
    /// A repo that has left `held` (someone approved it) drops out of the
    /// returned ledger entirely, so a later re-hold announces immediately
    /// instead of waiting out a window it never lived through.
    public static func decide(
        held: [ReadyHeldRepo],
        ledger: [String: Date],
        now: Date,
        reNagAfter: TimeInterval = reNagInterval
    ) -> (notify: [ReadyHeldRepo], ledger: [String: Date]) {
        var kept: [String: Date] = [:]
        var notify: [ReadyHeldRepo] = []

        for entry in held {
            let key = ledgerKey(entry)
            if let announced = ledger[key], now.timeIntervalSince(announced) < reNagAfter {
                kept[key] = announced
            } else {
                notify.append(entry)
                kept[key] = now
            }
        }

        return (notify, kept)
    }
}
