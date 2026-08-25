import Foundation
import CoreServices

public enum LaunchOrigin: Equatable, Sendable {
    case loginItem
    case userLaunch
    case unknown
}

/// How this launch was started, read from the launch Apple Event.
///
/// The absence of an event is `unknown`, not `userLaunch`: the silent
/// stand-down unregisters the login item and the daemon agent, and re-granting
/// those is a trip through System Settings. Only a positive login-item
/// identification may take that branch.
public enum LaunchKind {
    public static func classify(eventID: UInt32?, propData: UInt32?) -> LaunchOrigin {
        guard let eventID else { return .unknown }
        guard eventID == UInt32(kAEOpenApplication) else { return .userLaunch }
        return propData == UInt32(keyAELaunchedAsLogInItem) ? .loginItem : .userLaunch
    }

    public static func mayStandDownSilently(_ origin: LaunchOrigin) -> Bool {
        origin == .loginItem
    }
}
