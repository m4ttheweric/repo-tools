import AppKit
import Combine

// MARK: - ProcessPanelController

struct PanelStatus: Equatable {
    let text: String
    let isError: Bool
}

enum KillScope {
    case process  // just the row's own pids (incl. collapsed chain pids)
    case tree     // the row plus all descendant rows
}

/// Drives the process panel: polls the daemon, groups processes by repo,
/// and executes kill / copy / herdr actions on behalf of the views.
///
/// Kill lifecycle is event-driven, not timer-driven: after signaling, a
/// 250ms liveness watcher (kill(pid, 0)) tracks each target until it
/// actually dies. Dead rows are pruned from the local model immediately and
/// tombstoned so the daemon's snapshot — which lags reality by up to 10s —
/// can't resurrect them.
class ProcessPanelController: ObservableObject {
    @Published var repoGroups: [RepoGroup] = []
    @Published var lastUpdated: Date = Date()
    // Changing the repo filter changes what the outline shows, so it must
    // invalidate the view's data version like any data change.
    @Published var selectedRepo: String? = nil {
        didSet { if oldValue != selectedRepo { dataVersion += 1 } }
    }
    @Published var selection: Set<Int> = []
    @Published var isLoading = true
    @Published var isRefreshing = false
    /// Real pids (not just row pids) currently being killed; rows dim while
    /// any of their pids are in here.
    @Published var killingPids: Set<Int> = []
    /// Footer status line (kill progress, copy confirmations, herdr
    /// lookup failures). Every user action lands feedback here.
    @Published var status: PanelStatus? = nil
    /// True when the most recent daemon query returned nothing, so the
    /// empty state can say "daemon unreachable" instead of "no processes".
    @Published var lastRefreshFailed = false
    /// Bumped whenever repoGroups content changes; the outline view skips
    /// reloads for any SwiftUI update that doesn't carry a new version.
    @Published var dataVersion = 0

    private let daemonClient = DaemonClient()
    private var pollTimer: Timer?
    private var statusGeneration = 0

    private struct KillAttempt {
        let startedAt: Date
        var escalated: Bool
    }

    private var killAttempts: [Int: KillAttempt] = [:]
    /// Confirmed-dead pids → time of death. Filters stale daemon snapshots;
    /// an entry drops out once a snapshot no longer contains the pid.
    private var tombstones: [Int: Date] = [:]
    private var killWatchTimer: Timer?
    private var killBatchLabel: String? = nil

    private static let escalateAfter: TimeInterval = 5
    private static let giveUpAfter: TimeInterval = 10
    private static let tombstoneMaxAge: TimeInterval = 60

    // MARK: Polling

