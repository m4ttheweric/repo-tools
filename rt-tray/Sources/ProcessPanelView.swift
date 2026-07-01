import SwiftUI
import AppKit

class ProcessPanelController: ObservableObject {
    @Published var repoGroups: [RepoGroup] = []
    @Published var lastUpdated: Date = Date()
    @Published var selectedRepo: String? = nil
    @Published var selection: Set<Int> = []
    @Published var isLoading = true
    @Published var isRefreshing = false
    @Published var killingGroup: String? = nil

    private let daemonClient = DaemonClient()
    private var pollTimer: Timer?

    func startPolling() {
        refresh()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    func refresh() {
        isRefreshing = true
        Task {
            guard let data = await daemonClient.querySystemProcesses() else {
                await MainActor.run {
                    self.isLoading = false
                    self.isRefreshing = false
                }
                return
            }
            let grouped = Dictionary(grouping: data.processes, by: \.repo)
            let groups = grouped.map { (repo, procs) in
                RepoGroup(
                    name: repo,
                    processes: procs.sorted { $0.cpuPercent > $1.cpuPercent },
                    totalCpu: procs.reduce(0) { $0 + ($1.totalCpuPercent ?? $1.cpuPercent) }
                )
            }.sorted { $0.name < $1.name }

            await MainActor.run {
                self.repoGroups = groups
                self.lastUpdated = Date(timeIntervalSince1970: data.updatedAt / 1000)
                self.isLoading = false
                self.isRefreshing = false
            }
        }
    }

    func killAllInGroup(_ group: RepoGroup) {
        killingGroup = group.name
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            for proc in group.processes {
                for pid in proc.allPids {
                    guard pid > 1 else { continue }
                    kill(-Int32(pid), SIGTERM)
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                self?.killingGroup = nil
                self?.refresh()
            }
        }
    }

    func killSelected() {
        for pid in selection {
            guard pid > 1 else { continue }
            kill(-Int32(pid), SIGTERM)
        }
        selection.removeAll()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.refresh()
        }
    }

    var filteredGroups: [RepoGroup] {
        guard let selected = selectedRepo else { return repoGroups }
        return repoGroups.filter { $0.name == selected }
    }

    var totalProcessCount: Int {
        func countTree(_ proc: SystemProcess) -> Int {
            return 1 + (proc.children ?? []).reduce(0) { $0 + countTree($1) }
        }
        return repoGroups.flatMap(\.processes).reduce(0) { $0 + countTree($1) }
    }

    var repoNames: [String] {
        repoGroups.map(\.name)
    }
}

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
        .frame(width: 700, height: 500)
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

    // MARK: - Process Table

    private var processTable: some View {
        List(selection: $controller.selection) {
            ForEach(controller.filteredGroups) { group in
                Section {
                    ForEach(group.processes) { proc in
                        ProcessTreeRow(
                            process: proc,
                            columnSettings: columnSettings,
                            controller: controller
                        )
                    }
                } header: {
                    repoHeader(group)
                }
            }
        }
        .listStyle(.inset(alternatesRowBackgrounds: true))
        .environment(\.defaultMinListRowHeight, 24)
    }

    private func repoHeader(_ group: RepoGroup) -> some View {
        HStack {
            Text(group.name)
                .font(.caption.weight(.semibold))
            Text("(\(group.processes.count))")
                .font(.caption)
                .foregroundColor(.secondary)
            Spacer()
            Text(String(format: "%.1f%% CPU", group.totalCpu))
                .font(.caption)
                .foregroundColor(.secondary)

            if controller.killingGroup == group.name {
                ProgressView()
                    .controlSize(.small)
                    .padding(.horizontal, 4)
                Text("Killing...")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            } else {
                PanelButton(
                    label: "Kill All",
                    icon: nil,
                    role: .destructive,
                    action: { controller.killAllInGroup(group) }
                )
            }
        }
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
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }
}

// MARK: - Process Tree Row (handles disclosure for children)

struct ProcessTreeRow: View {
    let process: SystemProcess
    @ObservedObject var columnSettings: ColumnSettings
    @ObservedObject var controller: ProcessPanelController

    var body: some View {
        if process.hasChildren {
            DisclosureGroup {
                ForEach(process.children ?? []) { child in
                    ProcessTreeRow(process: child, columnSettings: columnSettings, controller: controller)
                }
            } label: {
                processColumns(process, showChildCount: true)
            }
            .tag(process.pid)
            .contextMenu { processContextMenu(process) }
        } else {
            processColumns(process, showChildCount: false)
                .tag(process.pid)
                .contextMenu { processContextMenu(process) }
        }
    }

