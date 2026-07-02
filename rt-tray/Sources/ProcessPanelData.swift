import Foundation

struct SystemProcess: Codable, Identifiable {
    let pid: Int
    let ppid: Int
    let command: String
    let fullCommand: String
    let cpuPercent: Double
    let rssKb: Int
    let uptime: String
    let cwd: String
    let repo: String
    let worktree: String?
    let branch: String?
    let relativeDir: String
    let port: Int?
    let linearTicket: String?
    let isRunaway: Bool
    let runawayDurationMs: Int?
    let firstSeen: Double
    var children: [SystemProcess]?
    let totalCpuPercent: Double?
    let totalRssKb: Int?
    // Pids collapsed into this row when the daemon flattens single-child
    // chains for display ("doppler › node" is two real processes).
    let chainPids: [Int]?

    var id: Int { pid }

    var hasChildren: Bool {
        !(children ?? []).isEmpty
    }

    // Last segment of a breadcrumb command chain ("bun › node › foo" → "foo")
    var leafName: String {
        command.components(separatedBy: " › ").last ?? command
    }

    var childCount: Int {
        (children ?? []).count
    }

    var memoryMB: String {
        let kb = totalRssKb ?? rssKb
        let mb = Double(kb) / 1024.0
        if mb >= 1024 {
            return String(format: "%.1f GB", mb / 1024.0)
        }
        return String(format: "%.0f MB", mb)
    }

    var cpuFormatted: String {
        let cpu = totalCpuPercent ?? cpuPercent
        if cpu >= 100 {
            return String(format: "%.0f%%", cpu)
        }
        return String(format: "%.1f%%", cpu)
    }

    var portFormatted: String {
        port.map { ":\($0)" } ?? ""
    }

    // Every real pid this row represents (a breadcrumb row is a whole chain)
    var selfPids: [Int] {
        chainPids ?? [pid]
    }

    // Flat list of all PIDs in this tree (self + all descendants)
    var allPids: [Int] {
        var pids = selfPids
        for child in children ?? [] {
            pids.append(contentsOf: child.allPids)
        }
        return pids
    }
}

struct SystemProcessResponse: Codable {
    let ok: Bool
    let data: SystemProcessData
}

struct SystemProcessData: Codable {
    let processes: [SystemProcess]
    let updatedAt: Double
}

struct RepoGroup: Identifiable {
    let name: String
    let processes: [SystemProcess]
    let totalCpu: Double

    var id: String { name }
}

enum ProcessColumn: String, CaseIterable, Codable {
    case command = "Command"
    case cpu = "CPU %"
    case memory = "Memory"
    case port = "Port"
    case branch = "Branch"
    case linearTicket = "Linear Ticket"
    case pid = "PID"
    case uptime = "Uptime"
    case worktree = "Worktree"
    case cwd = "CWD"
    case fullCommand = "Full Command"

    var defaultVisible: Bool {
        switch self {
        case .command, .cpu, .memory, .branch:
            return true
        case .port, .linearTicket, .pid, .uptime, .worktree, .cwd, .fullCommand:
            return false
        }
    }
}

class ColumnSettings: ObservableObject {
    @Published var visibleColumns: Set<ProcessColumn>

    private static let configPath: String = {
        let home = NSHomeDirectory()
        return "\(home)/.rt/panel-columns.json"
    }()

    init() {
        self.visibleColumns = Self.load()
    }

    private static func load() -> Set<ProcessColumn> {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
              let keys = try? JSONDecoder().decode([String].self, from: data) else {
            return Set(ProcessColumn.allCases.filter(\.defaultVisible))
        }
        let columns = keys.compactMap { ProcessColumn(rawValue: $0) }
        return columns.isEmpty
            ? Set(ProcessColumn.allCases.filter(\.defaultVisible))
            : Set(columns)
    }

    func save() {
        let keys = visibleColumns.map(\.rawValue)
        guard let data = try? JSONEncoder().encode(keys) else { return }
        let url = URL(fileURLWithPath: Self.configPath)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        do {
            try data.write(to: url)
        } catch {
            TrayLog.warn("failed to save column settings", ["err": String(describing: error)])
        }
    }

    func toggle(_ column: ProcessColumn) {
        if visibleColumns.contains(column) {
            if visibleColumns.count > 1 {
                visibleColumns.remove(column)
            }
        } else {
            visibleColumns.insert(column)
        }
        save()
    }
}
