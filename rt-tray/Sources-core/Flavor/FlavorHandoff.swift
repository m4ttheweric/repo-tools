import Foundation

/// Reads back what the startup probe wrote by hand: the tray socket is spoken
/// to with raw sockets there, so there is no URLSession to parse the answer.
public enum HTTPReply {
    public static func parse(_ response: String) -> (status: Int, body: String)? {
        let head = response.components(separatedBy: "\r\n").first ?? ""
        let fields = head.components(separatedBy: " ")
        guard fields.count >= 2, fields[0].hasPrefix("HTTP/"), let status = Int(fields[1]) else { return nil }
        let body = response.range(of: "\r\n\r\n").map { String(response[$0.upperBound...]) } ?? ""
        return (status, body.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    public static func succeeded(_ response: String) -> Bool {
        guard let status = parse(response)?.status else { return false }
        return (200..<300).contains(status)
    }
}

/// The tray's own `/health` identity and the reading of someone else's.
public enum TrayHealth {
    public static func body(isDevBuild: Bool) -> String {
        "{\"ok\":true,\"app\":\"mattstack\",\"flavor\":\"\(FlavorIdentity.flavorName(isDevBuild: isDevBuild))\"}"
    }

    /// Takes the raw bytes off the socket, headers and all. An answer without
    /// a usable `flavor` reads as nil: a tray built before the field existed
    /// is unknown, never a mismatch.
    public static func flavor(inResponse response: String) -> String? {
        let body = HTTPReply.parse(response)?.body ?? response
        guard let data = body.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let flavor = obj["flavor"] as? String,
              flavor == "dev" || flavor == "prod"
        else { return nil }
        return flavor
    }
}

/// Serving because the machine named this flavor and serving because the read
/// failed are different facts, and `FlavorGate.decide` answers `.serve` to
/// both. Only the first licenses taking the socket off another tray.
public enum FlavorIntent {
    public static func confirms(myFlavorIsDev: Bool, modeReadResult: String?) -> Bool {
        guard let raw = modeReadResult else { return false }
        // A read that serves BOTH flavors named neither of them: it is
        // unparseable, not an endorsement.
        return FlavorGate.decide(myFlavorIsDev: myFlavorIsDev, modeReadResult: raw) == .serve
            && FlavorGate.decide(myFlavorIsDev: !myFlavorIsDev, modeReadResult: raw) != .serve
    }
}

/// Who gets `tray.sock` when a second tray starts. Only ever consulted by a
/// tray that the gate has cleared to serve; a standing-down tray never reaches
/// the socket at all.
public enum SocketOwnership {
    public enum Verdict: Equatable, Sendable {
        case takeOver
        case standAside
        case evictThenTakeOver
    }

    public static func decide(myFlavor: String, holderIsLive: Bool, holderFlavor: String?,
                              intentConfirmed: Bool) -> Verdict {
        guard holderIsLive else { return .takeOver }
        guard let holderFlavor, holderFlavor != myFlavor else { return .standAside }
        return intentConfirmed ? .evictThenTakeOver : .standAside
    }
}

/// The two bundles differ only by the dev suffix build.sh templates in
/// (`com.mattstack.app` / `com.mattstack.app.dev`), which is what lets a tray
/// name its sibling without a second hard-coded identifier to keep in sync.
public enum FlavorIdentity {
    public static let devSuffix = ".dev"

    public static func flavorName(isDevBuild: Bool) -> String { isDevBuild ? "dev" : "prod" }

    public static func sibling(ofBundleID id: String) -> String {
        id.hasSuffix(devSuffix) ? String(id.dropLast(devSuffix.count)) : id + devSuffix
    }
}

/// Every string the stand-down shows a human. Both flavors appear in the copy:
/// which app is going away and which mode the machine is in are different
/// facts, and a message that names only one of them reads as a bug.
public enum FlavorStandDownCopy {
    public static let quitButton = "Quit"

    public static func notificationTitle(myFlavor: String) -> String {
        "mattstack (\(myFlavor)) stood down"
    }

    public static func notificationBody(intended: String) -> String {
        "This Mac is in \(intended) mode, so the \(intended) app owns the daemon and the login item now. "
            + "Run `rt settings dev-mode` to see or change the intended mode."
    }

    public static func alertTitle(intended: String) -> String {
        "This Mac is in \(intended) mode"
    }

    public static func alertBody(myFlavor: String, intended: String) -> String {
        "You opened the \(myFlavor) app, but \(intended) is the mode this Mac is set to. "
            + "Switching hands the daemon, the login item and the CLI to \(myFlavor) and quits the \(intended) app."
    }

    public static func switchButton(myFlavor: String) -> String {
        "Switch to \(myFlavor) here"
    }
}
