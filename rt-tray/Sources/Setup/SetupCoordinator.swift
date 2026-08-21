import AppKit
import MattstackCore

/// Owns the Setup and Settings windows and the models behind them. One
/// instance per process, created by AppDelegate after the services exist.
@MainActor
final class SetupCoordinator {
    private let rt: RtRunning
    private let permissions: PermissionsService
    private let needs: NeedBroker
    private let updater: UpdaterController
    private let readiness: ReadinessModel
    private let install: InstallRunModel
    private let teamSettings: TeamSettingsModel
    private var setupWindow: SetupWindowController?
    private var settingsWindow: SettingsWindowController?

    init(rt: RtRunning, permissions: PermissionsService, needs: NeedBroker, updater: UpdaterController) {
        self.rt = rt; self.permissions = permissions; self.needs = needs; self.updater = updater
        readiness = ReadinessModel(plans: RtPlanSource(rt: rt, verb: ["setup", "plan", "--json"]),
                                   permissions: permissions, ticker: MainTicker())
        install = InstallRunModel(stream: { from in
            var args = ["setup", "apply"]
            if let from { args += ["--from", from] }
            return rt.stream(args + ["--json"], stdin: nil)
        }, needs: needs)
        teamSettings = TeamSettingsModel(rt: rt)
    }

    var setupIsComplete: Bool {
        !FirstRunDetector.needsSetup(home: NSHomeDirectory()) { FileManager.default.fileExists(atPath: $0) }
    }

    func showSetup(step: SetupStep? = nil, joinCode: String? = nil) {
        if setupWindow == nil {
            let env = SetupEnvironment(rt: rt, readiness: readiness, install: install, permissions: permissions,
                                       isDevBuild: BundleFlavor.isDevBuild, bundleId: Bundle.main.bundleIdentifier ?? "com.mattstack.app",
                                       bundlePath: Bundle.main.bundlePath)
            setupWindow = SetupWindowController(environment: env)
        }
        setupWindow?.show(step: step, joinCode: joinCode)
    }

    /// "Setup status…": screen 3 as a health view over `rt setup status`.
    func openSetupStatus() {
        let status = ReadinessModel(plans: RtPlanSource(rt: rt, verb: ["setup", "status", "--json"]), permissions: permissions, ticker: MainTicker())
        let env = SetupEnvironment(rt: rt, readiness: status, install: install, permissions: permissions,
                                   isDevBuild: BundleFlavor.isDevBuild, bundleId: Bundle.main.bundleIdentifier ?? "com.mattstack.app",
                                   bundlePath: Bundle.main.bundlePath)
        let wc = SetupWindowController(environment: env)
        wc.flow.jump(to: .checklist)
        wc.flow.isInstalling = false
        wc.show(step: .checklist)
        wc.window?.styleMask.insert(.closable)
        wc.window?.title = "mattstack Setup status"
        setupWindow = wc
    }

    func showSettings(pane: SettingsPane? = nil) {
        if settingsWindow == nil {
            let env = SettingsEnvironment(rt: rt, permissions: permissions, readiness: readiness, updater: updater, team: teamSettings,
                                          isDevBuild: BundleFlavor.isDevBuild,
                                          version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
                                          onJoinAnotherTeam: { [weak self] in self?.showSetup(step: .team) },
                                          onQuitForUninstall: { NSApp.terminate(nil) })
            settingsWindow = SettingsWindowController(env: env)
        }
        settingsWindow?.show(pane: pane)
    }

    func handleJoin(code: String) {
        if setupIsComplete { showSettings(pane: .team); showSetup(step: .team, joinCode: code) }
        else { showSetup(step: .team, joinCode: code) }
    }
}

struct RtPlanSource: PlanSource {
    let rt: RtRunning
    let verb: [String]
    func fetchPlan() async throws -> Plan {
        let r = try await rt.run(verb, stdin: nil)
        if let e = r.userError { throw e }
        return try r.decode(Plan.self)
    }
}

/// Timer-backed ticker on the main run loop.
struct MainTicker: TickerScheduling {
    func schedule(every seconds: TimeInterval, _ tick: @escaping @Sendable () -> Void) -> TickerHandle {
        let box = TimerBox()
        box.timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: true) { _ in tick() }
        return TickerHandle { box.invalidate() }
    }
}

/// Timer isn't Sendable; the cancel closure only ever runs on the main run
/// loop that created it, same thread the timer itself fires on.
private final class TimerBox: @unchecked Sendable {
    var timer: Timer?
    func invalidate() { timer?.invalidate() }
}
