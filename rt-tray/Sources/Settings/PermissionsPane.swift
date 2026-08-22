import SwiftUI
import MattstackCore

struct PermissionsPane: View {
    let env: SettingsEnvironment
    @ObservedObject private var readiness: ReadinessModel
    @State private var resetting = false

    init(env: SettingsEnvironment) { self.env = env; self.readiness = env.readiness }

    private var rows: [(String, String, String, Bool, String)] {  // id, title, why, required, settings target
        [(PermissionRowOverlay.fdaRow, "Full Disk Access", "Reads your repositories' git state so the daemon can show branch and MR status.", true, "fda"),
         (PermissionRowOverlay.loginItemsRow, "Background services", "rt daemon and deck run in the background as login items.", true, "login-items"),
         (PermissionRowOverlay.notificationsRow, "Notifications", "Pipeline and review alerts; works without this.", false, "notifications")]
    }

    var body: some View {
        Form {
            Section {
                ForEach(rows, id: \.0) { r in
                    let (status, detail) = PermissionRowOverlay.status(for: r.0, in: readiness.permissionSnapshot) ?? (.checking, "")
                    RowView(row: PlanRow(id: r.0, kind: .permission, title: r.1, why: r.2, required: r.3, status: status, detail: detail,
                                         action: RowAction(type: .openSettings, label: buttonLabel(r.0, status), target: r.4), recheck: .onActivate),
                            isChecking: false,
                            rowID: AXID.settingsPermissionRow(r.0),
                            actionID: AXID.settingsPermissionAction(r.0),
                            statusID: AXID.settingsPermissionRowStatus(r.0)) { act(r.0, status, r.4) }
                }
                if readiness.fdaNeedsRelaunch {
                    HStack {
                        Text("Full Disk Access was granted. Relaunch mattstack to apply it.").font(.caption)
                        Spacer()
                        Button("Relaunch mattstack") { AppRelaunch.relaunchInPlace() }.accessibilityIdentifier(AXID.settingsPermissionsRelaunch)
                    }
                }
            }
            Section {
                HStack {
                    Button(resetting ? "Resetting…" : "Reset & re-request…") { resetting = true; Task { _ = await env.permissions.resetAndReRequest(); resetting = false } }
                        .disabled(resetting)
                        .accessibilityIdentifier(AXID.settingsPermissionsReset)
                    Text("Clears this app's permission records (for a moved app or stale signature) and asks again.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        // One poller: readiness owns the 1s permission probe (also read by
        // the Setup checklist), so this view only reads its @Published
        // snapshot — SettingsWindowController drives becameVisible/Hidden
        // off the selected tab, since window-close doesn't reliably fire
        // onDisappear for a TabView page that isn't currently selected.
    }

    private func buttonLabel(_ id: String, _ status: RowStatus) -> String {
        switch (id, status) {
        case (PermissionRowOverlay.fdaRow, _): return "Open Full Disk Access Settings…"
        case (PermissionRowOverlay.loginItemsRow, _): return "Open Login Items…"
        case (PermissionRowOverlay.notificationsRow, .skipped): return "Allow"
        default: return "Open Notification Settings…"
        }
    }
    private func act(_ id: String, _ status: RowStatus, _ target: String) {
        if id == PermissionRowOverlay.notificationsRow, status == .skipped { Task { _ = await env.permissions.request("notifications") }; return }
        env.permissions.openSettings(target)
    }
}
