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
                             permissions: environment.permissions, env: environment)
        window.contentViewController = NSHostingController(rootView: root)
        window.setContentSize(NSSize(width: Self.width, height: 620))
        flow.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.applyStyle() } }
            .store(in: &cancellables)
    }
    required init?(coder: NSCoder) { fatalError("not supported") }

    func show(step: SetupStep? = nil, joinCode: String? = nil) {
        if let step { flow.jump(to: step) }
        if let joinCode { team.choice = .join; team.inviteCode = joinCode }
        SetupSession.isRunning = true
        applyStyle()
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        activeObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.environment.readiness.didBecomeActive() }
        }
    }

    private func applyStyle() {
        guard let window else { return }
        var mask: NSWindow.StyleMask = [.titled]
        if flow.windowMayClose { mask.insert([.closable, .miniaturizable]) }
        window.styleMask = mask
        SetupSession.isRunning = !flow.windowMayClose
    }

    func windowWillClose(_ notification: Notification) {
        SetupSession.isRunning = false
        environment.readiness.becameHidden()
        if let o = activeObserver { NotificationCenter.default.removeObserver(o) }
    }
}
