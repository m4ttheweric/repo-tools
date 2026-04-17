import Foundation
import ServiceManagement

// MARK: - DaemonLifecycle

/// Manages the rt daemon as a LaunchAgent registered via SMAppService.
///
/// The daemon lives at rt-tray.app/Contents/MacOS/rt-daemon and the agent
/// plist at Contents/Library/LaunchAgents/com.rt.daemon.plist. SMAppService
/// hands off to launchd, which supervises the process (KeepAlive +
/// ThrottleInterval). Because the plist declares
/// AssociatedBundleIdentifiers = com.rt.tray, TCC attributes the daemon's
/// file accesses to the signed parent app — the user grants Full Disk Access
/// to rt-tray.app once and the daemon inherits it.
class DaemonLifecycle {

    private let service = SMAppService.agent(plistName: "com.rt.daemon.plist")

    var status: SMAppService.Status { service.status }

    // MARK: - Start

    func startDaemon() {
        do {
            try service.register()
            NSLog("rt-tray: daemon registered with launchd (status=\(statusString))")
        } catch {
            NSLog("rt-tray: SMAppService.register() failed: \(error)")
        }
    }

    // MARK: - Stop

    func stopDaemon() {
        do {
            try service.unregister()
            NSLog("rt-tray: daemon unregistered from launchd")
        } catch {
            NSLog("rt-tray: SMAppService.unregister() failed: \(error)")
        }
    }

    // MARK: - Restart

    /// launchctl kickstart -k restarts the running job in place — preserves
    /// the registration and lets KeepAlive cover any gap. Falls back to
    /// unregister/register if kickstart isn't available.
    func restartDaemon() {
        let label = "com.rt.daemon"
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["kickstart", "-k", "gui/\(getuid())/\(label)"]
        do {
            try task.run()
            task.waitUntilExit()
            if task.terminationStatus == 0 {
                NSLog("rt-tray: daemon kickstarted")
                return
            }
        } catch {
            NSLog("rt-tray: kickstart failed: \(error) — falling back to re-register")
        }

        // Fallback: full unregister + register cycle
        try? service.unregister()
        do { try service.register() } catch {
            NSLog("rt-tray: re-register after kickstart failure also failed: \(error)")
        }
    }

    // MARK: - Helpers

    private var statusString: String {
        switch service.status {
        case .notRegistered:    return "notRegistered"
        case .enabled:          return "enabled"
        case .requiresApproval: return "requiresApproval"
        case .notFound:         return "notFound"
        @unknown default:       return "unknown"
        }
    }
}
