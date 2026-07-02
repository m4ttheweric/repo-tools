import Foundation

/// Durable tray logging — JSON lines appended to ~/.rt/logs/tray.YYYY-MM-DD.log
/// (the same <surface>.<date>.log convention the daemon and CLI use, so the
/// tray shows up in `rt daemon logs` automatically). Every call also mirrors
/// to NSLog so Console.app keeps working.
///
/// Never throws, never blocks the caller beyond a serial-queue append.
enum TrayLog {
    private static let queue = DispatchQueue(label: "rt.tray-log", qos: .utility)
    private static let logDir = NSString(string: "~/.rt/logs").expandingTildeInPath
    private static let retentionDays = 14
    private static var hasPruned = false

    static func info(_ msg: String, _ fields: [String: Any] = [:]) { write("info", msg, fields) }
    static func warn(_ msg: String, _ fields: [String: Any] = [:]) { write("warn", msg, fields) }
    static func error(_ msg: String, _ fields: [String: Any] = [:]) { write("error", msg, fields) }

    /// Synchronous variant for crash paths — drains the queue before returning
    /// so the record hits disk even when the process is about to die.
    static func fatalSync(_ msg: String, _ fields: [String: Any] = [:]) {
        write("fatal", msg, fields)
        queue.sync {}
    }

    private static func write(_ level: String, _ msg: String, _ fields: [String: Any]) {
        NSLog("rt-tray: %@", msg)
        let time = ISO8601DateFormatter().string(from: Date())
        queue.async {
            var record: [String: Any] = ["time": time, "level": level, "module": "tray", "msg": msg]
            for (k, v) in fields { record[k] = v }
            guard JSONSerialization.isValidJSONObject(record),
                  let data = try? JSONSerialization.data(withJSONObject: record) else { return }

            let fm = FileManager.default
            try? fm.createDirectory(atPath: logDir, withIntermediateDirectories: true)
            let path = (logDir as NSString).appendingPathComponent("tray.\(today()).log")
            if !fm.fileExists(atPath: path) { fm.createFile(atPath: path, contents: nil) }
            guard let handle = FileHandle(forWritingAtPath: path) else { return }
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
            try? handle.write(contentsOf: Data("\n".utf8))

            if !hasPruned {
                hasPruned = true
                pruneOldLogs(fm)
            }
        }
    }

    private static func today() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone.current
        return f.string(from: Date())
    }

    private static func pruneOldLogs(_ fm: FileManager) {
        guard let files = try? fm.contentsOfDirectory(atPath: logDir) else { return }
        let cutoff = Date().addingTimeInterval(-Double(retentionDays) * 86_400)
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        for file in files {
            guard file.hasPrefix("tray."), file.hasSuffix(".log") else { continue }
            let datePart = file.dropFirst("tray.".count).dropLast(".log".count)
            guard let date = f.date(from: String(datePart)), date < cutoff else { continue }
            try? fm.removeItem(atPath: (logDir as NSString).appendingPathComponent(file))
        }
    }
}

// ─── Logged subprocess helpers ───────────────────────────────────────────────

extension TrayLog {
    private static let stderrCapBytes = 4 * 1024

    /// Run a Process to completion, capturing stdout for the caller and stderr
    /// for the log. Nonzero exit → warn with the stderr tail; spawn failure →
    /// error. Returns nil when the process could not run or exited nonzero,
    /// matching the callers' existing "nil = failure" convention.
    static func runLogged(_ executablePath: String, _ arguments: [String], label: String) -> Data? {
        let task = Process()
        let outPipe = Pipe(), errPipe = Pipe()
        task.executableURL = URL(fileURLWithPath: executablePath)
        task.arguments = arguments
        task.standardOutput = outPipe
        task.standardError = errPipe

        do {
            try task.run()
        } catch {
            TrayLog.error("spawn failed: \(label)", ["cmd": executablePath, "err": String(describing: error)])
            return nil
        }
        let stdout = outPipe.fileHandleForReading.readDataToEndOfFile()
        let stderr = errPipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            TrayLog.warn("nonzero exit: \(label)", [
                "cmd": executablePath,
                "args": arguments.joined(separator: " "),
                "exitCode": Int(task.terminationStatus),
                "stderr": String(decoding: stderr.suffix(stderrCapBytes), as: UTF8.self),
            ])
            return nil
        }
        return stdout
    }

    /// Fire-and-forget spawn that still leaves a trace: stderr is captured and
    /// a termination handler logs nonzero exits. stdout stays at /dev/null so
    /// the child never blocks on an unread pipe we own.
    static func spawnLoggedDetached(_ task: Process, label: String) {
        let errPipe = Pipe()
        task.standardOutput = FileHandle.nullDevice
        task.standardError = errPipe
        task.terminationHandler = { proc in
            let stderr = errPipe.fileHandleForReading.readDataToEndOfFile()
            if proc.terminationStatus != 0 {
                TrayLog.warn("nonzero exit: \(label)", [
                    "exitCode": Int(proc.terminationStatus),
                    "stderr": String(decoding: stderr.suffix(stderrCapBytes), as: UTF8.self),
                ])
            }
        }
        do {
            try task.run()
            TrayLog.info("spawned: \(label)", ["pid": Int(task.processIdentifier)])
        } catch {
            TrayLog.error("spawn failed: \(label)", ["err": String(describing: error)])
        }
    }
}

// ─── Crash capture ───────────────────────────────────────────────────────────

/// Pre-opened fd for the signal handler — Foundation is not async-signal-safe,
/// so fatal signals write a fixed-format line with write(2) only.
private var crashFd: Int32 = -1

/// Install uncaught-exception + fatal-signal handlers. Call once at launch.
func installTrayCrashHandlers() {
    NSSetUncaughtExceptionHandler { exception in
        TrayLog.fatalSync("uncaught exception: \(exception.name.rawValue): \(exception.reason ?? "")",
                          ["stack": exception.callStackSymbols.joined(separator: "\n")])
    }

    let logDir = NSString(string: "~/.rt/logs").expandingTildeInPath
    try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
    let crashPath = logDir + "/tray-crash.log"
    crashFd = open(crashPath, O_WRONLY | O_APPEND | O_CREAT, 0o644)

    for sig in [SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGTRAP, SIGFPE] {
        signal(sig) { s in
            if crashFd >= 0 {
                var msg = "rt-tray: fatal signal \(s)\n"
                msg.withUTF8 { buf in _ = write(crashFd, buf.baseAddress, buf.count) }
            }
            signal(s, SIG_DFL)
            raise(s)
        }
    }
}
