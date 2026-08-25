import Foundation
import UserNotifications

/// User notifications posted by the flavor paths, which all end in a quit.
///
/// The blocking variants exist for the socket guard: it runs on the main
/// thread before the run loop, and a fire-and-forget `add` on a process that
/// is about to `exit(0)` is a notification nobody ever sees. The notification
/// centre answers on its own queue, so waiting on the main thread does not
/// starve the callback.
enum StandDownNotice {

    /// `UNUserNotificationCenter.current()` traps in a process with no bundle
    /// identity (an unbundled `swift build` binary), and the socket guard
    /// reaches this code before the AppDelegate that would otherwise have hit
    /// that first.
    private static var isAvailable: Bool { Bundle.main.bundleIdentifier != nil }

    static func isAuthorized(_ completion: @escaping (Bool) -> Void) {
        guard isAvailable else { completion(false); return }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            completion(settings.authorizationStatus == .authorized)
        }
    }

    static func post(title: String, body: String, identifier: String, completion: @escaping () -> Void) {
        guard isAvailable else {
            TrayLog.warn("notification skipped (unbundled process)", ["id": identifier])
            completion()
            return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = nil
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                TrayLog.warn("notification failed", ["id": identifier, "err": String(describing: error)])
            }
            completion()
        }
    }

    static func isAuthorizedBlocking(timeout: TimeInterval = 2) -> Bool {
        let answered = DispatchSemaphore(value: 0)
        let authorized = FlagBox()
        isAuthorized { granted in
            authorized.set(granted)
            answered.signal()
        }
        guard answered.wait(timeout: .now() + timeout) == .success else {
            TrayLog.warn("notification settings query timed out")
            return false
        }
        return authorized.get()
    }

    static func postBlocking(title: String, body: String, identifier: String, timeout: TimeInterval = 2) {
        guard isAuthorizedBlocking(timeout: timeout) else {
            TrayLog.warn("notification not posted (not authorized)", ["id": identifier])
            return
        }
        let delivered = DispatchSemaphore(value: 0)
        post(title: title, body: body, identifier: identifier) { delivered.signal() }
        if delivered.wait(timeout: .now() + timeout) == .timedOut {
            TrayLog.warn("notification delivery timed out", ["id": identifier])
        }
    }
}

private final class FlagBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set(_ v: Bool) { lock.lock(); value = v; lock.unlock() }
    func get() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
}
