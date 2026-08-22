import SwiftUI

struct LogSheet: View {
    let title: String
    let lines: [String]
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            ScrollView {
                Text(lines.isEmpty ? "(no log lines)" : lines.joined(separator: "\n"))
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: 260)
            .background(Color(nsColor: .textBackgroundColor))
            HStack {
                Button("Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string) }
                    .accessibilityIdentifier(AXID.logCopy)
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction).accessibilityIdentifier(AXID.logDone)
            }
        }
        .padding(20).frame(width: 520)
    }
}
