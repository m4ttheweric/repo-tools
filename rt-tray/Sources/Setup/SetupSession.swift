import Foundation

/// Process-wide "setup is in progress" flag: the updater's idle gate reads
/// `isRunning`. Owner-keyed rather than a single bool — the onboarding Setup
/// window and the read-only "Setup status…" window can both exist at once,
/// and only the former is ever "in progress." A single shared bool would
/// have the last writer win regardless of which window it was: the status
/// window repainting itself could clear a real in-progress onboarding run
/// out from under it, or vice versa. Any future third window contributes
/// its own key the same way, so this can't regress by omission.
enum SetupSession {
    private static var owners = Set<ObjectIdentifier>()
    static var isRunning: Bool { !owners.isEmpty }
    static func setRunning(_ running: Bool, for owner: ObjectIdentifier) {
        if running { owners.insert(owner) } else { owners.remove(owner) }
    }
}
