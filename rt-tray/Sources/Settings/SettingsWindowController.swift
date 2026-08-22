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
    /// calls into the shared `ReadinessModel` — tracked locally so a
    /// `becameHidden` (from `windowWillClose` or the pane sink) only ever
    /// fires when this controller actually holds a matching `becameVisible`,
    /// never a stray extra decrement.
    private var readinessIsVisible = false
    /// Whether `show()` has put the window on screen since the last close.
    /// The pane sink acts only while this is true, since `Published`'s
    /// publisher replays the just-restored pane synchronously on subscribe
    /// (init time, well before the window exists on screen) and would
    /// otherwise start the shared poller before anyone can see the row it
    /// probes.
    private var windowIsVisible = false

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
        paneObserver = pane.$current.sink { [weak self] p in
            guard let self, self.windowIsVisible else { return }
            self.setReadinessVisible(p == .permissions)
        }
    }
    required init?(coder: NSCoder) { fatalError("not supported") }

    func show(pane p: SettingsPane? = nil) {
        if let p { pane.current = p }
        UserDefaults.standard.set(pane.current.rawValue, forKey: Self.paneKey)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        window?.center()
        NSApp.activate(ignoringOtherApps: true)
        windowIsVisible = true
        // The pane sink doesn't re-emit on a reopen with an unchanged pane
        // (and was suppressed above while the window was still hidden), so
        // this is the only path that resumes the poller when reopening
        // straight onto the Permissions tab.
        setReadinessVisible(pane.current == .permissions)
    }

    private func setReadinessVisible(_ visible: Bool) {
        guard visible != readinessIsVisible else { return }
        readinessIsVisible = visible
        if visible { env.readiness.becameVisible() } else { env.readiness.becameHidden() }
    }

    func windowWillClose(_ notification: Notification) {
        windowIsVisible = false
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
