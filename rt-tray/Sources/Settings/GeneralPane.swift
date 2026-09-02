import SwiftUI
import ServiceManagement
import MattstackCore

struct GeneralPane: View {
    let env: SettingsEnvironment
    @State private var startAtLogin = SMAppService.mainApp.status == .enabled
    @State private var autoUpdates = false
    @State private var devModeBusy = false
    @State private var devModeError: String?

    var body: some View {
        Form {
            Section("Startup") {
                Toggle("Start mattstack at login", isOn: $startAtLogin).toggleStyle(.switch).controlSize(.small)
                    .onChange(of: startAtLogin) { _, on in toggleLogin(on) }
                    .accessibilityIdentifier(AXID.settingsGeneralStartAtLogin)
            }
            Section("Updates") {
                Toggle("Check for updates automatically", isOn: $autoUpdates).toggleStyle(.switch).controlSize(.small)
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
                    devModeError = nil
                    Task {
                        let verb = "settings dev-mode"
                        do {
                            let r = try await env.rt.run(["settings", "dev-mode", env.isDevBuild ? "prod" : "dev"], stdin: nil)
                            if let e = r.userError { devModeError = e.message }
                            else if r.exitCode != 0 { devModeError = r.failureCopy(verb: verb) }
                        } catch {
                            devModeError = (error as? RtClientError)?.copy ?? "rt \(verb) failed to start."
                        }
                        if let devModeError { TrayLog.warn("dev-mode handoff failed", ["err": devModeError]) }
                        devModeBusy = false
                    }
                }
                .disabled(devModeBusy)
                .accessibilityIdentifier(AXID.settingsGeneralDevMode)
                Text("The handoff quits this app and launches the other flavor.").font(.caption).foregroundStyle(.secondary)
                if let devModeError { Text(devModeError).font(.caption).foregroundStyle(.red) }
                // `rt settings dev-mode <dev|prod>` drops its TTY requirement when the target is given, so the app can spawn it.
            }
            Section { LabeledContent("Version") { Text(env.version) } }
        }
        .formStyle(.grouped)
        .onAppear {
            autoUpdates = env.updater.automaticallyChecks
            startAtLogin = SMAppService.mainApp.status == .enabled
        }
    }

    private func toggleLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register(); LoginItemPreference.isOptedOut = false }
            else { try SMAppService.mainApp.unregister(); LoginItemPreference.isOptedOut = true }
        } catch { TrayLog.error("login item toggle failed", ["err": String(describing: error)]) }
        startAtLogin = SMAppService.mainApp.status == .enabled
    }
}
