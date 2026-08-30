import Foundation
import ServiceManagement
import MattstackCore

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
/// two bundles, and each owns its own launchd job (`com.mattstack.daemon` /
/// `com.mattstack.daemon.dev`). Both the plist basename and every launchctl
/// invocation derive from Info.plist's MSDaemonLabel (BundleFlavor), so a
/// dev bundle can never register or kickstart the prod job.
class DaemonLifecycle {

    /// This flavor's launchd label — Info.plist MSDaemonLabel, falling back
    /// to `BundleFlavor.defaultDaemonLabel` when the key is absent.
    let label: String

    private let service: SMAppService

    /// Registration and kickstart go through the registrar, wired by
    /// AppDelegate once the bundle path is known: it is the one place that
    /// skips a plist whose BundleProgram isn't shipped (launchd would
    /// otherwise respawn-loop it) and the one place that spawns through
    /// CommandRunner instead of blocking the main thread.
    var services: ServicesProviding?

    init(label: String = BundleFlavor.daemonLabel) {
        self.label = label
        self.service = SMAppService.agent(plistName: "\(label).plist")
    }

    var status: SMAppService.Status { service.status }
    private var plistName: String { "\(label).plist" }

    // MARK: - Start

    func startDaemon() async {
        guard let services else {
            TrayLog.error("startDaemon with no services registrar wired", ["label": label])
            return
        }
        let results = await services.register(plists: [plistName])
        for r in results where !r.ok {
            TrayLog.error("daemon register failed", ["label": label, "status": r.status, "err": r.error ?? ""])
        }
        // register() is a no-op when the agent is already registered, so a job
        // that previously exited 0 (shutdown, an external SIGTERM) stays
        // registered but dead and KeepAlive never relaunches it (S028).
        // Kickstart forces launchd to actually invoke the job either way.
        if await services.restart(label: label) {
            TrayLog.info("daemon kickstarted on start", ["label": label])
        } else {
            TrayLog.warn("kickstart on start failed", ["label": label])
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
    func restartDaemon() async {
        guard let services else {
            TrayLog.error("restartDaemon with no services registrar wired", ["label": label])
            return
        }
        if await services.restart(label: label) {
            TrayLog.info("daemon kickstarted", ["label": label])
            return
        }

        // Fallback: full unregister + register cycle
        TrayLog.warn("kickstart failed; falling back to re-register")
        try? await service.unregister()
        await startDaemon()
    }

}
