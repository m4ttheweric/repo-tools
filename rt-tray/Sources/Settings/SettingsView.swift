import SwiftUI
import MattstackCore

struct SettingsView: View {
    @ObservedObject var pane: SettingsWindowController.PaneSelection
    let env: SettingsEnvironment
    var body: some View {
        TabView(selection: $pane.current) {
            GeneralPane(env: env)
                .tabItem { Label("General", systemImage: "gearshape").accessibilityIdentifier(AXID.settingsTab(SettingsPane.general.rawValue)) }
                .tag(SettingsPane.general)
            PermissionsPane(env: env)
                .tabItem { Label("Permissions", systemImage: "lock.shield").accessibilityIdentifier(AXID.settingsTab(SettingsPane.permissions.rawValue)) }
                .tag(SettingsPane.permissions)
            TeamPane(env: env)
                .tabItem { Label("Team", systemImage: "person.3").accessibilityIdentifier(AXID.settingsTab(SettingsPane.team.rawValue)) }
                .tag(SettingsPane.team)
            UninstallPane(env: env)
                .tabItem { Label("Uninstall", systemImage: "trash").accessibilityIdentifier(AXID.settingsTab(SettingsPane.uninstall.rawValue)) }
                .tag(SettingsPane.uninstall)
        }
        .frame(width: 560, height: 440)
        .onChange(of: pane.current) { _, p in UserDefaults.standard.set(p.rawValue, forKey: SettingsWindowController.paneKey) }
    }
}
