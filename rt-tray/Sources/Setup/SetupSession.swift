import Foundation

/// Process-wide "setup is in progress" flag: the updater's idle gate reads it
/// and the window controller owns it.
enum SetupSession {
    static var isRunning = false
}
