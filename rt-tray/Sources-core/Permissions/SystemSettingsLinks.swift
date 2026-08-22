import Foundation

public enum SystemSettingsLinks {
    public static let fullDiskAccess = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!
    public static let loginItems = URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension")!
    public static let keyboard = URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Shortcuts")!
    public static func notifications(bundleId: String) -> URL {
        URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(bundleId)")!
    }
    public static func url(forTarget target: String, bundleId: String) -> URL? {
        switch target {
        case "fda": return fullDiskAccess
        case "login-items": return loginItems
        case "notifications": return notifications(bundleId: bundleId)
        case "keyboard": return keyboard
        default: return nil
        }
    }
}