    private func processColumns(_ proc: SystemProcess, showChildCount: Bool) -> some View {
        HStack(spacing: 6) {
            if proc.isRunaway {
                Circle()
                    .fill(Color.orange)
                    .frame(width: 6, height: 6)
            }

            if columnSettings.visibleColumns.contains(.command) {
                HStack(spacing: 4) {
                    Text(proc.command)
                        .font(.system(.caption, design: .monospaced))
                    if showChildCount {
                        Text("+\(proc.childCount)")
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundColor(.secondary)
                    }
                }
                .frame(minWidth: 80, alignment: .leading)
                .lineLimit(1)
            }
            if columnSettings.visibleColumns.contains(.cpu) {
                Text(proc.cpuFormatted)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(proc.cpuPercent > 80 ? .orange : .primary)
                    .frame(width: 45, alignment: .trailing)
            }
            if columnSettings.visibleColumns.contains(.memory) {
                Text(proc.memoryMB)
                    .font(.system(.caption, design: .monospaced))
                    .frame(width: 55, alignment: .trailing)
            }
            if columnSettings.visibleColumns.contains(.port) {
                Text(proc.portFormatted)
                    .font(.system(.caption, design: .monospaced))
                    .frame(width: 45, alignment: .trailing)
            }
            if columnSettings.visibleColumns.contains(.branch) {
                Text(proc.branch ?? "")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .frame(minWidth: 100, alignment: .leading)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if columnSettings.visibleColumns.contains(.linearTicket) {
                Text(proc.linearTicket ?? "")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .frame(minWidth: 100, alignment: .leading)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if columnSettings.visibleColumns.contains(.pid) {
                Text("\(proc.pid)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(.secondary)
                    .frame(width: 50, alignment: .trailing)
            }
            if columnSettings.visibleColumns.contains(.uptime) {
                Text(proc.uptime)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(.secondary)
                    .frame(width: 65, alignment: .trailing)
            }
            if columnSettings.visibleColumns.contains(.worktree) {
                Text(proc.relativeDir)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .frame(minWidth: 80, alignment: .leading)
                    .lineLimit(1)
            }
            if columnSettings.visibleColumns.contains(.cwd) {
                Text(proc.cwd)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .frame(minWidth: 100, alignment: .leading)
                    .lineLimit(1)
            }
            if columnSettings.visibleColumns.contains(.fullCommand) {
                Text(proc.fullCommand)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(.secondary)
                    .frame(minWidth: 100, alignment: .leading)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private func processContextMenu(_ proc: SystemProcess) -> some View {
        Button("Kill Process") {
            killProcess(proc.pid)
        }
        if proc.hasChildren {
            Button("Kill Process Tree (\(proc.childCount + 1))") {
                for pid in proc.allPids {
                    killProcess(pid)
                }
            }
        }
        Button("Force Kill (SIGKILL)") {
            killProcess(proc.pid, force: true)
        }
        Divider()
        Button("Copy Info") {
            copyInfo(proc)
        }
        if HerdrBridge.shared.isAvailable {
            Divider()
            Button("Focus in Herdr") {
                Task.detached {
                    if let pane = HerdrBridge.shared.findPane(forPid: proc.pid, cwd: proc.cwd) {
                        HerdrBridge.shared.focusPane(pane)
                    }
                }
            }
            Button("Read Output") {
                Task.detached {
                    if let pane = HerdrBridge.shared.findPane(forPid: proc.pid, cwd: proc.cwd) {
                        if let output = HerdrBridge.shared.readPaneOutput(pane.paneId) {
                            await MainActor.run {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(output, forType: .string)
                            }
                        }
                    }
                }
            }
        }
    }

    private func killProcess(_ pid: Int, force: Bool = false) {
        guard pid > 1 else { return }
        let signal: Int32 = force ? SIGKILL : SIGTERM
        kill(-Int32(pid), signal)
        if !force {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                if kill(Int32(pid), 0) == 0 {
                    kill(-Int32(pid), SIGKILL)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak controller] in
            controller?.refresh()
        }
    }

    private func copyInfo(_ proc: SystemProcess) {
        let info = [
            "PID: \(proc.pid)",
            "Command: \(proc.fullCommand)",
            "CWD: \(proc.cwd)",
            proc.branch.map { "Branch: \($0)" },
            proc.port.map { "Port: \($0)" },
            "CPU: \(proc.cpuFormatted)",
            "Memory: \(proc.memoryMB)",
            "Uptime: \(proc.uptime)",
        ].compactMap { $0 }.joined(separator: "\n")

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(info, forType: .string)
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

// MARK: - Double-Click (AppKit gesture, doesn't interfere with List selection)

struct DoubleClickOverlay: NSViewRepresentable {
    let action: () -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let gesture = NSClickGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.onDoubleClick))
        gesture.numberOfClicksRequired = 2
        gesture.delaysPrimaryMouseButtonEvents = false
        view.addGestureRecognizer(gesture)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(action: action)
    }

    class Coordinator: NSObject {
        let action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func onDoubleClick() { action() }
    }
}

extension View {
    func onDoubleClick(perform action: @escaping () -> Void) -> some View {
        overlay { DoubleClickOverlay(action: action) }
    }
}
