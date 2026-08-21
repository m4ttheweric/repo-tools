import SwiftUI
import MattstackCore

struct DoneScreen: View {
    @ObservedObject var install: InstallRunModel
    let isOwner: Bool
    let onInvite: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(systemName: "checkmark.seal.fill").font(.system(size: 40)).foregroundStyle(.green)
                VStack(alignment: .leading) {
                    Text("Everything's working").font(.title3.weight(.semibold))
                    Text(verifySummary).foregroundStyle(.secondary)
                }
            }
            Form {
                Section("Where things live") {
                    LabeledContent("Menu bar") { Text("the m at the top right") }
                    LabeledContent("Terminal") { Text("rt — open a new terminal window").font(.system(.body, design: .monospaced)) }
                    LabeledContent("Board") { Link("https://board.mattstack", destination: URL(string: "https://board.mattstack")!) }
                }
            }
            .formStyle(.grouped).scrollDisabled(true)
            HStack {
                Button("Open the board", action: openBoard).accessibilityIdentifier(AXID.doneOpenBoard)
                if isOwner { Button("Invite teammates…", action: onInvite).accessibilityIdentifier(AXID.doneInvite) }
                Spacer()
            }
            Spacer()
        }
        .padding(24)
        .accessibilityIdentifier(AXID.doneScreen)
    }

    private var verifySummary: String {
        let verify = install.steps.first { $0.id == "verify" }
        let n = install.steps.filter { $0.state == .done }.count
        return verify?.detail.map { "\($0) · \(n) steps done" } ?? "\(n) steps done"
    }

    /// Stub mode never opens a real browser tab -- there's no real board to
    /// show, and a UI test driving this button shouldn't launch one.
    private func openBoard() {
        guard !BundleFlavor.isStubActive else {
            TrayLog.info("open board skipped (stub mode)")
            return
        }
        NSWorkspace.shared.open(URL(string: "https://board.mattstack")!)
    }
}
