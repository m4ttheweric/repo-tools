import SwiftUI
import MattstackCore

struct InstallScreen: View {
    @ObservedObject var model: InstallRunModel
    @State private var logFor: InstallStep?
    @State private var showNotes = false

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    ForEach(model.steps) { step in stepRow(step) }
                } header: {
                    Text(headerText)
                }
            }
            .formStyle(.grouped)
            if !model.streamNotes.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "info.circle").foregroundStyle(.secondary)
                    Text("\(model.streamNotes.count) diagnostic note\(model.streamNotes.count == 1 ? "" : "s")")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("View") { showNotes = true }.controlSize(.small).accessibilityIdentifier(AXID.installNotes)
                }
                .padding(.horizontal, 20).padding(.vertical, 4)
            }
            if case .streamError(let e) = model.phase {
                HStack {
                    Label("Install stopped: \(e)", systemImage: "xmark.circle").foregroundStyle(.red).font(.callout)
                    Spacer()
                    Button("Retry") { model.retryFromFailure() }.accessibilityIdentifier(AXID.installRetryStream)
                }
                .padding(.horizontal, 20).padding(.vertical, 8)
            }
        }
        .sheet(item: $logFor) { s in LogSheet(title: s.info.title, lines: model.logLines(for: s.id)) }
        .sheet(isPresented: $showNotes) { LogSheet(title: "Diagnostic notes", lines: model.streamNotes) }
        .accessibilityIdentifier(AXID.installScreen)
    }

    private var headerText: String {
        switch model.phase {
        case .idle: return "Ready to install."
        case .running: return "Installing… nothing runs that isn't listed here."
        case .succeeded: return "Installed."
        case .failed(let id, _): return "Stopped at \(model.steps.first { $0.id == id }?.info.title ?? id)."
        case .streamError: return "Install stopped."
        }
    }

    @ViewBuilder
    private func stepRow(_ step: InstallStep) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                StatusBadge(status: badge(step), id: AXID.installStepStatus(step.id))
                VStack(alignment: .leading, spacing: 2) {
                    Text(step.info.title)
                    if step.waitingOnYou {
                        Text(step.info.kind == .privileged ? "Waiting for you — an administrator prompt is open." : "Waiting for you — approve mattstack in Login Items if asked.")
                            .font(.caption).foregroundStyle(.orange)
                    } else if let d = step.detail, !d.isEmpty {
                        Text(d).font(.caption).foregroundStyle(step.state == .failed ? .red : .secondary)
                    }
                }
                Spacer()
                if !model.logLines(for: step.id).isEmpty {
                    Button("Show log") { logFor = step }.controlSize(.small).accessibilityIdentifier(AXID.installStepLog(step.id))
                }
            }
            if step.state == .failed, model.failedStepId == step.id {
                HStack(alignment: .top) {
                    if let r = step.remedy { Text(r).font(.callout) }
                    Spacer()
                    Button("Retry from here") { model.retryFromFailure() }
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier(AXID.installRetry)
                }
                .padding(.top, 2)
            }
        }
        .accessibilityIdentifier(AXID.installStep(step.id))
    }

    private func badge(_ step: InstallStep) -> RowStatus {
        switch step.state {
        case .pending: return .skipped
        case .running: return step.waitingOnYou ? .needsYou : .checking
        case .done: return .ready
        case .failed: return .error
        case .skipped: return .skipped
        case .unknown: return .error
        }
    }
}
