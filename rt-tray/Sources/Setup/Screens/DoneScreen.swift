import SwiftUI
import MattstackCore

struct DoneScreen: View {
    @ObservedObject var install: InstallRunModel
    @ObservedObject var readiness: ReadinessModel
    let isOwner: Bool
    let onInvite: () -> Void
    @State private var steps: (title: String, steps: [String])?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(systemName: headlineSymbol).font(.system(size: 40)).foregroundStyle(headlineTint)
                VStack(alignment: .leading) {
                    Text(headline).font(.title3.weight(.semibold))
                    Text(verifySummary).foregroundStyle(.secondary)
                }
            }
            Form {
                Section("Where things live") {
                    LabeledContent("Menu bar") { Text("the m at the top right") }
                    LabeledContent("Terminal") { Text("rt — open a new terminal window").font(.system(.body, design: .monospaced)) }
                    LabeledContent("Board") { Link("https://board.mattstack", destination: URL(string: "https://board.mattstack")!) }
                }
                if !readiness.outstandingManualRows.isEmpty {
                    Section("Still to do") {
                        ForEach(readiness.outstandingManualRows) { row in
                            RowView(row: row, isChecking: false, rowID: AXID.doneStillToDoRow(row.id)) { show(row) }
                        }
                    }
                    .accessibilityIdentifier(AXID.doneStillToDo)
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
        .task { await readiness.recheckAll() }
        .sheet(isPresented: Binding(get: { steps != nil }, set: { presented in
            guard !presented else { return }
            steps = nil
            // The row's real state changes outside the app (Chrome, a
            // download) -- only the sheet's dismissal tells us to look again.
            Task { await readiness.recheckAll() }
        })) {
            if let steps { StepsSheet(title: steps.title, steps: steps.steps) }
        }
        // .contain: without it, the plain HStack's buttons (Open the board,
        // Invite teammates…) report THIS screen-level identifier instead of
        // their own -- same fix as InstallScreen's stepRow and ChecklistScreen.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AXID.doneScreen)
    }

    private var outstanding: Int { readiness.outstandingManualRows.count }
    private var headline: String { outstanding == 0 ? "Everything's working" : "Installed, with \(outstanding) step\(outstanding == 1 ? "" : "s") left for you" }
    private var headlineSymbol: String { outstanding == 0 ? "checkmark.seal.fill" : "checkmark.seal" }
    private var headlineTint: Color { outstanding == 0 ? .green : .accentColor }

    private func show(_ row: PlanRow) {
        guard let action = row.action else { return }
        if action.type == .openURL, let raw = action.url, let url = URL(string: raw), url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url)
            Task { await readiness.recheckAll() }
            return
        }
        steps = (title: row.title, steps: action.steps ?? [])
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
