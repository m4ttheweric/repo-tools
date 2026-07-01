import AppKit
import Combine

// MARK: - ProcessPanelController

/// Drives the process panel: polls the daemon, groups processes by repo,
/// and executes kill / copy / herdr actions on behalf of the views.
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
        pollTimer?.invalidate()
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

    func killProcess(_ pid: Int, force: Bool = false) {
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
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.refresh()
        }
    }

    func killProcessTree(_ proc: SystemProcess) {
        for pid in proc.allPids {
            killProcess(pid)
        }
    }

    func copyProcessInfo(_ proc: SystemProcess) {
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

    func herdrFocusProcess(_ proc: SystemProcess) {
        Task.detached {
            if let pane = HerdrBridge.shared.findPane(forPid: proc.pid, cwd: proc.cwd) {
                HerdrBridge.shared.focusPane(pane)
            }
        }
    }

    func herdrReadOutput(_ proc: SystemProcess) {
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
