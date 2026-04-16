import Foundation

// MARK: - DaemonLifecycle

/// Manages the Bun daemon process — start, stop, restart.
/// Spawns the daemon as a direct child process so it inherits the tray app's
/// TCC grants (file access to ~/Documents, ~/Desktop, etc.).
///
/// All mutable state is accessed exclusively on `queue` (serial) to prevent
/// data races. The public methods are safe to call from any thread.
class DaemonLifecycle {

    private let rtDir: String
    private let configPath: String
    private let sockPath: String
    private let pidPath: String

    private let queue = DispatchQueue(label: "com.rt.daemon-lifecycle")

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

    func startDaemon() {
        queue.async { self._startDaemon() }
    }

    private func _startDaemon() {
        guard let config = loadConfig() else {
            NSLog("rt-tray: daemon config not found at \(configPath)")
            return
        }

        if let existing = daemonProcess, existing.isRunning {
            NSLog("rt-tray: daemon already running (pid \(existing.processIdentifier)), skipping")
            return
        }

        // Clean up stale socket
        if FileManager.default.fileExists(atPath: sockPath) {
            try? FileManager.default.removeItem(atPath: sockPath)
        }

        let logPath = rtDir + "/daemon.log"
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }

        let proc = Process()
        if config.daemonScript == "--daemon" {
            proc.executableURL = URL(fileURLWithPath: config.bunPath)
            proc.arguments = ["--daemon"]
        } else {
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

        // Capture proc by identity so a stale handler from a replaced process
        // never touches the current daemonProcess.
        proc.terminationHandler = { [weak self, weak proc] _ in
            guard let self = self, let proc = proc else { return }
            self.queue.async {
                // Only act if this is still the active process
                guard self.daemonProcess === proc else { return }
                self.daemonProcess = nil

                if !self.intentionalStop {
                    NSLog("rt-tray: daemon crashed — restarting in 2s")
                    DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) {
                        self.queue.async { self._startDaemon() }
                    }
                }
            }
        }

        do {
            try proc.run()
            daemonProcess = proc
            NSLog("rt-tray: daemon spawned (pid \(proc.processIdentifier))")
        } catch {
            NSLog("rt-tray: failed to start daemon: \(error)")
        }
    }

    // MARK: - Stop

    func stopDaemon() {
        queue.async { self._stopDaemon() }
    }

    private func _stopDaemon() {
        intentionalStop = true

        // Nil and disarm BEFORE terminating so terminationHandler identity check
        // fails and the crash-recovery path never fires.
        if let proc = daemonProcess {
            daemonProcess = nil
            proc.terminate()
            NSLog("rt-tray: sent SIGTERM to daemon (pid \(proc.processIdentifier))")
            return
        }

        // Fallback: kill via PID file
        guard let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8)
                                    .trimmingCharacters(in: .whitespacesAndNewlines),
              let pid = Int32(pidStr) else { return }
        kill(pid, SIGTERM)
        NSLog("rt-tray: sent SIGTERM to daemon via PID file (pid \(pid))")
    }

    // MARK: - Restart

    func restartDaemon() {
        queue.async { self._restartDaemon() }
    }

    private func _restartDaemon() {
        _stopDaemon()

        // Fixed 1.5s wait — covers graceful shutdown + socket cleanup.
        // Runs off-queue so the queue stays free for any stray terminationHandler callbacks.
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) {
            self.queue.async { self._startDaemon() }
        }
    }
}
