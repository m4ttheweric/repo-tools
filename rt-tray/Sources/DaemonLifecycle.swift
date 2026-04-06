import Foundation

// MARK: - DaemonLifecycle

/// Manages the Bun daemon process — start, stop, restart.
/// Reads daemon config from ~/.rt/daemon.json to find the Bun binary and script paths.
class DaemonLifecycle {

    private let rtDir: String
    private let configPath: String

    init() {
        rtDir = NSHomeDirectory() + "/.rt"
        configPath = rtDir + "/daemon.json"
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
        guard let config = loadConfig() else {
            NSLog("rt-tray: daemon config not found at \(configPath)")
            return
        }

        let logPath = rtDir + "/daemon.log"

        // Ensure log file exists
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }

        guard let logHandle = FileHandle(forWritingAtPath: logPath) else {
            NSLog("rt-tray: can't open daemon log for writing")
            return
        }
        logHandle.seekToEndOfFile()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: config.bunPath)
        process.arguments = ["run", config.daemonScript]
        process.currentDirectoryURL = URL(fileURLWithPath: rtDir)
        process.standardOutput = logHandle
        process.standardError = logHandle

        // Ensure QoS is set so the process isn't throttled
        process.qualityOfService = .userInitiated

        do {
            try process.run()
            NSLog("rt-tray: spawned daemon (pid \(process.processIdentifier))")

            // Detach — let the daemon outlive us if needed
            // (Process doesn't have a built-in detach, but since we don't
            // wait on it or hold a strong ref in a blocking way, it runs
            // independently. The daemon writes its own PID file.)
        } catch {
            NSLog("rt-tray: failed to start daemon: \(error)")
        }
    }

    // MARK: - Stop

    func stopDaemon() {
        // Try graceful shutdown via socket first (handled by DaemonClient)
        // If that fails, try SIGTERM via PID file
        let pidPath = rtDir + "/rt.pid"
        guard let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              let pid = Int32(pidStr) else {
            return
        }

        kill(pid, SIGTERM)
        NSLog("rt-tray: sent SIGTERM to daemon (pid \(pid))")
    }

    // MARK: - Restart

    func restartDaemon() {
        stopDaemon()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
            self.startDaemon()
        }
    }
}
