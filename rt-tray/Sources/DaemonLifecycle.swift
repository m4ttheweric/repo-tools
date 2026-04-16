import Foundation

// MARK: - DaemonLifecycle

/// Manages the Bun daemon process — start, stop, restart.
/// Spawns the daemon as a direct child process so it inherits the tray app's
/// TCC grants (file access to ~/Documents, ~/Desktop, etc.).
class DaemonLifecycle {

    private let rtDir: String
    private let configPath: String
    private let sockPath: String
    private let pidPath: String

    private var daemonProcess: Process?
    private var intentionalStop = false

    init() {
        rtDir      = NSHomeDirectory() + "/.rt"
        configPath = rtDir + "/daemon.json"
        sockPath   = rtDir + "/rt.sock"
        pidPath    = rtDir + "/rt.pid"
    }

    // MARK: - Config

    struct DaemonConfig: Decodable {
        let installed: Bool
        let bunPath: String
        let daemonScript: String
        let mode: String
    }

    func loadConfig() -> DaemonConfig? {
        guard let data = FileManager.default.contents(atPath: configPath),
              let config = try? JSONDecoder().decode(DaemonConfig.self, from: data),
              config.installed else {
            return nil
        }
        return config
    }

    // MARK: - Start

    /// Spawn the daemon as a direct child process.
    /// The daemon inherits the tray's TCC grants because it's a child process,
    /// eliminating the need for separate Full Disk Access configuration.
    func startDaemon() {
        guard let config = loadConfig() else {
            NSLog("rt-tray: daemon config not found at \(configPath)")
            return
        }

        if let existing = daemonProcess, existing.isRunning {
            NSLog("rt-tray: daemon process already running (pid \(existing.processIdentifier)), skipping spawn")
            return
        }

        // Clean up stale socket from a previous crash
        if FileManager.default.fileExists(atPath: sockPath) {
            try? FileManager.default.removeItem(atPath: sockPath)
        }

        let logPath = rtDir + "/daemon.log"
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }

        let proc = Process()

        // Determine spawn arguments from config
        if config.daemonScript == "--daemon" {
            // Compiled install: `rt --daemon`
            proc.executableURL = URL(fileURLWithPath: config.bunPath)
            proc.arguments = ["--daemon"]
        } else {
            // Dev install: `bun run <script>`
            proc.executableURL = URL(fileURLWithPath: config.bunPath)
            proc.arguments = ["run", config.daemonScript]
        }

        proc.currentDirectoryURL = URL(fileURLWithPath: rtDir)
        proc.standardInput = FileHandle.nullDevice

        if let logHandle = FileHandle(forWritingAtPath: logPath) {
            logHandle.seekToEndOfFile()
            proc.standardOutput = logHandle
            proc.standardError = logHandle
        } else {
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
        }

        intentionalStop = false

        proc.terminationHandler = { [weak self] terminatedProc in
            guard let self = self else { return }
            let code = terminatedProc.terminationStatus
            NSLog("rt-tray: daemon exited (status \(code), intentional: \(self.intentionalStop))")

            self.daemonProcess = nil

            if !self.intentionalStop {
                NSLog("rt-tray: daemon crashed — restarting in 2s")
                DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) {
                    self.startDaemon()
                }
            }
        }

        do {
            try proc.run()
            daemonProcess = proc
            NSLog("rt-tray: daemon spawned as child process (pid \(proc.processIdentifier))")
        } catch {
            NSLog("rt-tray: failed to start daemon: \(error)")
        }
    }

    // MARK: - Stop

    func stopDaemon() {
        intentionalStop = true

        if let proc = daemonProcess, proc.isRunning {
            proc.terminate()
            NSLog("rt-tray: sent SIGTERM to daemon (pid \(proc.processIdentifier))")
            return
        }

        // Fallback: kill via PID file (daemon may have been started by launchd or manually)
        guard let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8)
                                    .trimmingCharacters(in: .whitespacesAndNewlines),
              let pid = Int32(pidStr) else {
            return
        }
        kill(pid, SIGTERM)
        NSLog("rt-tray: sent SIGTERM to daemon via PID file (pid \(pid))")
    }

    // MARK: - Restart

    func restartDaemon() {
        stopDaemon()

        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(3.0)
            while Date() < deadline {
                // Wait for process to exit
                if let proc = self.daemonProcess, proc.isRunning {
                    Thread.sleep(forTimeInterval: 0.1)
                    continue
                }
                // Wait for socket cleanup
                if FileManager.default.fileExists(atPath: self.sockPath) {
                    Thread.sleep(forTimeInterval: 0.1)
                    continue
                }
                break
            }

            Thread.sleep(forTimeInterval: 0.15)
            self.startDaemon()
        }
    }
}
