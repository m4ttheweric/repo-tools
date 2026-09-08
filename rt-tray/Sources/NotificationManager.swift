import Foundation
import AppKit
import MattstackCore
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

        // Copying rather than running it: approving team-authored shell is a
        // deliberate act, and the TTY prompt is where the ladder is shown.
        let copyApproveCommand = UNNotificationAction(
            identifier: "COPY_APPROVE_COMMAND",
            title: "Copy Command",
            options: []
        )

        let openSurface = UNNotificationAction(
            identifier: "OPEN_SURFACE",
            title: "Open",
            options: .foreground
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
                identifier: "new_comment",
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
                identifier: Self.readyHeldCategory,
                actions: [copyApproveCommand],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: "gate",
                actions: [openSurface],
                intentIdentifiers: []
            ),
        ]

        center.setNotificationCategories(Set(categories))
    }

    // MARK: - Sound selection

    /// Severity tiers behind the three bundled alert samples. A burst of
    /// notifications plays the highest tier it contains, once.
    private enum SoundTier: Int, Comparable {
        case neutral = 0
        case positive = 1
        case warning = 2

        var resource: String {
            switch self {
            case .neutral:  return "neutral"
            case .positive: return "positive"
            case .warning:  return "warning"
            }
        }

        static func < (lhs: SoundTier, rhs: SoundTier) -> Bool { lhs.rawValue < rhs.rawValue }
    }

    private static func tier(for category: String) -> SoundTier {
        switch category {
        case "pipeline_passed", "mr_approved", "mr_merged", "mr_ready":
            return .positive
        case "pipeline_failed", "mr_closed", "merge_conflicts", "merge_error", "runaway_process",
             readyHeldCategory:
            return .warning
        default:
            return .neutral
        }
    }

    /// How long a burst is collected before its single tone plays. Long enough
    /// to catch one daemon tick's worth of transitions (they arrive stamped the
    /// same millisecond), short enough to stay in sync with the banner.
    private static let coalesceWindow: TimeInterval = 0.25

    /// Burst state — confined to the main queue by `playSound`.
    private static var pendingTier: SoundTier?
    private static var coalescedCount = 0

    /// NSSound must outlive the scope that starts it or playback can be cut short.
    private static var playingSound: NSSound?

    /// Request the alert sound for a notification category.
    ///
    /// A single daemon refresh routinely emits several transitions at once —
    /// approved + ready + needs-rebase on one MR, or conflicts across three
    /// branches, all stamped the same millisecond. Playing one sample per event
    /// overlaps two copies of the same 1.2–5.5s file a millisecond apart, which
    /// is heard as one doubled, phased tone rather than as separate alerts. So a
    /// burst collapses into a single play at its highest severity: whichever
    /// event opens the window, a `pipeline_failed` landing 1ms later still wins
    /// over a `needs_rebase` that arrived first.
    static func playSound(for category: String) {
        let tier = tier(for: category)

        // Burst state is main-queue-confined; the queue-drain path calls in off-main.
        DispatchQueue.main.async {
            if let pending = Self.pendingTier {
                Self.pendingTier = max(pending, tier)
                Self.coalescedCount += 1
                return
            }

            Self.pendingTier = tier
            Self.coalescedCount = 1

            DispatchQueue.main.asyncAfter(deadline: .now() + Self.coalesceWindow) {
                let winner = Self.pendingTier ?? tier
                let count = Self.coalescedCount
                Self.pendingTier = nil
                Self.coalescedCount = 0

                if count > 1 {
                    TrayLog.info("coalesced notification sounds", ["count": count, "tier": winner.resource])
                }
                Self.play(winner)
            }
        }
    }

    /// Resolve the tier → bundled .caf file and play it via NSSound.
    ///
    /// We play the sound manually rather than handing it to UNNotificationSound:
    /// on macOS UNNotificationSound(named:) only resolves files inside
    /// Contents/Library/Sounds/ or ~/Library/Sounds, which complicates app-bundle
    /// layout + ends up ignored in practice. NSSound(contentsOf:) reads straight
    /// from Contents/Resources/.
    ///
    /// Falls back to the built-in macOS "Funk" alert if the bundle didn't ship
    /// the expected .caf (older build, afconvert missing during bundling).
    private static func play(_ tier: SoundTier) {
        TrayLog.info("notification sound", ["tier": tier.resource])

        if let url = Bundle.main.url(forResource: tier.resource, withExtension: "caf"),
           let sound = NSSound(contentsOf: url, byReference: false) {
            playingSound = sound
            sound.play()
            return
        }

        let fallback = NSSound(named: "Funk")
        playingSound = fallback
        fallback?.play()
    }

    // MARK: - Fire Notification

    /// Fire a native macOS notification from a daemon event.
    func fire(_ event: NotificationEvent) {
        let content = UNMutableNotificationContent()
        content.title = event.title
        content.body = event.message
        content.sound = nil  // we play the sound ourselves below
        content.categoryIdentifier = event.category

        // Request the mapped sound. Playback is coalesced across a short window,
        // so a tick that fires several events makes one tone, not a pile.
        Self.playSound(for: event.category)

        // Stash the URL in userInfo so we can open it on click
        if let url = event.url {
            content.userInfo["url"] = url
        }

        // Stash pids so the Kill action can target them
        if let pids = event.pids, !pids.isEmpty {
            content.userInfo["pids"] = pids
        }

        // Stash the pane id so a click focuses the pane instead of opening the URL
        if let paneId = event.paneId, !paneId.isEmpty {
            content.userInfo["paneId"] = paneId
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

    // MARK: - Held ready ladder (RT-98)

    static let readyHeldCategory = "ready_held"

    /// Fire the held-ladder alert.
    ///
    /// Unlike `fire`, this has no daemon `NotificationEvent` behind it: a hold
    /// is a state read off the status poll, not a queued transition, so the
    /// tray composes and de-dupes it (see `ReadyHeldNotifier`).
    ///
    /// `.timeSensitive` is a request, not a guarantee — without the
    /// time-sensitive entitlement macOS quietly downgrades it to `.active`.
    /// The panel badge, not this level, is what makes a hold impossible to miss.
    func fireReadyHeld(_ repo: ReadyHeldRepo) {
        let content = UNMutableNotificationContent()
        content.title = "Team ready steps held: \(repo.label)"
        content.body = "Worktree claims skip the declared steps until you run: \(repo.approveCommand)"
        content.sound = nil
        content.categoryIdentifier = Self.readyHeldCategory
        content.interruptionLevel = .timeSensitive
        content.userInfo["approveCommand"] = repo.approveCommand

        Self.playSound(for: Self.readyHeldCategory)

        // Identified by (hash, repo) so a re-nag replaces the previous banner
        // for the same hold rather than stacking a second copy in the centre.
        let request = UNNotificationRequest(
            identifier: "\(Self.readyHeldCategory):\(ReadyHeldNotifier.ledgerKey(repo))",
            content: content,
            trigger: nil
        )

        center.add(request) { error in
            if let error = error {
                TrayLog.error("ready-held notification error", ["err": String(describing: error)])
            }
        }
    }

    /// Put the approve command on the pasteboard. Approving team-authored
    /// shell stays a deliberate act in a TTY, where the ladder is displayed.
    private static func copyApproveCommand(_ command: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        TrayLog.info("copied ready-approve command")
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

        case "OPEN_SURFACE":
            if let urlStr = url, let urlObj = URL(string: urlStr) {
                NSWorkspace.shared.open(urlObj)
            }

        case UNNotificationDefaultActionIdentifier:
            let category = response.notification.request.content.categoryIdentifier
            if category == "keyboard_conflict" {
                NotificationCenter.default.post(name: .showKeyboardConflict, object: nil)
            } else if category == Self.readyHeldCategory {
                NotificationCenter.default.post(name: .showProcessPanel, object: nil)
            } else if let paneId = userInfo["paneId"] as? String, !paneId.isEmpty {
                // Focus is best-effort on click; the outcome isn't surfaced.
                _ = HerdrBridge.shared.focusPaneById(paneId)
            } else if let urlStr = url, let urlObj = URL(string: urlStr) {
                NSWorkspace.shared.open(urlObj)
            }

        case "COPY_APPROVE_COMMAND":
            if let command = userInfo["approveCommand"] as? String {
                Self.copyApproveCommand(command)
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
