import SwiftUI
import ServiceManagement
import MattstackCore

struct GeneralPane: View {
    let env: SettingsEnvironment
    @State private var startAtLogin = SMAppService.mainApp.status == .enabled
    @State private var autoUpdates = false
    @State private var devModeBusy = false

    var body: some View {
        Form {
            Section("Startup") {
                Toggle("Start mattstack at login", isOn: $startAtLogin)
                    .onChange(of: startAtLogin) { _, on in toggleLogin(on) }
                    .accessibilityIdentifier(AXID.settingsGeneralStartAtLogin)
            }
            Section("Updates") {
                Toggle("Check for updates automatically", isOn: $autoUpdates)
                    .disabled(!env.updater.isEnabled)
                    .onChange(of: autoUpdates) { _, on in env.updater.automaticallyChecks = on }
                    .accessibilityIdentifier(AXID.settingsGeneralAutoUpdates)
                HStack {
                    Button("Check Now") { env.updater.checkForUpdatesFromMenu() }.disabled(!env.updater.canCheckForUpdates)
                        .accessibilityIdentifier(AXID.settingsGeneralCheckNow)
                    if !env.updater.isEnabled { Text(env.isDevBuild ? "Updates are off in the dev flavor." : "Updates are off in this build.").font(.caption).foregroundStyle(.secondary) }
                }
            }
            Section("Developer") {
                LabeledContent("Flavor") { Text(env.isDevBuild ? "dev (mattstack-dev.app)" : "prod (mattstack.app)") }
                Button(env.isDevBuild ? "Switch to the installed app (dev mode off)…" : "Switch to the dev app (dev mode on)…") {
                    devModeBusy = true
                    Task { _ = try? await env.rt.run(["settings", "dev-mode", env.isDevBuild ? "prod" : "dev"], stdin: nil); devModeBusy = false }
                }
                .disabled(devModeBusy)
                .accessibilityIdentifier(AXID.settingsGeneralDevMode)
                Text("The handoff quits this app and launches the other flavor.").font(.caption).foregroundStyle(.secondary)
                // `rt settings dev-mode <dev|prod>`: L1 T31 drops `requiresTTY` when the target is given, so the app can spawn it.
            }
            Section { LabeledContent("Version") { Text(env.version) } }
        }
        .formStyle(.grouped)
        .onAppear { autoUpdates = env.updater.automaticallyChecks }
    }

    private func toggleLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register(); LoginItemPreference.isOptedOut = false }
            else { try SMAppService.mainApp.unregister(); LoginItemPreference.isOptedOut = true }
        } catch { TrayLog.error("login item toggle failed", ["err": String(describing: error)]) }
        startAtLogin = SMAppService.mainApp.status == .enabled
    }
}