    func startPolling() {
        pollTimer?.invalidate()
        refresh()
        // .common mode so polls don't stall while a menu is open or the
        // user is scrolling (both put the run loop in tracking mode).
        let timer = Timer(timeInterval: 10, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    func refresh(userInitiated: Bool = false) {
        isRefreshing = true
        Task {
            let data = await daemonClient.querySystemProcesses()
            await MainActor.run {
                self.isLoading = false
                self.isRefreshing = false
                if let data = data {
                    self.lastRefreshFailed = false
                    self.applySnapshot(data)
                } else {
                    self.lastRefreshFailed = true
                    if userInitiated {
                        self.setStatus("Couldn't reach the rt daemon", isError: true)
                    }
                }
            }
        }
    }

    private func applySnapshot(_ data: SystemProcessData) {
        // Tombstones exist to mask the daemon's scan lag; once a snapshot no
        // longer contains the pid the daemon has caught up. The age cap
        // guards against pid reuse keeping an unrelated process hidden.
        let snapshotPids = Set(data.processes.flatMap(\.allPids))
        let now = Date()
        tombstones = tombstones.filter { pid, diedAt in
            snapshotPids.contains(pid) && now.timeIntervalSince(diedAt) < Self.tombstoneMaxAge
        }

        let processes = Self.pruneDead(data.processes, dead: Set(tombstones.keys))
        let grouped = Dictionary(grouping: processes, by: \.repo)
        repoGroups = grouped.map { (repo, procs) in
            RepoGroup(
                name: repo,
                processes: procs.sorted { $0.cpuPercent > $1.cpuPercent },
                totalCpu: procs.reduce(0) { $0 + ($1.totalCpuPercent ?? $1.cpuPercent) }
            )
        }.sorted { $0.name < $1.name }
        pruneStaleViewState()
        lastUpdated = Date(timeIntervalSince1970: data.updatedAt / 1000)
        dataVersion += 1
    }

    /// A snapshot can drop the filtered repo or selected rows entirely
    /// (e.g. their processes exited); a filter pointing at a vanished repo
    /// would show an empty table with no chip highlighted.
    private func pruneStaleViewState() {
        if let selected = selectedRepo, !repoGroups.contains(where: { $0.name == selected }) {
            selectedRepo = nil
        }
        let stale = selection.filter { findProcess($0) == nil }
        if !stale.isEmpty {
            selection.subtract(stale)
        }
    }

    // MARK: Kill actions

    func killAllInGroup(_ group: RepoGroup) {
        killProcesses(group.processes, scope: .tree, label: "all \(group.name) processes")
    }

    func killSelected() {
        killProcesses(selection.compactMap { findProcess($0) })
        selection.removeAll()
    }

    /// Signals every target pid, then hands them to the liveness watcher.
    /// SIGTERM first; the watcher escalates to SIGKILL after 5s and gives
    /// up (with an error status) after 10s.
    func killProcesses(_ procs: [SystemProcess], scope: KillScope = .process,
                       force: Bool = false, label: String? = nil) {
        let targets = Set(
            procs.flatMap { scope == .tree ? $0.allPids : $0.selfPids }
                .filter { $0 > 1 && tombstones[$0] == nil }
        )
        guard !targets.isEmpty else { return }
        let signal: Int32 = force ? SIGKILL : SIGTERM

        var failures: [(pid: Int, err: String)] = []
        let now = Date()
        for pid in targets {
            if sendSignal(pid, signal) {
                killAttempts[pid] = KillAttempt(startedAt: now, escalated: force)
                killingPids.insert(pid)
            } else {
                failures.append((pid, String(cString: strerror(errno))))
            }
        }
        for failure in failures {
            TrayLog.warn("kill failed", [
                "pid": failure.pid, "signal": Int(signal), "err": failure.err,
            ])
        }

        let what = label ?? describe(procs)
        if failures.isEmpty {
            killBatchLabel = what
            setStatus("Killing \(what)…", isError: false, sticky: true)
        } else if failures.count == 1, targets.count == 1 {
            setStatus("Could not kill \(what): \(failures[0].err)", isError: true)
        } else {
            setStatus(
                "Could not kill \(failures.count) of \(targets.count) processes (\(failures[0].err))",
                isError: true)
        }
        startKillWatcher()
    }

    // MARK: Kill lifecycle

    private func startKillWatcher() {
        guard killWatchTimer == nil, !killAttempts.isEmpty else { return }
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.checkKillProgress()
        }
        RunLoop.main.add(timer, forMode: .common)
        killWatchTimer = timer
    }

    private func checkKillProgress() {
        let now = Date()
        var died: [Int] = []
        var survivors: [Int] = []

        for (pid, attempt) in killAttempts {
            errno = 0
            if kill(Int32(pid), 0) != 0, errno == ESRCH {
                died.append(pid)
                continue
            }
            let age = now.timeIntervalSince(attempt.startedAt)
            if age > Self.giveUpAfter {
                survivors.append(pid)
            } else if age > Self.escalateAfter, !attempt.escalated {
                sendSignal(pid, SIGKILL)
                killAttempts[pid]?.escalated = true
                TrayLog.info("kill escalated to SIGKILL", ["pid": pid])
            }
        }

        for pid in died {
            killAttempts.removeValue(forKey: pid)
            killingPids.remove(pid)
            tombstones[pid] = now
        }
        if !died.isEmpty {
            removeDeadRows()
        }

        if !survivors.isEmpty {
            for pid in survivors {
                killAttempts.removeValue(forKey: pid)
                killingPids.remove(pid)
            }
            TrayLog.warn("processes survived SIGKILL", ["pids": survivors])
            let name: String
            if survivors.count == 1 {
                let pid = survivors[0]
                name = findProcess(pid).map { "\($0.leafName) (\(pid))" } ?? "pid \(pid)"
            } else {
                name = "\(survivors.count) processes"
            }
            setStatus("\(name) survived SIGKILL", isError: true)
            killBatchLabel = nil
        } else if killAttempts.isEmpty, let label = killBatchLabel {
            setStatus("Killed \(label)", isError: false)
            killBatchLabel = nil
        }

        if killAttempts.isEmpty {
            killWatchTimer?.invalidate()
            killWatchTimer = nil
        }
    }

    /// Drops confirmed-dead rows from the local model right away instead of
    /// waiting out the daemon's next scan.
    private func removeDeadRows() {
        let dead = Set(tombstones.keys)
        repoGroups = repoGroups.compactMap { group in
            let procs = Self.pruneDead(group.processes, dead: dead)
            guard !procs.isEmpty else { return nil }
            return RepoGroup(
                name: group.name,
                processes: procs,
                totalCpu: procs.reduce(0) { $0 + ($1.totalCpuPercent ?? $1.cpuPercent) }
            )
        }
        pruneStaleViewState()
        dataVersion += 1
    }

    /// Removes rows whose processes are all dead; surviving children of a
    /// dead parent are promoted so they stay visible until the next scan
    /// re-roots them properly.
    private static func pruneDead(_ procs: [SystemProcess], dead: Set<Int>) -> [SystemProcess] {
        guard !dead.isEmpty else { return procs }
        return procs.flatMap { proc -> [SystemProcess] in
            var copy = proc
            copy.children = pruneDead(proc.children ?? [], dead: dead)
            if Set(proc.selfPids).isSubset(of: dead) {
                return copy.children ?? []
            }
            return [copy]
        }
    }

    /// Delivers a signal to a pid; a process-group leader takes its whole
    /// group down (children included), anything else is signaled directly.
    /// kill(-pid) alone is ESRCH for non-leaders, which is most dev processes.
    @discardableResult
    private func sendSignal(_ pid: Int, _ signal: Int32) -> Bool {
        let p = Int32(pid)
        if getpgid(p) == p, kill(-p, signal) == 0 {
            return true
        }
        return kill(p, signal) == 0
    }

    private func describe(_ procs: [SystemProcess]) -> String {
        if procs.count == 1, let proc = procs.first {
            return "\(proc.leafName) (\(proc.pid))"
        }
        return "\(procs.count) processes"
    }

    /// Finds the row owning a pid — matches collapsed chain pids too, so a
    /// chain leaf resolves to its breadcrumb row.
    private func findProcess(_ pid: Int) -> SystemProcess? {
        func search(_ procs: [SystemProcess]) -> SystemProcess? {
            for proc in procs {
                if proc.selfPids.contains(pid) { return proc }
                if let match = search(proc.children ?? []) { return match }
            }
            return nil
        }
        return search(repoGroups.flatMap(\.processes))
    }

    private func setStatus(_ text: String, isError: Bool, sticky: Bool = false) {
        statusGeneration += 1
        let generation = statusGeneration
        status = PanelStatus(text: text, isError: isError)
        guard !sticky else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            if self?.statusGeneration == generation {
                self?.status = nil
            }
        }
    }

