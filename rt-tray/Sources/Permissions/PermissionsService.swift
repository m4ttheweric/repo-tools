import AppKit
import UserNotifications
import ServiceManagement
import MattstackCore

/// App-side truth for the three permission rows (spec §9). Pure mapping is
/// in MattstackCore; this class only touches the frameworks.
final class PermissionsService: PermissionProbing, PermissionsProviding, @unchecked Sendable {
    private let bundleId: String
    private let agentStatuses: @Sendable () -> [SMAppService.Status]
    private let runner: CommandRunner
    private let home = NSHomeDirectory()
    // snapshot() is async and called from whichever caller currently has
    // this instance (today: ReadinessModel's ticker) — the lock keeps
    // lastFDA/fdaNeedsRelaunch consistent if a second caller is ever added.
    private let stateLock = NSLock()
    private var lastFDA = "unknown"
    private var storedFdaNeedsRelaunch = false
    var fdaNeedsRelaunch: Bool { stateLock.lock(); defer { stateLock.unlock() }; return storedFdaNeedsRelaunch }

    // Locking lives in these two synchronous helpers, never inline in an
    // `async` function — `NSLock.lock()/unlock()` called directly from an
    // `async` body is a Swift 6 diagnostic (the same one already accepted
    // pre-existing in CommandRunner.swift), so the hold is always scoped to
    // a plain function the async call sites invoke instead.
    private func recordFDA(_ status: String) {
        stateLock.lock()
        if lastFDA == "denied", status == "granted" { storedFdaNeedsRelaunch = true }
        lastFDA = status
        stateLock.unlock()
    }
    private func markFdaNeedsRelaunch() {
        stateLock.lock(); storedFdaNeedsRelaunch = true; stateLock.unlock()
    }

    init(bundleId: String, agentStatuses: @escaping @Sendable () -> [SMAppService.Status], runner: CommandRunner) {
        self.bundleId = bundleId
        self.agentStatuses = agentStatuses
        self.runner = runner
    }

    func snapshot() async -> PermissionSnapshot {
        let fda = FDAProbe.evaluate(home: home, open: FDAProbe.systemOpen)
        recordFDA(fda.status)
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let notif: String
        switch settings.authorizationStatus {
        case .authorized: notif = "authorized"
        case .denied: notif = "denied"
        case .provisional: notif = "provisional"
        default: notif = "notDetermined"
        }
        return PermissionSnapshot(fda: fda,
                                  notifications: .init(status: notif),
                                  loginItems: .init(status: Self.combinedLoginItems(agentStatuses())))
    }

    /// One switch covers every agent: the worst status wins so the row never
    /// says "enabled" while one agent still needs approval.
    static func combinedLoginItems(_ statuses: [SMAppService.Status]) -> String {
        if statuses.isEmpty { return "notRegistered" }
        if statuses.contains(.notFound) { return "notFound" }
        if statuses.contains(.requiresApproval) { return "requiresApproval" }
        if statuses.contains(.notRegistered) { return "notRegistered" }
        return "enabled"
    }

    func request(_ which: String) async -> Bool {
        guard which == "notifications" else { return false }
        return (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    @MainActor
    func openSettings(_ target: String) {
        if target == "login-items" { SMAppService.openSystemSettingsLoginItems(); return }
        if let url = SystemSettingsLinks.url(forTarget: target, bundleId: bundleId) { NSWorkspace.shared.open(url) }
    }

    func resetAndReRequest() async -> Bool {
        let (exe, args) = TCCReset.arguments(bundleId: bundleId)
        let out = await runner.run(exe, args)
        if !out.ok {
            TrayLog.warn("tccutil reset failed", ["stderr": out.stderr])
        } else {
            // the reset revokes FDA immediately but macOS only re-applies a
            // fresh grant at the app's next launch — the relaunch hint is
            // the only way the row can become accurate again.
            markFdaNeedsRelaunch()
        }
        _ = await request("notifications")
        return out.ok
    }
}
