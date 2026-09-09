import AppKit
import MattstackCore

/// macOS 15+ raises a permission alert on this read, so it happens only from
/// the Paste invite button. A denial is indistinguishable from an empty
/// clipboard here, and both mean "leave the field alone".
public struct SystemPasteboard: PasteboardReading {
    public init() {}
    public func inviteText() -> String? { NSPasteboard.general.string(forType: .string) }
}
