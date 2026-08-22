import Foundation

/// The three permission rows as the app measures them. Wire format is the
/// contract's `GET /permissions` body.
public struct PermissionSnapshot: Codable, Equatable, Sendable {
    public struct FDAState: Codable, Equatable, Sendable {
        public var status: String   // granted | denied | unknown
        public var detail: String
        public init(status: String, detail: String) { self.status = status; self.detail = detail }
    }
    public struct NotificationsState: Codable, Equatable, Sendable {
        public var status: String   // authorized | denied | notDetermined | provisional
        public init(status: String) { self.status = status }
    }
    public struct LoginItemsState: Codable, Equatable, Sendable {
        public var status: String   // enabled | requiresApproval | notRegistered | notFound
        public init(status: String) { self.status = status }
    }
    public var fda: FDAState
    public var notifications: NotificationsState
    public var loginItems: LoginItemsState
    public init(fda: FDAState, notifications: NotificationsState, loginItems: LoginItemsState) {
        self.fda = fda; self.notifications = notifications; self.loginItems = loginItems
    }
    public static let unknown = PermissionSnapshot(fda: .init(status: "unknown", detail: "not probed yet"),
                                                   notifications: .init(status: "notDetermined"),
                                                   loginItems: .init(status: "notRegistered"))
}

public enum PermissionRowOverlay {
    public static let fdaRow = "perm.fda"
    public static let loginItemsRow = "perm.login-items"
    public static let notificationsRow = "perm.notifications"

    public static func status(for rowId: String, in s: PermissionSnapshot) -> (RowStatus, String)? {
        switch rowId {
        case fdaRow:
            switch s.fda.status {
            case "granted": return (.ready, s.fda.detail)
            case "denied":  return (.needsYou, "Not granted")
            default:        return (.checking, s.fda.detail)
            }
        case loginItemsRow:
            switch s.loginItems.status {
            case "enabled":          return (.ready, "Enabled")
            case "requiresApproval": return (.needsYou, "Needs approval in Login Items")
            case "notFound":         return (.error, "Agent plist not found in the bundle")
            default:                 return (.missing, "Not registered")
            }
        case notificationsRow:
            switch s.notifications.status {
            case "authorized", "provisional": return (.ready, "Allowed")
            case "denied":                    return (.needsYou, "Denied in System Settings")
            default:                          return (.skipped, "Not decided")
            }
        default:
            return nil
        }
    }
}
