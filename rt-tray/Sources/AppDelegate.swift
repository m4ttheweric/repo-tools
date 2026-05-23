import AppKit
import UserNotifications
import ServiceManagement
import Network

// MARK: - AppDelegate

class AppDelegate: NSObject, NSApplicationDelegate {

    // ── Menu bar ────────────────────────────────────────────────────────────
    private var statusItem: NSStatusItem!
    private var statusMenu: NSMenu!

    // ── Daemon communication ────────────────────────────────────────────────
    private let daemonClient = DaemonClient()
    private let notificationManager = NotificationManager()
    private let daemonLifecycle = DaemonLifecycle()

    // ── Polling timers ──────────────────────────────────────────────────────
    private var statusTimer: Timer?
    private var notificationTimer: Timer?

    // ── State ───────────────────────────────────────────────────────────────
    private var lastDaemonStatus: DaemonStatus?
    private var currentHealth: DaemonHealth = .unknown
    private let updateChecker = UpdateChecker.shared

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenuBar()
        setupNotifications()
        setupTrayServer()
        startPolling()
        setupAutoUpdate()

        // Register the daemon as a LaunchAgent. Idempotent — if already
        // registered, this is a no-op. If the user hasn't approved it yet,
        // status flips to .requiresApproval and the menu surfaces a prompt.
        Task { @MainActor in
            setHealth(.starting)
            daemonLifecycle.startDaemon()

            // Wait for launchd to bring the daemon up
            for _ in 0..<8 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                if await daemonClient.isReachable() { break }
            }
            await refreshStatus()
            await drainPendingNotifications()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        statusTimer?.invalidate()
        notificationTimer?.invalidate()
        updateChecker.stopChecking()
        TrayServer.shared.stop()
    }

    // MARK: - Menu Bar Setup

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        guard statusItem.button != nil else { return }
        updateMenuBarTitle(status: .unknown)

        statusMenu = NSMenu()
        rebuildMenu()
        statusItem.menu = statusMenu
    }

    /// Update the menu bar button with "rt" text + colored status dot.
    private func updateMenuBarTitle(status: DaemonHealth) {
        guard let button = statusItem.button else { return }

        let dotColor: NSColor
        switch status {
        case .healthy:
            dotColor = .systemGreen
        case .starting:
            dotColor = .systemYellow
        case .warning:
            dotColor = .systemOrange
        case .down:
            dotColor = .systemRed
        case .unknown:
            dotColor = .tertiaryLabelColor
        }

        let attributed = NSMutableAttributedString()

        // "rt" in monospace
        let rtAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .medium),
            .foregroundColor: NSColor.labelColor,
        ]
        attributed.append(NSAttributedString(string: "rt", attributes: rtAttrs))

        // Space
        attributed.append(NSAttributedString(string: " "))

        // Colored dot
        let dotAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 8),
            .foregroundColor: dotColor,
        ]
        attributed.append(NSAttributedString(string: "●", attributes: dotAttrs))

        button.attributedTitle = attributed
    }

    // MARK: - Menu Items

    private func rebuildMenu() {
        statusMenu.removeAllItems()

        // Status line (updated dynamically)
        let statusLine = NSMenuItem(title: "Daemon: checking…", action: nil, keyEquivalent: "")
        statusLine.tag = 100
        statusLine.isEnabled = false
        statusMenu.addItem(statusLine)

        // Port summary (updated dynamically)
        let portsLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        portsLine.tag = 101
        portsLine.isEnabled = false
        portsLine.isHidden = true
        statusMenu.addItem(portsLine)

        statusMenu.addItem(NSMenuItem.separator())

        // Daemon controls
        let restartItem = NSMenuItem(title: "Restart Daemon", action: #selector(restartDaemon), keyEquivalent: "r")
        restartItem.target = self
        statusMenu.addItem(restartItem)

        let stopItem = NSMenuItem(title: "Stop Daemon", action: #selector(stopDaemon), keyEquivalent: "")
        stopItem.target = self
        statusMenu.addItem(stopItem)

        let logsItem = NSMenuItem(title: "View Daemon Logs…", action: #selector(viewDaemonLogs), keyEquivalent: "l")
        logsItem.target = self
        statusMenu.addItem(logsItem)

        // Shown only when SMAppService says approval is required.
        let approveItem = NSMenuItem(title: "Approve Daemon in Login Items…", action: #selector(openLoginItemsSettings), keyEquivalent: "")
        approveItem.target = self
        approveItem.tag = 150
        approveItem.isHidden = true
        statusMenu.addItem(approveItem)

        statusMenu.addItem(NSMenuItem.separator())

        // Login item toggle
        let loginItem = NSMenuItem(title: "Start at Login", action: #selector(toggleLoginItem(_:)), keyEquivalent: "")
        loginItem.target = self
        loginItem.tag = 200
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        statusMenu.addItem(loginItem)

        statusMenu.addItem(NSMenuItem.separator())

        // Updates
        let updateItem = NSMenuItem(title: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "")
        updateItem.target = self
        updateItem.tag = 300
        statusMenu.addItem(updateItem)

        statusMenu.addItem(NSMenuItem.separator())

        // Quit
        let quitItem = NSMenuItem(title: "Quit rt-tray", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        statusMenu.addItem(quitItem)
    }

    private func updateMenuItems(with status: DaemonStatus) {
        if let item = statusMenu.item(withTag: 100) {
            let uptime = formatUptime(status.uptime)
            item.title = "Daemon: running · pid \(status.pid) · \(uptime)"
        }

        if let item = statusMenu.item(withTag: 101) {
            if status.portsCached > 0 {
                let repos = status.portsByRepo.map { "\($0.key): \($0.value)" }.joined(separator: ", ")
                item.title = "Ports: \(status.portsCached) listening (\(repos))"
                item.isHidden = false
            } else {
                item.isHidden = true
            }
        }

        if let item = statusMenu.item(withTag: 200) {
            item.state = SMAppService.mainApp.status == .enabled ? .on : .off
        }
        // Daemon is reachable → approval clearly worked, hide the prompt
        if let item = statusMenu.item(withTag: 150) {
            item.isHidden = true
        }
    }

    private func updateMenuItemsOffline() {
        if let item = statusMenu.item(withTag: 100) {
            switch daemonLifecycle.status {
            case .requiresApproval:
                item.title = "Daemon: needs approval in Login Items"
            case .notRegistered, .notFound:
                item.title = "Daemon: not registered"
            default:
                item.title = "Daemon: not running"
            }
        }
        if let item = statusMenu.item(withTag: 101) {
            item.isHidden = true
        }
        if let item = statusMenu.item(withTag: 150) {
            item.isHidden = daemonLifecycle.status != .requiresApproval
        }
    }

    private func updateMenuItemsStarting() {
        if let item = statusMenu.item(withTag: 100) {
            item.title = "Daemon: starting…"
        }
        if let item = statusMenu.item(withTag: 101) {
            item.isHidden = true
        }
    }

    // MARK: - Health Management

    private func setHealth(_ health: DaemonHealth) {
        currentHealth = health
        updateMenuBarTitle(status: health)
        switch health {
        case .starting:
            updateMenuItemsStarting()
        case .down:
            updateMenuItemsOffline()
        default:
            break
        }
    }

    // MARK: - Actions

    @objc private func restartDaemon() {
        Task { @MainActor in
            setHealth(.starting)

            // Let DaemonLifecycle handle the full restart — it sets intentionalStop
            // before terminating so the crash-recovery handler doesn't race with us.
            daemonLifecycle.restartDaemon()

            // Poll until it comes back (up to 8s)
            for _ in 0..<16 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                if await daemonClient.isReachable() {
                    await refreshStatus()
                    return
                }
            }
            setHealth(.down)
        }
    }

    @objc private func stopDaemon() {
        Task { @MainActor in
            await daemonClient.sendShutdown()
            try? await Task.sleep(nanoseconds: 500_000_000)
            setHealth(.down)
        }
    }

    @objc private func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    /// Open the logdy-based daemon log viewer in the user's default browser.
    /// If logdy is already serving on :5544 (e.g. previous click), just opens
    /// the URL. Otherwise spawns `rt daemon logs` via a login shell so it
    /// picks up the user's PATH (rt-tray inherits launchd's minimal PATH).
    @objc private func viewDaemonLogs() {
        let url = URL(string: "http://localhost:5544")!
        Task { @MainActor in
            if await self.isLogdyUp() {
                NSWorkspace.shared.open(url)
                return
            }
            self.spawnRtDaemonLogs()
            // Poll until logdy answers, up to ~4s, then open.
            for _ in 0..<20 {
                try? await Task.sleep(nanoseconds: 200_000_000)
                if await self.isLogdyUp() {
                    NSWorkspace.shared.open(url)
                    return
                }
            }
            // Fallback: open the URL anyway — user sees a connection error if
            // logdy never came up (e.g. logdy not installed).
            NSWorkspace.shared.open(url)
        }
    }

    /// Probe localhost:5544 with a short TCP connect.
    private func isLogdyUp() async -> Bool {
        return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            let host = "127.0.0.1"
            let port: UInt16 = 5544
            let conn = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
            var resumed = false
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if !resumed { resumed = true; cont.resume(returning: true) }
                    conn.cancel()
                case .failed, .cancelled:
                    if !resumed { resumed = true; cont.resume(returning: false) }
                default: break
                }
            }
            conn.start(queue: .global())
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
                if !resumed { resumed = true; cont.resume(returning: false) }
                conn.cancel()
            }
        }
    }

    /// Spawn `rt daemon logs` detached. Prefers the dev wrapper at
    /// ~/.local/bin/rt over the brew-installed binary (which may lag the
    /// source tree by a release cycle). Falls back to a login-shell PATH
    /// lookup if neither exists.
    ///
    /// Logdy stays running in the background after this method returns;
    /// it's killed only if the user Ctrl-Cs the spawned rt OR the rt-tray
    /// app group is terminated.
    private func spawnRtDaemonLogs() {
        let home = NSHomeDirectory()
        let candidates = [
            "\(home)/.local/bin/rt",
            "/opt/homebrew/bin/rt",
            "/usr/local/bin/rt",
        ]
        let rtBin = candidates.first { FileManager.default.isExecutableFile(atPath: $0) }

        let task = Process()
        if let rtBin = rtBin {
            task.executableURL = URL(fileURLWithPath: rtBin)
            task.arguments = ["daemon", "logs"]
            NSLog("rt-tray: spawning \(rtBin) daemon logs")
        } else {
            // Last-resort PATH lookup via login shell.
            task.executableURL = URL(fileURLWithPath: "/bin/zsh")
            task.arguments = ["-lc", "exec rt daemon logs"]
            NSLog("rt-tray: no rt binary found in known locations; falling back to PATH lookup")
        }
        // Redirect both stdio to /dev/null so the spawned process doesn't
        // inherit our pipe endpoints (which would EPIPE on next write once
        // rt-tray collects them).
        task.standardOutput = FileHandle(forWritingAtPath: "/dev/null")
        task.standardError = FileHandle(forWritingAtPath: "/dev/null")
        do {
            try task.run()
            NSLog("rt-tray: spawned rt daemon logs (pid \(task.processIdentifier))")
        } catch {
            NSLog("rt-tray: failed to spawn rt daemon logs: \(error)")
        }
    }

    @objc private func toggleLoginItem(_ sender: NSMenuItem) {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
                sender.state = .off
            } else {
                try SMAppService.mainApp.register()
                sender.state = .on
            }
        } catch {
            NSLog("rt-tray: login item toggle failed: \(error)")
        }
    }

    @objc private func quitApp() {
        NSApplication.shared.terminate(nil)
    }

    @objc private func checkForUpdates() {
        updateChecker.checkForUpdates(userInitiated: true)
    }

    // MARK: - Auto-Update

    private func setupAutoUpdate() {
        updateChecker.onUpdateAvailable = { [weak self] release in
            self?.handleUpdateAvailable(release)
        }
        updateChecker.startPeriodicChecks()
    }

    private func handleUpdateAvailable(_ release: GitHubRelease) {
        // Update menu item to show available version
        if let item = statusMenu.item(withTag: 300) {
            item.title = "Update Available: \(release.tagName)"
        }

        // Fire native notification — sound is played manually so the
        // category→sound mapping stays in one place (NotificationManager).
        let content = UNMutableNotificationContent()
        content.title = "rt Update Available"
        content.body = "\(release.tagName) is available — run: rt update"
        content.sound = nil
        content.categoryIdentifier = "UPDATE"
        NotificationManager.playSound(for: "UPDATE")

        let request = UNNotificationRequest(
            identifier: "rt-update-\(release.tagName)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: - Polling

    private func startPolling() {
        statusTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { await self?.refreshStatus() }
        }

        notificationTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { await self?.drainPendingNotifications() }
        }
    }

    private func refreshStatus() async {
        guard let status = await daemonClient.queryTrayStatus() else {
            // Don't overwrite "starting" with "down" during startup.
            // Dispatch to main — NSMenu/NSMenuItem must only be touched on the main thread,
            // and this async func may resume on the cooperative thread pool after its await.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if self.currentHealth != .starting {
                    self.setHealth(.down)
                }
            }
            return
        }

        let health: DaemonHealth = status.pendingNotifications > 0 ? .warning : .healthy
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.lastDaemonStatus = status
            self.currentHealth = health
            self.updateMenuBarTitle(status: health)
            self.updateMenuItems(with: status)
        }
    }

    private func drainPendingNotifications() async {
        guard let events = await daemonClient.fetchNotifications() else { return }
        for event in events {
            notificationManager.fire(event)
        }
    }

    // MARK: - Notifications Setup

    private func setupNotifications() {
        notificationManager.requestPermission()
        notificationManager.registerCategories()
    }

    // MARK: - Tray Server (receives daemon pushes)

    private func setupTrayServer() {
        TrayServer.shared.onNotification = { [weak self] event in
            self?.notificationManager.fire(event)
        }
        TrayServer.shared.daemonLifecycle = daemonLifecycle
        TrayServer.shared.start()
    }

    // MARK: - Helpers

    private func formatUptime(_ ms: Int) -> String {
        let seconds = ms / 1000
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        let remainingMinutes = minutes % 60
        return "\(hours)h \(remainingMinutes)m"
    }
}

// MARK: - Types

enum DaemonHealth {
    case healthy    // Green dot — daemon running, all good
    case starting   // Yellow dot — daemon is starting/restarting
    case warning    // Orange dot — running but has pending notifications
    case down       // Red dot — daemon not reachable
    case unknown    // Grey dot — initial state before first poll
}

struct DaemonStatus {
    let pid: Int
    let uptime: Int
    let memoryUsage: Int
    let watchedRepos: Int
    let cacheEntries: Int
    let portsCached: Int
    let portsByRepo: [String: Int]
    let pendingNotifications: Int
    let lastRefresh: Int?
}
