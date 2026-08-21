import AppKit
import SwiftUI
import Combine
import MattstackCore

struct SetupEnvironment {
    let rt: RtRunning
    let readiness: ReadinessModel
    let install: InstallRunModel
    let permissions: PermissionsService
    let isDevBuild: Bool
    let bundleId: String
    let bundlePath: String
}

/// One dedicated NSWindow hosting SwiftUI (AppKit lifecycle stays). ~560 pt
/// wide, fixed; close/minimize appear only once setup is done.
final class SetupWindowController: NSWindowController, NSWindowDelegate {
    static let width: CGFloat = 560
    let flow = SetupFlowModel()
    let team: TeamChoiceModel
    /// Set by the caller (e.g. re-entering an already-complete setup, or the
    /// read-only "Setup status…" view) to make the window closable even
    /// though `flow` itself hasn't reached `.done` — a wizard step must never
    /// double as a trap once there's nothing left to walk the user through.
    var allowsCloseAlways = false
    private let environment: SetupEnvironment
    private var activeObserver: Any?
    private var cancellables = Set<AnyCancellable>()

    init(environment: SetupEnvironment) {
        self.environment = environment
        self.team = TeamChoiceModel(rt: environment.rt)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 620),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "mattstack Setup"
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
        window.delegate = self
        let root = SetupView(flow: flow, team: team, readiness: environment.readiness, install: environment.install,
                             permissions: environment.permissions, env: environment,
                             onFinish: { [weak self] in self?.window?.close() })
        window.contentViewController = NSHostingController(rootView: root)
        window.setContentSize(NSSize(width: Self.width, height: 620))
        flow.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.applyStyle() } }
            .store(in: &cancellables)
    }
    required init?(coder: NSCoder) { fatalError("not supported") }

    func show(step: SetupStep? = nil, joinCode: String? = nil) {
        if let step { flow.jump(to: step) }
        if let joinCode { team.choice = .join; team.inviteCode = joinCode }
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        applyStyle()
        window?.center()
        NSApp.activate(ignoringOtherApps: true)
        // A second show() while already open (deep link, tray re-click) must
        // not accumulate observers — each would fire didBecomeActive() again.
        if let o = activeObserver { NotificationCenter.default.removeObserver(o) }
        activeObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.environment.readiness.didBecomeActive() }
        }
    }

    private func applyStyle() {
        guard let window else { return }
        var mask: NSWindow.StyleMask = [.titled]
        if flow.windowMayClose || allowsCloseAlways { mask.insert([.closable, .miniaturizable]) }
        window.styleMask = mask
        // Ground truth, not "we just showed it": a late write to flow after
        // the window has actually closed must not re-arm the updater's idle
        // gate forever. A window that's only closable because the caller
        // forced it (already-complete setup, the status view) isn't an
        // active onboarding run either, so it must not hold the gate shut.
        SetupSession.isRunning = window.isVisible && !flow.windowMayClose && !allowsCloseAlways
    }

    func windowWillClose(_ notification: Notification) {
        SetupSession.isRunning = false
        // Only balances an outstanding becameVisible() (see
        // SetupFlowModel.readinessIsVisible) — closing on a step that
        // already left .checklist must not send a second, unmatched hide.
        if flow.readinessIsVisible {
            flow.readinessIsVisible = false
            environment.readiness.becameHidden()
        }
        if let o = activeObserver { NotificationCenter.default.removeObserver(o) }
    }
}
