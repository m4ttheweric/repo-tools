import Foundation

// MARK: - DaemonLifecycle

/// Manages the Bun daemon process — start, stop, restart.
/// Reads daemon config from ~/.rt/daemon.json to find the Bun binary and script paths.
class DaemonLifecycle {

    private let rtDir: String
    private let configPath: String
    private let sockPath: String
    private let pidPath: String

    init() {
        rtDir     = NSHomeDirectory() + "/.rt"
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

    /// Spawn the daemon if it is not already running.
    ///
    /// Uses `nohup bun run <script> &` via /bin/sh so the daemon is fully
    /// detached from the tray's process group and will *not* be killed when
    /// the tray is restarted or updated.
    func startDaemon() {
        guard let config = loadConfig() else {
            NSLog("rt-tray: daemon config not found at \(configPath)")
            return
        }

        // ── Guard: don't spawn a duplicate ──────────────────────────────────
        // If the socket already exists, a daemon is already running.
        // Spawning another would cause a brief two-daemon conflict (resolved
        // by the daemon's own self-healing, but not ideal).
        if FileManager.default.fileExists(atPath: sockPath) {
            NSLog("rt-tray: socket exists — daemon is already running, skipping spawn")
            return
        }

        let logPath = rtDir + "/daemon.log"

        // Ensure log file exists so the append redirect doesn't fail
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }

        // ── Spawn via shell with nohup ───────────────────────────────────────
        // Using `nohup ... &` through a shell ensures:
        //   • The daemon is in its own process group (won't receive SIGHUP from tray)
        //   • The shell exits immediately; the tray doesn't hold a child ref
        //   • Tray restarts / pkills do not kill the daemon
        let shellCmd = "nohup \(config.bunPath) run \(config.daemonScript) >> \(logPath) 2>&1 &"

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", shellCmd]
        process.currentDirectoryURL = URL(fileURLWithPath: rtDir)
        process.standardInput  = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError  = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit() // shell exits immediately once nohup & is launched
            NSLog("rt-tray: daemon spawned (detached via nohup)")
        } catch {
            NSLog("rt-tray: failed to start daemon: \(error)")
        }
    }

    // MARK: - Stop

    /// Send SIGTERM to the daemon via its PID file.
    func stopDaemon() {
        guard let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8)
                                    .trimmingCharacters(in: .whitespacesAndNewlines),
              let pid = Int32(pidStr) else {
            return
        }
        kill(pid, SIGTERM)
        NSLog("rt-tray: sent SIGTERM to daemon (pid \(pid))")
    }

    // MARK: - Restart

    /// Stop the daemon and wait for it to fully release the socket before
    /// starting a replacement.  Polling prevents the 500 ms fixed-delay race
    /// that previously allowed two daemons to overlap.
    func restartDaemon() {
        stopDaemon()

        DispatchQueue.global().async {
            // Poll until the socket file is gone (daemon has finished cleanup)
            // or until a 2-second safety timeout is hit.
            let deadline = Date().addingTimeInterval(2.0)
            while FileManager.default.fileExists(atPath: self.sockPath), Date() < deadline {
                Thread.sleep(forTimeInterval: 0.1)
            }

            // Extra safety margin so the daemon process itself exits cleanly
            Thread.sleep(forTimeInterval: 0.15)

            self.startDaemon()
        }
    }
}
