import AppKit
import MattstackCore

/// Reads the launch Apple Event that started this process.
///
/// `currentAppleEvent` is only non-nil while AppKit is still dispatching that
/// event, which `applicationDidFinishLaunching` is inside of — read it there
/// or not at all. A nil read is `unknown`, and uncertainty never takes the
/// silent branch.
enum TrayLaunchOrigin {
    static func current() -> LaunchOrigin {
        let event = NSAppleEventManager.shared().currentAppleEvent
        return LaunchKind.classify(eventID: event?.eventID,
                                   propData: event?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue)
    }
}
