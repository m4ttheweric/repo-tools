import SwiftUI
import AppKit

class ProcessPanelController: ObservableObject {
    @Published var repoGroups: [RepoGroup] = []
    @Published var lastUpdated: Date = Date()
    @Published var selectedRepo: String? = nil
    @Published var isLoading = true

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
        Task {
            guard let data = await daemonClient.querySystemProcesses() else { return }
            let grouped = Dictionary(grouping: data.processes, by: \.repo)
            let groups = grouped.map { (repo, procs) in
                RepoGroup(
                    name: repo,
                    processes: procs.sorted { $0.cpuPercent > $1.cpuPercent },
                    totalCpu: procs.reduce(0) { $0 + $1.cpuPercent }
                )
            }.sorted { $0.name < $1.name }

            await MainActor.run {
                self.repoGroups = groups
                self.lastUpdated = Date(timeIntervalSince1970: data.updatedAt / 1000)
                self.isLoading = false
            }
        }
    }

    var filteredGroups: [RepoGroup] {
        guard let selected = selectedRepo else { return repoGroups }
        return repoGroups.filter { $0.name == selected }
    }

    var totalProcessCount: Int {
        repoGroups.reduce(0) { $0 + $1.processes.count }
    }

    var repoNames: [String] {
        repoGroups.map(\.name)
    }
}

struct ProcessPanelView: View {
    @StateObject private var controller = ProcessPanelController()
    @StateObject private var columnSettings = ColumnSettings()

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
        HStack(spacing: 8) {
            // Repo filter chips
            filterChip("All", selected: controller.selectedRepo == nil) {
                controller.selectedRepo = nil
            }
            ForEach(controller.repoNames, id: \.self) { repo in
                filterChip(repo, selected: controller.selectedRepo == repo) {
                    controller.selectedRepo = repo
                }
            }

            Spacer()

            Text("\(controller.totalProcessCount) processes")
                .font(.caption)
                .foregroundColor(.secondary)

            Button(action: { controller.refresh() }) {
                Image(systemName: "arrow.clockwise")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func filterChip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(selected ? Color.accentColor.opacity(0.2) : Color.clear)
                .cornerRadius(4)
        }
        .buttonStyle(.borderless)
    }

    // MARK: - Process Table

    private var processTable: some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: .sectionHeaders) {
                ForEach(controller.filteredGroups) { group in
                    Section {
                        ForEach(group.processes) { proc in
                            ProcessRowView(
                                process: proc,
                                columnSettings: columnSettings
                            )
                        }
                    } header: {
                        repoHeader(group)
                    }
                }
            }
        }
    }

    private func repoHeader(_ group: RepoGroup) -> some View {
        HStack {
            Text(group.name)
                .font(.caption.weight(.semibold))
            Spacer()
            Text(String(format: "%.1f%% CPU", group.totalCpu))
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(.bar)
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

// MARK: - Process Row

struct ProcessRowView: View {
    let process: SystemProcess
    @ObservedObject var columnSettings: ColumnSettings

    var body: some View {
        HStack(spacing: 0) {
            if process.isRunaway {
                Circle()
                    .fill(Color.orange)
                    .frame(width: 6, height: 6)
                    .padding(.trailing, 4)
            }

            if columnSettings.visibleColumns.contains(.command) {
                Text(process.command)
                    .font(.system(.caption, design: .monospaced))
                    .frame(minWidth: 80, alignment: .leading)
                    .lineLimit(1)
            }
            if columnSettings.visibleColumns.contains(.cpu) {
                Text(process.cpuFormatted)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(process.cpuPercent > 80 ? .orange : .primary)
                    .frame(width: 50, alignment: .trailing)
            }
            if columnSettings.visibleColumns.contains(.memory) {
                Text(process.memoryMB)
                    .font(.system(.caption, design: .monospaced))
                    .frame(width: 60, alignment: .trailing)
            }
            if columnSettings.visibleColumns.contains(.port) {
                Text(process.portFormatted)
                    .font(.system(.caption, design: .monospaced))
                    .frame(width: 50, alignment: .trailing)
            }
            if columnSettings.visibleColumns.contains(.branch) {
                Text(process.branch ?? "---")
                    .font(.caption)
                    .frame(minWidth: 100, alignment: .leading)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if columnSettings.visibleColumns.contains(.linearTicket) {
                Text(process.linearTicket ?? "---")
                    .font(.caption)
                    .frame(minWidth: 120, alignment: .leading)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if columnSettings.visibleColumns.contains(.pid) {
                Text("\(process.pid)")
                    .font(.system(.caption, design: .monospaced))
                    .frame(width: 50, alignment: .trailing)
            }
            if columnSettings.visibleColumns.contains(.uptime) {
                Text(process.uptime)
                    .font(.system(.caption, design: .monospaced))
                    .frame(width: 70, alignment: .trailing)
            }
            if columnSettings.visibleColumns.contains(.worktree) {
                Text(process.relativeDir)
                    .font(.caption)
                    .frame(minWidth: 80, alignment: .leading)
                    .lineLimit(1)
            }
            if columnSettings.visibleColumns.contains(.cwd) {
                Text(process.cwd)
                    .font(.caption)
                    .frame(minWidth: 120, alignment: .leading)
                    .lineLimit(1)
            }
            if columnSettings.visibleColumns.contains(.fullCommand) {
                Text(process.fullCommand)
                    .font(.system(.caption, design: .monospaced))
                    .frame(minWidth: 120, alignment: .leading)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(process.isRunaway ? Color.orange.opacity(0.08) : Color.clear)
        .contextMenu {
            Button("Kill Process") {
                killProcess(process.pid)
            }
            Button("Force Kill") {
                killProcess(process.pid, force: true)
            }
            Divider()
            Button("Copy Info") {
                copyInfo(process)
            }
            Divider()
            // Column visibility submenu
            Menu("Columns") {
                ForEach(ProcessColumn.allCases, id: \.self) { col in
                    Toggle(col.rawValue, isOn: Binding(
                        get: { columnSettings.visibleColumns.contains(col) },
                        set: { _ in columnSettings.toggle(col) }
                    ))
                }
            }
        }
    }

    private func killProcess(_ pid: Int, force: Bool = false) {
        guard pid > 1 else { return }
        let signal: Int32 = force ? SIGKILL : SIGTERM
        // Kill the process group (same pattern as ProcessManager.killGroup)
        let pgid = -Int32(pid)
        kill(pgid, signal)

        if !force {
            // Schedule force-kill check after 5 seconds
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                // Check if process still exists
                if kill(Int32(pid), 0) == 0 {
                    NSLog("rt-tray: process \(pid) still alive after SIGTERM, sending SIGKILL")
                    kill(pgid, SIGKILL)
                }
            }
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
