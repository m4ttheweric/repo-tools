import SwiftUI
import AppKit

// MARK: - Main View

struct ProcessPanelView: View {
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
            PanelChip("All", selected: controller.selectedRepo == nil) {
                controller.selectedRepo = nil
            }
            ForEach(controller.repoNames, id: \.self) { repo in
                PanelChip(repo, selected: controller.selectedRepo == repo) {
                    controller.selectedRepo = repo
                }
            }

            Spacer()

            if !controller.selection.isEmpty {
                PanelButton(
                    label: "Kill \(controller.selection.count)",
                    icon: "xmark.circle",
                    role: .destructive,
                    action: { controller.killSelected() }
                )
            }

            Text("\(controller.totalProcessCount) processes")
                .font(.caption)
                .foregroundColor(.secondary)

            PanelButton(label: nil, icon: "line.3.horizontal.decrease", action: {
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
                action: { controller.refresh() }
            )
            .help("Refresh")

            PanelButton(label: nil, icon: "arrow.up.left.and.arrow.down.right", action: {
                NotificationCenter.default.post(name: .detachProcessPanel, object: nil)
            })
            .help("Open in window")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
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
            Image(systemName: "checkmark.circle")
                .font(.title)
                .foregroundColor(.secondary)
            Text("No processes running")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var footerBar: some View {
        HStack {
            Text("Updated \(controller.lastUpdated, style: .relative) ago")
                .font(.caption2)
                .foregroundColor(.secondary)
            Spacer()
            if let status = controller.killStatus {
                Text(status.text)
                    .font(.caption2)
                    .foregroundColor(status.isError ? .red : .secondary)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .animation(.easeInOut(duration: 0.2), value: controller.killStatus)
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
                .padding(.vertical, 3)
                .background(chipBackground)
                .cornerRadius(4)
        }
        .buttonStyle(.borderless)
        .onHover { isHovering = $0 }
    }

    private var chipBackground: Color {
        if selected {
            return Color.accentColor.opacity(0.2)
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
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .scaleEffect(0.7)
                } else if let icon = icon {
                    Image(systemName: icon)
                        .font(.caption)
                }
                if let label = label {
                    Text(label)
                        .font(.caption2)
                }
            }
            .foregroundColor(foregroundColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(isHovering ? hoverBackground : Color.clear)
            .cornerRadius(4)
        }
        .buttonStyle(.borderless)
        .disabled(isLoading)
        .onHover { isHovering = $0 }
    }

    private var foregroundColor: Color {
        if isLoading { return .secondary }
        if role == .destructive { return .red }
        return .secondary
    }

    private var hoverBackground: Color {
        if role == .destructive { return Color.red.opacity(0.1) }
        return Color.primary.opacity(0.06)
    }
}