    // MARK: Info / herdr actions

    func copyProcessInfo(_ procs: [SystemProcess]) {
        let info = procs.map { proc in
            [
                "PID: \(proc.pid)",
                "Command: \(proc.fullCommand)",
                "CWD: \(proc.cwd)",
                proc.branch.map { "Branch: \($0)" },
                proc.port.map { "Port: \($0)" },
                "CPU: \(proc.cpuFormatted)",
                "Memory: \(proc.memoryMB)",
                "Uptime: \(proc.uptime)",
            ].compactMap { $0 }.joined(separator: "\n")
        }.joined(separator: "\n\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(info, forType: .string)
        setStatus("Copied info for \(describe(procs))", isError: false)
    }

    func herdrFocusProcess(_ proc: SystemProcess) {
        Task.detached {
            guard let pane = HerdrBridge.shared.findPane(forPid: proc.pid, cwd: proc.cwd) else {
                await MainActor.run {
                    self.setStatus("No herdr pane found for \(proc.leafName)", isError: true)
                }
                return
            }
            HerdrBridge.shared.focusPane(pane)
        }
    }

    func herdrCopyOutput(_ proc: SystemProcess) {
        Task.detached {
            guard let pane = HerdrBridge.shared.findPane(forPid: proc.pid, cwd: proc.cwd) else {
                await MainActor.run {
                    self.setStatus("No herdr pane found for \(proc.leafName)", isError: true)
                }
                return
            }
            let output = HerdrBridge.shared.readPaneOutput(pane.paneId)
            await MainActor.run {
                guard let output else {
                    self.setStatus("Couldn't read \(proc.leafName)'s pane", isError: true)
                    return
                }
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(output, forType: .string)
                self.setStatus("Copied recent output from \(proc.leafName)", isError: false)
            }
        }
    }

    // MARK: Derived view data

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
