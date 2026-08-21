import SwiftUI
import MattstackCore

struct PermissionsPane: View {
    let env: SettingsEnvironment
    @ObservedObject private var readiness: ReadinessModel
    @State private var snapshot = PermissionSnapshot.unknown
    @State private var timer: Timer?
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
                    let (status, detail) = PermissionRowOverlay.status(for: r.0, in: snapshot) ?? (.checking, "")
                    RowView(row: PlanRow(id: r.0, kind: .permission, title: r.1, why: r.2, required: r.3, status: status, detail: detail,
                                         action: RowAction(type: .openSettings, label: buttonLabel(r.0, status), target: r.4), recheck: .onActivate),
                            isChecking: false,
                            rowID: "settings.permissions.row.\(r.0)",
                            actionID: AXID.settingsPermissionAction(r.0),
                            statusID: "settings.permissions.row.\(r.0).status") { act(r.0, status, r.4) }
                }
                if readiness.fdaNeedsRelaunch {
                    HStack {
                        Text("Full Disk Access was granted. Relaunch mattstack to apply it.").font(.caption)
                        Spacer()
                        Button("Relaunch mattstack") { relaunch() }.accessibilityIdentifier(AXID.settingsPermissionsRelaunch)
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
        .onAppear {
            probe()
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in probe() }
            // readiness.fdaNeedsRelaunch is the one Setup and Settings share;
            // this pane needs its own tick only to keep that flag current
            // while Setup's checklist isn't the visible screen.
            readiness.becameVisible()
        }
        .onDisappear { timer?.invalidate(); timer = nil; readiness.becameHidden() }
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
        if id == PermissionRowOverlay.notificationsRow, status == .skipped { Task { _ = await env.permissions.request("notifications"); probe() }; return }
        env.permissions.openSettings(target)
    }
    private func probe() { Task { snapshot = await env.permissions.snapshot() } }

    /// Same re-exec as the Setup checklist's relaunch button (ChecklistScreen):
    /// launchd's LSUIElement flag means quitting alone would just end the app,
    /// so a fresh instance has to be spawned before this one terminates.
    private func relaunch() {
        let path = Bundle.main.bundlePath
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        var args = ["-n", path]
        if let feed = ProcessInfo.processInfo.environment[UpdatePolicy.overrideEnv] { args += ["--env", "\(UpdatePolicy.overrideEnv)=\(feed)"] }
        let passthrough = Array(CommandLine.arguments.dropFirst())
        if !passthrough.isEmpty { args += ["--args"] + passthrough }
        task.arguments = args
        try? task.run()
        NSApp.terminate(nil)
    }
}
