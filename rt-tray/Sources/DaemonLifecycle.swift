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
/// `@unchecked Sendable` for the same reason `ServicesRegistrar` is: the
/// mutable state here is `services`, wired once by AppDelegate during startup
/// and never reassigned, and every op that reads it is serialized by `gate`.
class DaemonLifecycle: @unchecked Sendable {

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

    /// One lifecycle op at a time, and one register+kickstart per herd of
    /// concurrent starts. Every public entry point below goes through it; the
    /// `…Ungated` bodies are what the gate runs, and are also what the restart
    /// fallback re-enters (going back through the gate from inside a held op
    /// would deadlock).
    private let gate = DaemonLifecycleGate()

    // MARK: - Start

    func startDaemon(origin: String) async {
        _ = await gate.run(.start) { await self.startDaemonUngated(origin: origin) }
    }

    @discardableResult
    private func startDaemonUngated(origin: String) async -> Bool {
        guard let services else {
            TrayLog.error("startDaemon with no services registrar wired", ["label": label, "origin": origin])
            return false
        }
        let results = await services.register(plists: [plistName])
        var anyFailed = false
        for r in results where !r.ok {
            anyFailed = true
            TrayLog.error("daemon register failed", ["label": label, "status": r.status, "err": r.error ?? "", "origin": origin])
        }
        // A genuine registration failure (missing BundleProgram, SMAppService
        // rejecting the plist) means there is nothing valid launchd knows
        // about to kickstart -- forcing one here is exactly the respawn-loop
        // the registrar's own BundleProgram guard exists to avoid.
        if anyFailed { return false }
        // register() is a no-op when the agent is already registered, so a job
        // that previously exited 0 (shutdown, an external SIGTERM) stays
        // registered but dead and KeepAlive never relaunches it (S028).
        // Kickstart forces launchd to actually invoke the job either way.
        if await services.restart(label: label) {
            TrayLog.info("daemon kickstarted on start", ["label": label, "origin": origin])
            return true
        }
        TrayLog.warn("kickstart on start failed", ["label": label, "origin": origin])
        return false
    }

    // MARK: - Stop

    func stopDaemon(origin: String) async {
        _ = await gate.run(.stop) { self.stopDaemonUngated(origin: origin) }
    }

    /// The teardown stop: app termination and flavor handover, both of which
    /// need the post-state synchronously and are followed by this app going
    /// away. Deliberately skips the gate — there is no later op for it to
    /// race, and parking teardown behind an in-flight start would only delay
    /// the handover the incoming flavor is waiting on.
    func stopDaemonForTeardown(origin: String) {
        stopDaemonUngated(origin: origin)
    }

    @discardableResult
    private func stopDaemonUngated(origin: String) -> Bool {
        do {
            try service.unregister()
            TrayLog.info("daemon unregistered from launchd", ["label": label, "origin": origin])
            return true
        } catch {
            TrayLog.error("SMAppService.unregister() failed", ["err": String(describing: error), "origin": origin])
            return false
        }
    }

    // MARK: - Restart

    /// launchctl kickstart -k restarts the running job in place — preserves
    /// the registration and lets KeepAlive cover any gap. Falls back to
    /// unregister/register if kickstart isn't available.
    func restartDaemon(origin: String) async {
        _ = await gate.run(.restart) { await self.restartDaemonUngated(origin: origin) }
    }

    @discardableResult
    private func restartDaemonUngated(origin: String) async -> Bool {
        guard let services else {
            TrayLog.error("restartDaemon with no services registrar wired", ["label": label, "origin": origin])
            return false
        }
        if await services.restart(label: label) {
            TrayLog.info("daemon kickstarted", ["label": label, "origin": origin])
            return true
        }

        // Fallback: full unregister + register cycle. The gate is what keeps
        // this window closed to concurrent starts: a start landing between the
        // unregister and the register below found no service to kickstart, and
        // left the job unregistered (2026-09-09).
        TrayLog.warn("kickstart failed; falling back to re-register", ["label": label, "origin": origin])
        try? await service.unregister()
        return await startDaemonUngated(origin: origin)
    }

}
