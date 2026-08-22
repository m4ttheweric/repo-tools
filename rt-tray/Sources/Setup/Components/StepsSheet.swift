import SwiftUI

struct StepsSheet: View {
    let title: String
    let steps: [String]
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                HStack(alignment: .top) { Text("\(i + 1).").monospacedDigit(); Text(s).textSelection(.enabled) }
            }
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction).accessibilityIdentifier(AXID.stepsDone) }
        }
        .padding(20).frame(width: 440)
    }
}
