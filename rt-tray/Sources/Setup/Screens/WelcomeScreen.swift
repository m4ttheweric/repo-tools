import SwiftUI

struct WelcomeScreen: View {
    private let bullets: [(String, String)] = [
        ("terminal", "Install the rt command into ~/.local/bin and add one PATH line to your shell rc."),
        ("gearshape.2", "Run background services: the rt daemon, deck, board, and gitq."),
        ("sparkles", "Install the mattstack skills into Claude Code."),
        ("puzzlepiece.extension", "Install the editor extension."),
        ("lock.shield", "Ask for Full Disk Access and background-item approval."),
    ]
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 56, height: 56)
                Text("mattstack sets up your Mac for the team: one app, one menu-bar item, everything else underneath.")
                    .font(.body)
            }
            Text("Setup will:").font(.headline)
            ForEach(bullets, id: \.1) { b in
                Label { Text(b.1) } icon: { Image(systemName: b.0).frame(width: 20) }
            }
            Spacer()
            Text("Everything here is reversible from Settings → Uninstall.").font(.callout).foregroundStyle(.secondary)
        }
        .padding(24)
        .accessibilityIdentifier(AXID.welcomeScreen)
    }
}
