import Foundation
import SwiftUI

/// Daemon status shared between AppDelegate (which polls) and the process
/// panel (which displays it in the status strip). A singleton because the
/// popover and the detached window each host their own panel instance.
class TrayState: ObservableObject {
    static let shared = TrayState()

    @Published var health: DaemonHealth = .unknown
    @Published var statusText: String = "Daemon: checking…"
    /// SMAppService wants the user to approve the daemon in Login Items.
    @Published var needsApproval: Bool = false
    /// Set when UpdateChecker finds a newer release (its tag name).
    @Published var updateAvailable: String? = nil

    var healthColor: Color {
        switch health {
        case .healthy:  return .green
        case .starting: return .yellow
        case .warning:  return .orange
        case .down:     return .red
        case .unknown:  return .secondary
        }
    }
}

// Gear-menu actions the panel posts back to AppDelegate, which owns the
// daemon lifecycle and update checker.
extension Notification.Name {
    static let rtRestartDaemon  = Notification.Name("rtRestartDaemon")
    static let rtStopDaemon     = Notification.Name("rtStopDaemon")
    static let rtViewDaemonLogs = Notification.Name("rtViewDaemonLogs")
    static let rtCheckUpdates   = Notification.Name("rtCheckUpdates")
}
