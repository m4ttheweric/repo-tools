import Foundation

struct SystemProcess: Codable, Identifiable {
    let pid: Int
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

    var id: Int { pid }

    var memoryMB: String {
        let mb = Double(rssKb) / 1024.0
        if mb >= 1024 {
            return String(format: "%.1f GB", mb / 1024.0)
        }
        return String(format: "%.0f MB", mb)
    }

    var cpuFormatted: String {
        if cpuPercent >= 100 {
            return String(format: "%.0f%%", cpuPercent)
        }
        return String(format: "%.1f%%", cpuPercent)
    }

    var portFormatted: String {
        port.map { ":\($0)" } ?? "---"
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

// Column visibility configuration
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
        case .command, .cpu, .memory, .port, .branch, .linearTicket:
            return true
        case .pid, .uptime, .worktree, .cwd, .fullCommand:
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
        try? data.write(to: URL(fileURLWithPath: Self.configPath))
    }

    func toggle(_ column: ProcessColumn) {
        if visibleColumns.contains(column) {
            // Don't allow removing all columns
            if visibleColumns.count > 1 {
                visibleColumns.remove(column)
            }
        } else {
            visibleColumns.insert(column)
        }
        save()
    }
}
