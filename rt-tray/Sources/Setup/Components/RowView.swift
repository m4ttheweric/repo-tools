import SwiftUI
import MattstackCore

struct RowView: View {
    let row: PlanRow
    let isChecking: Bool
    var rowID: String? = nil       // Settings → Permissions passes its own ids
    var actionID: String? = nil
    var statusID: String? = nil
    let onAction: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol(for: row.kind)).frame(width: 22).foregroundStyle(.secondary).padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(row.title).fontWeight(.medium)
                    if !row.required { Text("optional").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(Color.secondary.opacity(0.15))) }
                }
                Text(row.why).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let d = row.detail, !d.isEmpty { Text(d).font(.caption).foregroundStyle(.secondary) }
                if let n = row.optionalNote { Text(n).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 8)
            StatusBadge(status: isChecking ? .checking : row.status, id: statusID ?? AXID.checklistRowStatus(row.id))
            if let action = row.action, action.type != .unknown {
                Button(action.label, action: onAction)
                    .controlSize(.regular)
                    .accessibilityIdentifier(actionID ?? AXID.checklistRowAction(row.id))
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(rowID ?? AXID.checklistRow(row.id))
    }

    private func symbol(for kind: RowKind) -> String {
        switch kind {
        case .permission: return "lock.shield"
        case .tool: return "wrench.and.screwdriver"
        case .account: return "person.crop.circle"
        case .access: return "network"
        case .info: return "info.circle"
        }
    }
}
