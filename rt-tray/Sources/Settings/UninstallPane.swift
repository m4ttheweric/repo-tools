import SwiftUI
import MattstackCore

struct UninstallPane: View {
    let env: SettingsEnvironment
    @ObservedObject private var model: TeamSettingsModel
    @State private var confirming = false
    @State private var keepData = true
    @State private var progress: [String] = []
    @State private var running = false
    init(env: SettingsEnvironment) { self.env = env; self.model = env.team }

    var body: some View {
        Form {
            Section("Uninstall mattstack") {
                Text("Reverses everything the installer did: services, the proxy, ~/.local/bin links and the shell rc block, the editor extension, the Claude Code plugins we added; then moves the app to the Trash.")
                    .font(.callout)
                Button("Uninstall mattstack…") { Task { await model.loadUninstallPlan(); confirming = true } }
                    .accessibilityIdentifier(AXID.settingsUninstall)
            }
            if !progress.isEmpty {
                Section("Progress") { ForEach(progress, id: \.self) { Text($0).font(.system(.caption, design: .monospaced)) } }
            }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $confirming) {
            VStack(alignment: .leading, spacing: 12) {
                Text("This will:").font(.headline)
                ForEach(model.uninstallPlan?.actions ?? []) { a in Label(a.title, systemImage: "minus.circle") }
                Toggle("Keep ~/.mattstack (your settings home repo, at ~/.mattstack/user, and other local data)", isOn: $keepData).accessibilityIdentifier(AXID.settingsUninstallKeepData)
                HStack {
                    Spacer()
                    Button("Cancel") { confirming = false }.keyboardShortcut(.cancelAction)
                    Button("Uninstall", role: .destructive) { confirming = false; run() }.keyboardShortcut(.defaultAction).disabled(running)
                        .accessibilityIdentifier(AXID.settingsUninstallConfirm)
                }
            }
            .padding(20).frame(width: 460)
        }
    }

    private func run() {
        running = true
        progress = []
        Task {
            do {
                for try await line in model.uninstall(keepData: keepData) {
                    if let ev = try? ApplyEvent.decode(line) {
                        switch ev {
                        case .step(let id, let state, let detail, _): progress.append("\(id): \(state.rawValue)\(detail.map { " — \($0)" } ?? "")")
                        case .done(let ok, _): progress.append(ok ? "done — mattstack will quit now" : "stopped"); if ok { env.onQuitForUninstall() }
                        default: break
                        }
                    }
                }
            } catch { progress.append("error: \((error as? RtClientError)?.copy ?? "rt uninstall failed.")") }
            running = false
        }
    }
}
