import Foundation
import AppKit
import UserNotifications

// MARK: - NotificationManager

/// Manages UNUserNotificationCenter — permission, categories, firing, and action handling.
class NotificationManager: NSObject, UNUserNotificationCenterDelegate {

    private let center = UNUserNotificationCenter.current()

    override init() {
        super.init()
        center.delegate = self
    }

    // MARK: - Permission

    func requestPermission() {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error {
                TrayLog.error("notification auth error", ["err": String(describing: error)])
            }
            TrayLog.info("notification permission \(granted ? "granted" : "denied")")
        }
    }

    // MARK: - Categories with Action Buttons

    func registerCategories() {
        let openMR = UNNotificationAction(
            identifier: "OPEN_MR",
            title: "Open MR",
            options: .foreground
        )

        let viewPipeline = UNNotificationAction(
            identifier: "VIEW_PIPELINE",
            title: "View Pipeline",
            options: .foreground
        )

        let merge = UNNotificationAction(
            identifier: "MERGE",
            title: "Merge",
            options: [.foreground, .destructive]
        )

        let showProcesses = UNNotificationAction(
            identifier: "SHOW_PROCESSES",
            title: "Show Processes",
            options: .foreground
        )

        // No .foreground — killing shouldn't drag the app to the front
        let killProcesses = UNNotificationAction(
            identifier: "KILL_PROCESSES",
            title: "Kill",
            options: .destructive
        )

        let fixKeyboard = UNNotificationAction(
            identifier: "FIX_KEYBOARD",
            title: "Show Me How",
            options: .foreground
        )

        let dismissKeyboard = UNNotificationAction(
            identifier: "DISMISS_KEYBOARD",
            title: "Don't Remind Me",
            options: []
        )

        let categories: [UNNotificationCategory] = [
            UNNotificationCategory(
                identifier: "keyboard_conflict",
                actions: [fixKeyboard, dismissKeyboard],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: "pipeline_failed",
                actions: [viewPipeline, openMR],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: "pipeline_passed",
                actions: [openMR],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: "mr_approved",
                actions: [merge, openMR],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: "mr_merged",
                actions: [openMR],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: "mr_ready",
                actions: [merge, openMR],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: "merge_conflicts",
                actions: [openMR],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: "needs_rebase",
                actions: [openMR],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: "merge_error",
                actions: [openMR],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: "stale_port",
                actions: [showProcesses],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: "runaway_process",
                actions: [killProcesses, showProcesses],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: "parked_workload",
                actions: [killProcesses, showProcesses],
                intentIdentifiers: []
            ),
        ]

        center.setNotificationCategories(Set(categories))
    }

    // MARK: - Sound selection

    /// Resolve the category → bundled .caf file and play it via NSSound.
    ///
    /// We play the sound manually rather than handing it to UNNotificationSound:
    /// on macOS UNNotificationSound(named:) only resolves files inside
    /// Contents/Library/Sounds/ or ~/Library/Sounds, which complicates app-bundle
    /// layout + ends up ignored in practice. NSSound(contentsOf:) reads straight
    /// from Contents/Resources/.
    ///
    /// Falls back to the built-in macOS "Funk" alert if the bundle didn't ship
    /// the expected .caf (older build, afconvert missing during bundling).
    static func playSound(for category: String) {
        let base: String
        switch category {
        case "pipeline_passed", "mr_approved", "mr_merged", "mr_ready":
            base = "positive"
        case "pipeline_failed", "mr_closed", "merge_conflicts", "merge_error", "runaway_process":
            base = "warning"
        default:
            base = "neutral"
        }

        if let url = Bundle.main.url(forResource: base, withExtension: "caf"),
           let sound = NSSound(contentsOf: url, byReference: false) {
            sound.play()
            return
        }

        NSSound(named: "Funk")?.play()
    }

    // MARK: - Fire Notification

    /// Fire a native macOS notification from a daemon event.
    func fire(_ event: NotificationEvent) {
        let content = UNMutableNotificationContent()
        content.title = event.title
        content.body = event.message
        content.sound = nil  // we play the sound ourselves below
        content.categoryIdentifier = event.category

        // Play the mapped sound immediately — banners are delivered within
        // milliseconds so this lines up with the visual alert.
        Self.playSound(for: event.category)

        // Stash the URL in userInfo so we can open it on click
        if let url = event.url {
            content.userInfo["url"] = url
        }

        // Stash pids so the Kill action can target them
        if let pids = event.pids, !pids.isEmpty {
            content.userInfo["pids"] = pids
        }

        let request = UNNotificationRequest(
            identifier: event.id,
            content: content,
            trigger: nil  // Deliver immediately
        )

        center.add(request) { error in
            if let error = error {
                TrayLog.error("notification error", ["err": String(describing: error)])
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Show notifications even when the app is in the foreground.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner])  // sound is played manually in fire()
    }

    /// Handle notification click and action button presses.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let url = userInfo["url"] as? String

        switch response.actionIdentifier {
        case "OPEN_MR":
            if let urlStr = url, let urlObj = URL(string: urlStr) {
                NSWorkspace.shared.open(urlObj)
            }

        case UNNotificationDefaultActionIdentifier:
            let category = response.notification.request.content.categoryIdentifier
            if category == "keyboard_conflict" {
                NotificationCenter.default.post(name: .showKeyboardConflict, object: nil)
            } else if let urlStr = url, let urlObj = URL(string: urlStr) {
                NSWorkspace.shared.open(urlObj)
            }

        case "VIEW_PIPELINE":
            // Append /pipelines to the MR URL to land on its Pipelines tab;
            // fall back to the MR itself if the composed URL is invalid.
            if let urlStr = url, let urlObj = URL(string: urlStr) {
                let pipelineURL = URL(string: urlStr + "/pipelines") ?? urlObj
                NSWorkspace.shared.open(pipelineURL)
            }

        case "MERGE":
            // TODO: Send merge command to daemon via socket
            // For now, open the MR so user can merge from the UI
            if let urlStr = url, let urlObj = URL(string: urlStr) {
                NSWorkspace.shared.open(urlObj)
            }

        case "SHOW_PROCESSES":
            NotificationCenter.default.post(name: .showProcessPanel, object: nil)

        case "KILL_PROCESSES":
            if let pids = userInfo["pids"] as? [Int], !pids.isEmpty {
                Self.killPids(pids)
            }

        case "FIX_KEYBOARD":
            NotificationCenter.default.post(name: .showKeyboardConflict, object: nil)

        case "DISMISS_KEYBOARD":
            MissionControlCheck.hasShownNotification = true

        default:
            break
        }

        completionHandler()
    }

    // MARK: - Kill action

    /// SIGTERM the pids (process group when the pid leads one), then escalate
    /// survivors to SIGKILL after 5s — same semantics as the process panel.
    static func killPids(_ pids: [Int]) {
        TrayLog.info("notification kill action", ["pids": pids])
        for pid in pids {
            _ = sendSignal(pid, SIGTERM)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
            let survivors = pids.filter { kill(Int32($0), 0) == 0 }
            for pid in survivors {
                _ = sendSignal(pid, SIGKILL)
            }
            if !survivors.isEmpty {
                TrayLog.warn("notification kill escalated to SIGKILL", ["pids": survivors])
            }
        }
    }

    private static func sendSignal(_ pid: Int, _ signal: Int32) -> Bool {
        let p = Int32(pid)
        if getpgid(p) == p, kill(-p, signal) == 0 {
            return true
        }
        return kill(p, signal) == 0
    }
}

// MARK: - Notification.Name

extension Notification.Name {
    static let showProcessPanel = Notification.Name("showProcessPanel")
    static let detachProcessPanel = Notification.Name("detachProcessPanel")
    static let showKeyboardConflict = Notification.Name("showKeyboardConflict")
}
