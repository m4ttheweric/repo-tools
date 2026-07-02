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
            TrayLog.info("daemon registered with launchd", ["status": statusString])
        } catch {
            TrayLog.error("SMAppService.register() failed", ["err": String(describing: error)])
        }
    }

    // MARK: - Stop

    func stopDaemon() {
        do {
            try service.unregister()
            TrayLog.info("daemon unregistered from launchd")
        } catch {
            TrayLog.error("SMAppService.unregister() failed", ["err": String(describing: error)])
        }
    }

    // MARK: - Restart

    /// launchctl kickstart -k restarts the running job in place — preserves
    /// the registration and lets KeepAlive cover any gap. Falls back to
    /// unregister/register if kickstart isn't available.
    func restartDaemon() {
        let label = "com.rt.daemon"
        if TrayLog.runLogged("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(label)"],
                             label: "launchctl kickstart") != nil {
            TrayLog.info("daemon kickstarted")
            return
        }

        // Fallback: full unregister + register cycle
        TrayLog.warn("kickstart failed; falling back to re-register")
        try? service.unregister()
        do { try service.register() } catch {
            TrayLog.error("re-register after kickstart failure also failed", ["err": String(describing: error)])
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
