import Foundation

// Probe-path list adapted from inket/FullDiskAccess and MacPaw/PermissionsKit
// (both MIT). Reading any of these succeeds only with Full Disk Access; the
// attempt itself adds the app to the FDA pane so the user only flips a switch.

public enum FDAProbeOutcome: Equatable, Sendable { case readable, permissionDenied, missing, otherError(Int32) }

public enum FDAProbe {
    public static let probePaths: [String] = [
        "~/Library/Containers/com.apple.stocks",
        "~/Library/Safari/CloudTabs.db",
        "~/Library/Safari/Bookmarks.plist",
        "~/Library/Application Support/com.apple.TCC/TCC.db",
        "/Library/Preferences/com.apple.TimeMachine.plist",
    ]

    public static func expanded(_ path: String, home: String) -> String {
        path.hasPrefix("~/") ? home + String(path.dropFirst(1)) : path
    }

    /// Always terminal: exhausting every path without a readable/denied
    /// verdict still resolves to denied, never unknown — a required row
    /// can't be left spinning forever with Install disabled.
    public static func evaluate(home: String, open: (String) -> FDAProbeOutcome) -> PermissionSnapshot.FDAState {
        var lastDetail = "no probe path was accessible"
        for raw in probePaths {
            let path = expanded(raw, home: home)
            switch open(path) {
            case .readable:         return .init(status: "granted", detail: "probe read \(raw)")
            case .permissionDenied: return .init(status: "denied", detail: "probe read \(raw) refused")
            case .missing:
                lastDetail = "probe read \(raw) missing (ENOENT)"
            case .otherError(let code):
                lastDetail = "probe read \(raw) failed (errno \(code))"
            }
        }
        return .init(status: "denied", detail: lastDetail)
    }

    /// The real open(2) attempt; lives here so the app target stays free of errno handling.
    public static func systemOpen(_ path: String) -> FDAProbeOutcome {
        let fd = Darwin.open(path, O_RDONLY)
        if fd >= 0 { Darwin.close(fd); return .readable }
        switch errno {
        case EPERM, EACCES: return .permissionDenied
        case ENOENT: return .missing
        default: return .otherError(errno)
        }
    }
}
