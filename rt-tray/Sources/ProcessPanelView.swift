import SwiftUI
import AppKit

// MARK: - Main View

struct ProcessPanelView: View {
    /// True when hosted in the standalone window, where the pop-out
    /// button would be a no-op pointing at itself.
    var isDetached: Bool = false

    @StateObject private var controller = ProcessPanelController()
    @StateObject private var columnSettings = ColumnSettings()
    @State private var showColumnPicker = false

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider()
            if controller.isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if controller.filteredGroups.isEmpty {
                emptyState
            } else {
                processTable
            }
            Divider()
            footerBar
        }
        .frame(minWidth: 600, idealWidth: 900, maxWidth: .infinity,
               minHeight: 400, idealHeight: 600, maxHeight: .infinity)
        .onAppear { controller.startPolling() }
        .onDisappear { controller.stopPolling() }
    }

    // MARK: - Header

    private var headerBar: some View {
        HStack(spacing: 6) {
            // Scrolls so a long repo list can never push the action
            // cluster off the right edge.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    PanelChip("All", selected: controller.selectedRepo == nil) {
                        controller.selectedRepo = nil
                    }
                    ForEach(controller.repoNames, id: \.self) { repo in
                        PanelChip(repo, selected: controller.selectedRepo == repo) {
                            controller.selectedRepo = repo
                        }
                    }
                }
            }

            Spacer(minLength: 12)

            if !controller.selection.isEmpty {
                PanelButton(
                    label: "Kill \(controller.selection.count)",
                    icon: "xmark.circle",
                    role: .destructive,
                    action: { controller.killSelected() }
                )
                .help("Kill the selected processes")
            }

            Text(processCountText)
                .font(.caption)
                .foregroundColor(.secondary)

            PanelButton(label: nil, icon: "slider.horizontal.3", action: {
                showColumnPicker.toggle()
            })
            .help("Configure columns")
            .popover(isPresented: $showColumnPicker) {
                columnPickerView
            }

            PanelButton(
                label: nil,
                icon: "arrow.clockwise",
                isLoading: controller.isRefreshing,
                action: { controller.refresh(userInitiated: true) }
            )
            .help("Refresh")

            if !isDetached {
                PanelButton(label: nil, icon: "arrow.up.left.and.arrow.down.right", action: {
                    NotificationCenter.default.post(name: .detachProcessPanel, object: nil)
                })
                .help("Open in window")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var processCountText: String {
        let count = controller.totalProcessCount
        return count == 1 ? "1 process" : "\(count) processes"
    }

    private var columnPickerView: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Columns")
                .font(.caption.weight(.semibold))
                .padding(.bottom, 2)
            ForEach(ProcessColumn.allCases, id: \.self) { col in
                Toggle(col.rawValue, isOn: Binding(
                    get: { columnSettings.visibleColumns.contains(col) },
                    set: { _ in columnSettings.toggle(col) }
                ))
                .font(.caption)
                .toggleStyle(.checkbox)
                // ColumnSettings.toggle refuses to hide the last column;
                // disable the checkbox so that isn't a silent no-op.
                .disabled(columnSettings.visibleColumns == [col])
            }
        }
        .padding(12)
    }

    // MARK: - Process Table (NSOutlineView)

    private var processTable: some View {
        ProcessOutlineView(
            groups: controller.filteredGroups,
            visibleColumns: columnSettings.visibleColumns,
            killingPids: controller.killingPids,
            selection: controller.selection,
            dataVersion: controller.dataVersion,
            controller: controller
        )
    }

    // MARK: - Empty & Footer

    private var emptyState: some View {
        VStack(spacing: 8) {
            if controller.lastRefreshFailed {
                Image(systemName: "exclamationmark.triangle")
                    .font(.title)
                    .foregroundColor(.secondary)
                Text("Can't reach the rt daemon")
                    .font(.caption)
                    .foregroundColor(.secondary)
                PanelButton(label: "Retry", icon: "arrow.clockwise", action: {
                    controller.refresh(userInitiated: true)
                })
            } else {
                Image(systemName: "checkmark.circle")
                    .font(.title)
                    .foregroundColor(.secondary)
                Text("No processes running")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var footerBar: some View {
        HStack {
            Text("Updated \(controller.lastUpdated, style: .relative) ago")
                .font(.caption2)
                .foregroundColor(.secondary)
            Spacer()
            if let status = controller.status {
                Text(status.text)
                    .font(.caption2)
                    .foregroundColor(status.isError ? .red : .secondary)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .animation(.easeInOut(duration: 0.2), value: controller.status)
    }
}

// MARK: - Reusable UI Components

struct PanelChip: View {
    let label: String
    let selected: Bool
    let action: () -> Void

    @State private var isHovering = false

    init(_ label: String, selected: Bool, action: @escaping () -> Void) {
        self.label = label
        self.selected = selected
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.caption)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(chipBackground)
                .cornerRadius(4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .onHover { isHovering = $0 }
    }

    private var chipBackground: Color {
        if selected {
            return Color.accentColor.opacity(isHovering ? 0.28 : 0.2)
        }
        if isHovering {
            return Color.primary.opacity(0.06)
        }
        return Color.clear
    }
}

struct PanelButton: View {
    let label: String?
    let icon: String?
    var role: ButtonRole? = nil
    var isLoading: Bool = false
    let action: () -> Void

    @State private var isHovering = false

    enum ButtonRole {
        case destructive
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3) {
                // Fixed slot: the spinner and the icon it replaces render
                // at slightly different sizes, which otherwise makes the
                // whole header shuffle on every refresh.
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .scaleEffect(0.7)
                        .frame(width: 14, height: 14)
                } else if let icon = icon {
                    Image(systemName: icon)
                        .font(.caption)
                        .frame(width: 14, height: 14)
                }
                if let label = label {
                    Text(label)
                        .font(.caption2)
                }
            }
            .foregroundColor(foregroundColor)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(isHovering ? hoverBackground : Color.clear)
            .cornerRadius(4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(isLoading)
        .onHover { isHovering = $0 }
    }

    private var foregroundColor: Color {
        if isLoading { return .secondary }
        if role == .destructive { return .red }
        return isHovering ? .primary : .secondary
    }

    private var hoverBackground: Color {
        if role == .destructive { return Color.red.opacity(0.1) }
        return Color.primary.opacity(0.06)
    }
}
