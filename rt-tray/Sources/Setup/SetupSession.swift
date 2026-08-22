import Foundation

/// Process-wide "setup is in progress" flag: the updater's idle gate reads
/// `isRunning`. Owner-keyed rather than a single bool — the onboarding Setup
/// window and the read-only "Setup status…" window can both exist at once,
/// and only the former is ever "in progress." A single shared bool would
/// have the last writer win regardless of which window it was: the status
/// window repainting itself could clear a real in-progress onboarding run
/// out from under it, or vice versa. Any future third window contributes
/// its own key the same way, so this can't regress by omission.
///
/// Locked rather than MainActor-isolated: the writers are window controllers
/// on the main thread, but the reader is Sparkle's idle-gate callback, which
/// makes no such promise.
enum SetupSession {
    private static let lock = NSLock()
    private static var owners = Set<ObjectIdentifier>()
    static var isRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return !owners.isEmpty
    }
    static func setRunning(_ running: Bool, for owner: ObjectIdentifier) {
        lock.lock(); defer { lock.unlock() }
        if running { owners.insert(owner) } else { owners.remove(owner) }
    }
}
