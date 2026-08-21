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
    private let planSource: RtPlanSource
    private let install: InstallRunModel
    private let teamSettings: TeamSettingsModel
    private var setupWindow: SetupWindowController?
    /// "Setup status…" reuses this SAME controller across repeat opens —
    /// never a fresh one per click. A second `SetupWindowController` here
    /// would be a second, undelegated owner of `readiness`'s visibility
    /// depth count and `SetupSession.isRunning`: NSWindow (not this class)
    /// would be the only thing keeping it alive, `windowWillClose` would
    /// never fire for the orphaned one, and the idle-install gate and the
    /// 1 Hz permission poller would both wedge on.
    private var statusWindow: SetupWindowController?
    private var settingsWindow: SettingsWindowController?
    /// Set by `handleJoin` when setup is already complete; consumed the next
    /// time the user actually asks to join a team from Settings.
    private var pendingTeamJoinCode: String?

    init(rt: RtRunning, permissions: PermissionsService, needs: NeedBroker, updater: UpdaterController) {
        self.rt = rt; self.permissions = permissions; self.needs = needs; self.updater = updater
        planSource = RtPlanSource(rt: rt, verb: ["setup", "plan", "--json"])
        readiness = ReadinessModel(plans: planSource, permissions: permissions, ticker: MainTicker())
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
        // The status window may have repointed the shared plan source at
        // `setup status`; the onboarding flow always reads `setup plan`.
        planSource.verb = ["setup", "plan", "--json"]
        if setupWindow == nil {
            let env = SetupEnvironment(rt: rt, readiness: readiness, install: install, permissions: permissions,
                                       isDevBuild: BundleFlavor.isDevBuild, bundleId: Bundle.main.bundleIdentifier ?? "com.mattstack.app",
                                       bundlePath: Bundle.main.bundlePath)
            setupWindow = SetupWindowController(environment: env)
        }
        // Re-entering an already-complete setup must never trap the user
        // behind a titlebar with no close button.
        setupWindow?.allowsCloseAlways = setupIsComplete
        setupWindow?.show(step: step, joinCode: joinCode)
    }

    /// "Setup status…": screen 3 as a read-only health view over
    /// `rt setup status`. Reuses the one shared `readiness` model (steered
    /// at the "setup status" verb) rather than standing up a second poller;
    /// always closable since it's diagnostics, not a wizard.
    func openSetupStatus() {
        planSource.verb = ["setup", "status", "--json"]
        if statusWindow == nil {
            let env = SetupEnvironment(rt: rt, readiness: readiness, install: install, permissions: permissions,
                                       isDevBuild: BundleFlavor.isDevBuild, bundleId: Bundle.main.bundleIdentifier ?? "com.mattstack.app",
                                       bundlePath: Bundle.main.bundlePath)
            let wc = SetupWindowController(environment: env)
            wc.allowsCloseAlways = true
            wc.window?.title = "mattstack Setup status"
            statusWindow = wc
        }
        statusWindow?.flow.jump(to: .checklist)
        statusWindow?.flow.isInstalling = false
        statusWindow?.show(step: .checklist)
    }

    func showSettings(pane: SettingsPane? = nil) {
        if settingsWindow == nil {
            let env = SettingsEnvironment(rt: rt, permissions: permissions, readiness: readiness, updater: updater, team: teamSettings,
                                          isDevBuild: BundleFlavor.isDevBuild,
                                          version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
                                          onJoinAnotherTeam: { [weak self] in
                                              guard let self else { return }
                                              let code = self.pendingTeamJoinCode
                                              self.pendingTeamJoinCode = nil
                                              self.showSetup(step: .team, joinCode: code)
                                          },
                                          onQuitForUninstall: { NSApp.terminate(nil) })
            settingsWindow = SettingsWindowController(env: env)
        }
        settingsWindow?.show(pane: pane)
    }

    /// A join link while setup is already complete is "join a DIFFERENT
    /// team," not first-run onboarding: it never reopens the Setup wizard
    /// (that would trap the user in a flow they already finished). It goes
    /// straight to Settings › Team, with the code held ready for "Join
    /// another team…" to prefill.
    func handleJoin(code: String) {
        if setupIsComplete {
            pendingTeamJoinCode = code
            showSettings(pane: .team)
        } else {
            showSetup(step: .team, joinCode: code)
        }
    }
}

/// Mutable so the coordinator's one shared `ReadinessModel` can be steered
/// between `setup plan` (onboarding) and `setup status` (read-only health
/// view) without a second model/poller. The two windows are not expected to
/// be visible on `.checklist` at the same instant — `showSetup`/
/// `openSetupStatus` each repoint it before showing — so a rare simultaneous
/// view briefly sees the other window's verb rather than a crash.
final class RtPlanSource: PlanSource, @unchecked Sendable {
    let rt: RtRunning
    private let lock = NSLock()
    private var _verb: [String]
    var verb: [String] {
        get { lock.lock(); defer { lock.unlock() }; return _verb }
        set { lock.lock(); _verb = newValue; lock.unlock() }
    }
    init(rt: RtRunning, verb: [String]) { self.rt = rt; self._verb = verb }
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
