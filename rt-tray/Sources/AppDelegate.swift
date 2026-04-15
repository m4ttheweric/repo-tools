import AppKit
import UserNotifications
import ServiceManagement

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

        // On first launch, ensure daemon is running
        Task { @MainActor in
            setHealth(.starting)
            let running = await daemonClient.isReachable()
            if !running {
                daemonLifecycle.startDaemon()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
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
    }

    private func updateMenuItemsOffline() {
        if let item = statusMenu.item(withTag: 100) {
            item.title = "Daemon: not running"
        }
        if let item = statusMenu.item(withTag: 101) {
            item.isHidden = true
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
            // Send shutdown via the daemon's own command channel so it cleans up
            // gracefully (releases socket, writes final state).
            await daemonClient.sendShutdown()

            // Hand off to DaemonLifecycle.restartDaemon(), which polls until the
            // socket file is gone before spawning — prevents the race where
            // startDaemon() sees the socket still present and bails out silently.
            daemonLifecycle.restartDaemon()

            // Poll until it comes back (up to 8s — allows ~2s cleanup + startup)
            for _ in 0..<16 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                if await daemonClient.isReachable() {
                    await refreshStatus()
                    return
                }
            }
            // Timed out
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

        // Fire native notification
        let content = UNMutableNotificationContent()
        content.title = "rt Update Available"
        content.body = "\(release.tagName) is available — run: rt update"
        content.sound = .default
        content.categoryIdentifier = "UPDATE"

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
            // Don't overwrite "starting" with "down" during startup
            if currentHealth != .starting {
                setHealth(.down)
            }
            return
        }

        lastDaemonStatus = status
        let health: DaemonHealth = status.pendingNotifications > 0 ? .warning : .healthy
        currentHealth = health
        updateMenuBarTitle(status: health)
        updateMenuItems(with: status)
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
