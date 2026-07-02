import Foundation

/// A pane discovered via `herdr pane list`, before any process matching.
private struct HerdrPaneListEntry: Decodable {
    let paneId: String
    let tabId: String
    let workspaceId: String
    let cwd: String?

    enum CodingKeys: String, CodingKey {
        case paneId = "pane_id"
        case tabId = "tab_id"
        case workspaceId = "workspace_id"
        case cwd
    }
}

private struct HerdrPaneListResult: Decodable {
    let panes: [HerdrPaneListEntry]
}

private struct HerdrEnvelope<T: Decodable>: Decodable {
    let result: T?
}

private struct HerdrProcessInfo: Decodable {
    let shellPid: Int?
    let foregroundProcesses: [HerdrForegroundProcess]?

    enum CodingKeys: String, CodingKey {
        case shellPid = "shell_pid"
        case foregroundProcesses = "foreground_processes"
    }
}

private struct HerdrForegroundProcess: Decodable {
    let pid: Int?
}

private struct HerdrProcessInfoResult: Decodable {
    let processInfo: HerdrProcessInfo

    enum CodingKeys: String, CodingKey {
        case processInfo = "process_info"
    }
}

/// A herdr pane that has been matched to a specific PID.
struct HerdrPane {
    let paneId: String
    let tabId: String
    let workspaceId: String
}

/// Bridges rt-tray to a running herdr instance over its CLI.
///
/// herdr's `pane list` has no notion of PID — panes are matched to
/// processes via `pane process-info`, which is more expensive, so
/// `findPane` first narrows candidates by cwd before shelling out
/// per-pane. There is no `pane focus <id>`; focusing a pane means
/// focusing its owning tab and workspace instead.
class HerdrBridge {
    static let shared = HerdrBridge()

    private let cacheLock = NSLock()
    private var _isAvailable: Bool?
    private var lastCheck: Date?
    private var _paneRootPids: Set<Int>?
    private var lastRootsFetch: Date?

    /// Read from both the main thread (context menus) and detached tasks
    /// (focus/read-output), so the cache is guarded by a lock.
    var isAvailable: Bool {
        // Cache for 30 seconds so hovering the context menu doesn't stat
        // the socket (or shell out) on every render.
        cacheLock.lock()
        if let cached = _isAvailable,
           let last = lastCheck,
           Date().timeIntervalSince(last) < 30 {
            cacheLock.unlock()
            return cached
        }
        cacheLock.unlock()

        let result = checkAvailable()
        cacheLock.lock()
        _isAvailable = result
        lastCheck = Date()
        cacheLock.unlock()
        return result
    }

    private func checkAvailable() -> Bool {
        if ProcessInfo.processInfo.environment["HERDR_ENV"] == "1" {
            return true
        }
        if let sockPath = ProcessInfo.processInfo.environment["HERDR_SOCKET_PATH"],
           FileManager.default.fileExists(atPath: sockPath) {
            return true
        }
        let sock = "\(NSHomeDirectory())/.config/herdr/herdr.sock"
        return FileManager.default.fileExists(atPath: sock)
    }

    private func herdrPath() -> String {
        let candidates = [
            "\(NSHomeDirectory())/.local/bin/herdr",
            "/opt/homebrew/bin/herdr",
            "/usr/local/bin/herdr",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
            ?? "herdr"
    }

    /// Runs a herdr subcommand and returns its stdout, or nil on failure.
    /// Failures (spawn error or nonzero exit) are logged with stderr by
    /// TrayLog.runLogged so a broken herdr integration leaves a trace.
    @discardableResult
    private func run(_ arguments: [String]) -> Data? {
        TrayLog.runLogged(herdrPath(), arguments, label: "herdr \(arguments.first ?? "")")
    }

    private func listPanes() -> [HerdrPaneListEntry] {
        guard let data = run(["pane", "list"]) else { return [] }
        guard let envelope = try? JSONDecoder().decode(HerdrEnvelope<HerdrPaneListResult>.self, from: data),
              let panes = envelope.result?.panes else {
            return []
        }
        return panes
    }

    private func processInfo(forPane paneId: String) -> HerdrProcessInfo? {
        guard let data = run(["pane", "process-info", "--pane", paneId]) else { return nil }
        guard let envelope = try? JSONDecoder().decode(HerdrEnvelope<HerdrProcessInfoResult>.self, from: data) else {
            return nil
        }
        return envelope.result?.processInfo
    }

    /// Pids that root each pane's content: the pane shell plus its current
    /// foreground processes. Verified membership (herdr reported the pid),
    /// never inferred from cwd. Costs one `pane list` plus one
    /// `process-info` per pane, hence the cache; call off-main.
    func paneRootPids(maxAge: TimeInterval = 15) -> Set<Int> {
        cacheLock.lock()
        if let cached = _paneRootPids, let last = lastRootsFetch,
           Date().timeIntervalSince(last) < maxAge {
            cacheLock.unlock()
            return cached
        }
        cacheLock.unlock()

        guard isAvailable else { return [] }
        var roots = Set<Int>()
        for entry in listPanes() {
            guard let info = processInfo(forPane: entry.paneId) else { continue }
            if let shell = info.shellPid { roots.insert(shell) }
            for fg in info.foregroundProcesses ?? [] {
                if let pid = fg.pid { roots.insert(pid) }
            }
        }
        cacheLock.lock()
        _paneRootPids = roots
        lastRootsFetch = Date()
        cacheLock.unlock()
        return roots
    }

    /// Finds the herdr pane running the given PID, if any.
    ///
    /// `cwd` narrows candidates first (cheap, from `pane list`) since a
    /// full `process-info` call per pane is a separate herdr round-trip.
    func findPane(forPid pid: Int, cwd: String? = nil) -> HerdrPane? {
        guard isAvailable else { return nil }

        var candidates = listPanes()
        if let cwd, !cwd.isEmpty {
            let narrowed = candidates.filter { $0.cwd == cwd }
            if !narrowed.isEmpty {
                candidates = narrowed
            }
        }

        for entry in candidates {
            guard let info = processInfo(forPane: entry.paneId) else { continue }
            if info.shellPid == pid {
                return HerdrPane(paneId: entry.paneId, tabId: entry.tabId, workspaceId: entry.workspaceId)
            }
            if let foreground = info.foregroundProcesses, foreground.contains(where: { $0.pid == pid }) {
                return HerdrPane(paneId: entry.paneId, tabId: entry.tabId, workspaceId: entry.workspaceId)
            }
        }
        return nil
    }

    /// Brings a pane into view. herdr has no `pane focus <id>` (pane focus
    /// is direction-only); focusing a pane means focusing its workspace
    /// then its tab.
    func focusPane(_ pane: HerdrPane) {
        run(["workspace", "focus", pane.workspaceId])
        run(["tab", "focus", pane.tabId])
    }

    /// Reads recent scrollback text from a pane.
    func readPaneOutput(_ paneId: String, lines: Int = 50) -> String? {
        guard let data = run(["pane", "read", paneId, "--source", "recent", "--lines", "\(lines)"]) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
}
