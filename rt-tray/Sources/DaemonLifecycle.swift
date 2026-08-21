import Foundation
import ServiceManagement

// MARK: - DaemonLifecycle

/// Manages the rt daemon as a LaunchAgent registered via SMAppService.
///
/// The daemon lives at <app>.app/Contents/MacOS/rt and the agent plist
/// at Contents/Library/LaunchAgents/<label>.plist. SMAppService hands off to
/// launchd, which supervises the process (KeepAlive + ThrottleInterval).
/// Because the plist declares AssociatedBundleIdentifiers = the app's own
/// bundle id, TCC attributes the daemon's file accesses to the signed parent
/// app — the user grants Full Disk Access to the app once and the daemon
/// inherits it.
///
/// The label is NOT a compiled literal: prod and dev are the same binary in
/// two bundles, and each owns its own launchd job (`com.rt.daemon` /
/// `com.rt.daemon.dev`). Both the plist basename and every launchctl
/// invocation derive from Info.plist's MSDaemonLabel (BundleFlavor), so a
/// dev bundle can never register or kickstart the prod job.
class DaemonLifecycle {

    /// This flavor's launchd label — Info.plist MSDaemonLabel, falling back
    /// to `com.rt.daemon` when the key is absent.
    let label: String

    private let service: SMAppService

    init(label: String = BundleFlavor.daemonLabel) {
        self.label = label
        self.service = SMAppService.agent(plistName: "\(label).plist")
    }

    var status: SMAppService.Status { service.status }

    // MARK: - Start

    func startDaemon() {
        do {
            try service.register()
            TrayLog.info("daemon registered with launchd", ["label": label, "status": statusString])
        } catch {
            TrayLog.error("SMAppService.register() failed", ["err": String(describing: error)])
        }
    }

    // MARK: - Stop

    func stopDaemon() {
        do {
            try service.unregister()
            TrayLog.info("daemon unregistered from launchd", ["label": label])
        } catch {
            TrayLog.error("SMAppService.unregister() failed", ["err": String(describing: error)])
        }
    }

    // MARK: - Restart

    /// launchctl kickstart -k restarts the running job in place — preserves
    /// the registration and lets KeepAlive cover any gap. Falls back to
    /// unregister/register if kickstart isn't available.
    func restartDaemon() {
        if TrayLog.runLogged("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(label)"],
                             label: "launchctl kickstart") != nil {
            TrayLog.info("daemon kickstarted", ["label": label])
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
