import AppKit
import SwiftUI
import MattstackCore

enum SettingsPane: String, CaseIterable { case general, permissions, team, uninstall }

final class SettingsWindowController: NSWindowController {
    private static let paneKey = "MSSettingsPane"
    let pane = PaneSelection()
    final class PaneSelection: ObservableObject { @Published var current: SettingsPane = .general }

    init(env: SettingsEnvironment) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 440),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "mattstack Settings"
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
        pane.current = SettingsPane(rawValue: UserDefaults.standard.string(forKey: Self.paneKey) ?? "") ?? .general
        window.contentViewController = NSHostingController(rootView: SettingsView(pane: pane, env: env))
    }
    required init?(coder: NSCoder) { fatalError("not supported") }

    func show(pane p: SettingsPane? = nil) {
        if let p { pane.current = p }
        UserDefaults.standard.set(pane.current.rawValue, forKey: Self.paneKey)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
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
