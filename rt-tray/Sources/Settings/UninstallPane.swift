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
                Button("Uninstall mattstack…") { Task { await armConfirmation() } }
                    .disabled(running)
                    .accessibilityIdentifier(AXID.settingsUninstall)
                if let e = model.error { Text(e).font(.caption).foregroundStyle(.red) }
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
                Toggle("Keep ~/.mattstack (your settings home repo, at ~/.mattstack/user, and other local data)", isOn: $keepData).accessibilityIdentifier(AXID.settingsUninstallKeepData).toggleStyle(.switch).controlSize(.small)
                HStack {
                    Spacer()
                    // The safe choice takes the Return key; the destructive
                    // one is a plain click only — HIG, and it also keeps a
                    // stray Return from ever firing the uninstall.
                    Button("Cancel") { confirming = false }.keyboardShortcut(.defaultAction).accessibilityIdentifier(AXID.settingsUninstallCancel)
                    Button("Uninstall", role: .destructive) { confirming = false; run() }
                        .accessibilityIdentifier(AXID.settingsUninstallConfirm)
                }
            }
            .padding(20).frame(width: 460)
        }
    }

    /// Only arms the destructive sheet once the dry-run plan actually
    /// decoded — a failed/missing `rt uninstall --dry-run` must show its
    /// failure copy (above) instead of an empty "This will:" list with a
    /// live destructive button.
    private func armConfirmation() async {
        await model.loadUninstallPlan()
        if model.uninstallPlan != nil { confirming = true }
    }

    private func run() {
        running = true
        progress = []
        let titles = Dictionary(uniqueKeysWithValues: (model.uninstallPlan?.actions ?? []).map { ($0.id, $0.title) })
        var reasons: [String: (detail: String?, remedy: String?)] = [:]
        Task {
            do {
                for try await line in model.uninstall(keepData: keepData) {
                    guard let ev = try? ApplyEvent.decode(line) else { continue }
                    switch ev {
                    case .step(let id, let state, let detail, let remedy):
                        if detail != nil || remedy != nil { reasons[id] = (detail ?? reasons[id]?.detail, remedy ?? reasons[id]?.remedy) }
                        let title = titles[id] ?? id
                        progress.append("\(title): \(state.rawValue)\(detail.map { " — \($0)" } ?? "")")
                    case .need(let id, _):
                        // The model's NeedBroker performs it as the line goes
                        // past; rt turns the recorded outcome into this id's
                        // next step event, which is what reports the result.
                        progress.append("\(titles[id] ?? id): mattstack is doing this part…")
                    case .done(let ok, let failedStep):
                        if ok {
                            progress.append("done — mattstack will quit now")
                            env.onQuitForUninstall()
                        } else {
                            let id = failedStep ?? ""
                            let title = titles[id] ?? failedStep ?? "uninstall"
                            let reason = reasons[id]?.remedy ?? reasons[id]?.detail
                            progress.append(reason.map { "\(title) — \($0)" } ?? "\(title) stopped")
                        }
                    default: break
                    }
                }
            } catch { progress.append("error: \((error as? RtClientError)?.copy ?? "rt uninstall failed.")") }
            running = false
        }
    }
}
