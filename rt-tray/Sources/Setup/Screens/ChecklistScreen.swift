import SwiftUI
import MattstackCore

struct ChecklistScreen: View {
    @ObservedObject var model: ReadinessModel
    let permissions: PermissionsService
    let rt: RtRunning
    let bundleId: String
    @State private var connect: (row: PlanRow, fields: [ActionField], integration: String, alternatives: [ActionAlternative])?
    @State private var steps: (title: String, steps: [String])?
    @State private var relaunchHint = false
    @State private var actionError: (rowId: String, message: String)?

    var body: some View {
        VStack(spacing: 0) {
            if let e = model.lastError {
                Label("Couldn't compute the checklist: \(e)", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red).padding(8)
            }
            Form {
                ForEach(model.groups) { group in
                    Section(group.title) {
                        ForEach(group.rows) { row in
                            RowView(row: row, isChecking: model.checkingRowIds.contains(row.id)) { perform(row) }
                            if let actionError, actionError.rowId == row.id {
                                Text(actionError.message).font(.caption).foregroundStyle(.red)
                                    .accessibilityIdentifier(AXID.checklistRowError(row.id))
                            }
                        }
                        if group.id == "mac", relaunchHint || permissions.fdaNeedsRelaunch {
                            HStack {
                                Text("Full Disk Access was granted. Relaunch mattstack to apply it.").font(.caption)
                                Spacer()
                                Button("Relaunch mattstack") { relaunch() }.accessibilityIdentifier(AXID.checklistRelaunch)
                            }
                        }
                    }
                }
            }
            .formStyle(.grouped)
            HStack {
                Text(model.canInstall ? "Everything required is ready." : "\(model.requiredMissing.count) required item(s) left.")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Re-check") { Task { await model.recheckAll() } }.controlSize(.small).accessibilityIdentifier(AXID.checklistRecheck)
            }
            .padding(.horizontal, 20).padding(.vertical, 6)
        }
        .sheet(isPresented: Binding(get: { connect != nil }, set: { if !$0 { connect = nil } })) {
            if let c = connect {
                ConnectSheet(integration: c.integration, fields: c.fields, alternatives: c.alternatives) { values, alt in
                    run(RowActionDispatcher.dispatch(c.row.action!, fieldValues: values, alternative: alt), for: c.row)
                }
            }
        }
        .sheet(isPresented: Binding(get: { steps != nil }, set: { if !$0 { steps = nil } })) {
            if let s = steps { StepsSheet(title: s.title, steps: s.steps) }
        }
        .accessibilityIdentifier(AXID.checklistScreen)
    }

    private func perform(_ row: PlanRow) {
        guard let action = row.action else { return }
        actionError = nil
        run(RowActionDispatcher.dispatch(action, fieldValues: nil, alternative: nil), for: row)
    }

    private func run(_ dispatched: DispatchedAction, for row: PlanRow) {
        switch dispatched {
        case .openSettings(let target):
            permissions.openSettings(target)
            if target == "fda" { relaunchHint = false }
        case .requestPermission(let which):
            Task { _ = await permissions.request(which); await model.afterAction(rowId: row.id) }
        case .rtVerb(let args, let stdin):
            Task {
                let verb = args.joined(separator: " ")
                do {
                    let result = try await rt.run(args, stdin: stdin)
                    if let e = result.userError {
                        TrayLog.warn("row action failed", ["row": row.id, "err": e.message])
                        actionError = (row.id, e.message)
                    } else if result.exitCode != 0 {
                        let copy = result.failureCopy(verb: verb)
                        TrayLog.warn("row action failed", ["row": row.id, "err": copy])
                        actionError = (row.id, copy)
                    }
                } catch {
                    let copy = "rt \(verb) failed to start: \(error)"
                    TrayLog.warn("row action failed", ["row": row.id, "err": copy])
                    actionError = (row.id, copy)
                }
                await model.afterAction(rowId: row.id)
            }
        case .openURL(let url):
            NSWorkspace.shared.open(url)
        case .showSteps(let list):
            steps = (row.title, list)
        case .collectFields(let fields, let integration, let alternatives):
            connect = (row, fields, integration, alternatives)
        case .none:
            break
        }
    }

    private func relaunch() {
        let path = Bundle.main.bundlePath
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        // Re-exec with the current arguments + environment so a clean-room
        // launch (`MATTSTACK_APPCAST_URL` + `--allow-appcast-override`)
        // survives the relaunch; `open` does not inherit either on its own.
        var args = ["-n", path]
        if let feed = ProcessInfo.processInfo.environment[UpdatePolicy.overrideEnv] { args += ["--env", "\(UpdatePolicy.overrideEnv)=\(feed)"] }
        let passthrough = Array(CommandLine.arguments.dropFirst())
        if !passthrough.isEmpty { args += ["--args"] + passthrough }
        task.arguments = args
        try? task.run()
        NSApp.terminate(nil)
    }
}
