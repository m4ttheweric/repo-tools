import AppKit
import SwiftUI
import Combine
import MattstackCore

enum SettingsPane: String, CaseIterable { case general, permissions, team, uninstall }

final class SettingsWindowController: NSWindowController, NSWindowDelegate {
    static let paneKey = "MSSettingsPane"
    let pane = PaneSelection()
    final class PaneSelection: ObservableObject { @Published var current: SettingsPane = .general }

    private let env: SettingsEnvironment
    private var paneObserver: AnyCancellable?
    /// This window's own half of the paired becameVisible/becameHidden
    /// calls into the shared `ReadinessModel` — tracked locally so
    /// `windowWillClose` can balance it exactly once regardless of which
    /// tab was selected, instead of relying on SwiftUI's onDisappear firing
    /// on window close (unreliable for a non-selected TabView page).
    private var readinessIsVisible = false

    init(env: SettingsEnvironment) {
        self.env = env
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 440),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "mattstack Settings"
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        pane.current = SettingsPane(rawValue: UserDefaults.standard.string(forKey: Self.paneKey) ?? "") ?? .general
        window.contentViewController = NSHostingController(rootView: SettingsView(pane: pane, env: env))
        window.setContentSize(NSSize(width: 560, height: 440))
        window.center()
        paneObserver = pane.$current.sink { [weak self] p in self?.setReadinessVisible(p == .permissions) }
    }
    required init?(coder: NSCoder) { fatalError("not supported") }

    func show(pane p: SettingsPane? = nil) {
        if let p { pane.current = p }
        UserDefaults.standard.set(pane.current.rawValue, forKey: Self.paneKey)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        window?.center()
        NSApp.activate(ignoringOtherApps: true)
    }

    private func setReadinessVisible(_ visible: Bool) {
        guard visible != readinessIsVisible else { return }
        readinessIsVisible = visible
        if visible { env.readiness.becameVisible() } else { env.readiness.becameHidden() }
    }

    func windowWillClose(_ notification: Notification) {
        setReadinessVisible(false)
    }
}

struct SettingsEnvironment {
    let rt: RtRunning
    let permissions: PermissionsService
    let readiness: ReadinessModel
    let updater: UpdaterController
    let team: TeamSettingsModel
    let isDevBuild: Bool
    let version: String
    let onJoinAnotherTeam: () -> Void
    let onQuitForUninstall: () -> Void
}
