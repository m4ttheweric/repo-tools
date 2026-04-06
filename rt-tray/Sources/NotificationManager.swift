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
                NSLog("rt-tray: notification auth error: \(error)")
            }
            NSLog("rt-tray: notification permission \(granted ? "granted" : "denied")")
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

        let killProcess = UNNotificationAction(
            identifier: "KILL_PROCESS",
            title: "Kill Process",
            options: .destructive
        )

        let categories: [UNNotificationCategory] = [
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
                actions: [killProcess],
                intentIdentifiers: []
            ),
        ]

        center.setNotificationCategories(Set(categories))
    }

    // MARK: - Fire Notification

    /// Fire a native macOS notification from a daemon event.
    func fire(_ event: NotificationEvent) {
        let content = UNMutableNotificationContent()
        content.title = event.title
        content.body = event.message
        content.sound = .default
        content.categoryIdentifier = event.category

        // Stash the URL in userInfo so we can open it on click
        if let url = event.url {
            content.userInfo["url"] = url
        }

        let request = UNNotificationRequest(
            identifier: event.id,
            content: content,
            trigger: nil  // Deliver immediately
        )

        center.add(request) { error in
            if let error = error {
                NSLog("rt-tray: notification error: \(error)")
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
        completionHandler([.banner, .sound])
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
        case "OPEN_MR", UNNotificationDefaultActionIdentifier:
            // Clicked the notification or "Open MR" button
            if let urlStr = url, let urlObj = URL(string: urlStr) {
                NSWorkspace.shared.open(urlObj)
            }

        case "VIEW_PIPELINE":
            // Open the MR URL (pipeline is accessed from there)
            if let urlStr = url, let urlObj = URL(string: urlStr) {
                // Append /-/pipelines to the MR URL to go directly to pipeline
                let pipelineURL = URL(string: urlStr + "/pipelines") ?? urlObj
                NSWorkspace.shared.open(pipelineURL)
            }

        case "MERGE":
            // TODO: Send merge command to daemon via socket
            // For now, open the MR so user can merge from the UI
            if let urlStr = url, let urlObj = URL(string: urlStr) {
                NSWorkspace.shared.open(urlObj)
            }

        case "KILL_PROCESS":
            // TODO: Extract PID from notification and kill it
            // For now, just dismiss
            NSLog("rt-tray: kill process action — not yet implemented")

        default:
            break
        }

        completionHandler()
    }
}
