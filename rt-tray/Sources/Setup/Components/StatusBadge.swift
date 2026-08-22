import SwiftUI
import MattstackCore

struct StatusBadge: View {
    let status: RowStatus
    var id: String? = nil
    var body: some View {
        let symbol = StatusGlyph.symbol(for: status)
        let badge = Group {
            if symbol == "progress" {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: symbol).foregroundStyle(color)
            }
        }
        .frame(width: 20, height: 20)
        .accessibilityLabel(Text(status.rawValue))
        .accessibilityValue(Text(status.rawValue))
        if let id {
            badge.accessibilityIdentifier(id)
        } else {
            badge
        }
    }
    private var color: Color {
        switch StatusGlyph.tint(for: status) {
        case .green: return .green
        case .red: return .red
        case .yellow: return .yellow
        case .grey: return .secondary
        case .none: return .primary
        }
    }
}
