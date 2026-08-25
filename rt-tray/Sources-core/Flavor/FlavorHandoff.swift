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

public enum BundlePresence: Equatable, Sendable {
    case present(path: String)
    /// Neither install location holds it, and this flavor has no other home.
    case notInstalled
    /// Neither install location holds it, but this flavor's bundle can live
    /// in whatever checkout built it — named only by a setting this process
    /// cannot read.
    case unlocatable

    public var isPresent: Bool { if case .present = self { return true }; return false }
}

/// Where a flavor's bundle is, using only what a Swift process can prove:
/// `/Applications` then `~/Applications`, the last two legs of the CLI's own
/// resolution. The first leg — the `mattstack.appPath` machine setting — needs
/// the settings resolver, so its absence is reported as unlocatable rather
/// than guessed at.
public enum FlavorBundle {
    public static func bundleName(ofFlavor flavor: String) -> String {
        flavor == "dev" ? "mattstack-dev.app" : "mattstack.app"
    }

    public static func presence(ofFlavor flavor: String, home: String, fileExists: (String) -> Bool) -> BundlePresence {
        let bundle = bundleName(ofFlavor: flavor)
        for candidate in ["/Applications/\(bundle)", "\(home)/Applications/\(bundle)"] where fileExists(candidate) {
            return .present(path: candidate)
        }
        // Prod installs to one of those two; only the dev bundle routinely
        // lives somewhere this process cannot name.
        return flavor == "dev" ? .unlocatable : .notInstalled
    }
}

public enum StandDownRoute: Equatable, Sendable {
    case silent
    case alert
}

public enum StandDownPlan {
    /// Standing down silently takes three things: a launch positively
    /// identified as the login item, somewhere for the user to find out it
    /// happened, and a bundle to hand the machine to. Missing any of them,
    /// the user decides instead — unregistering with no trace, or in favour
    /// of a flavor that is not installed, leaves a Mac with no tray and no
    /// explanation.
    public static func route(origin: LaunchOrigin, notificationsAuthorized: Bool,
                             intendedBundle: BundlePresence) -> StandDownRoute {
        guard LaunchKind.mayStandDownSilently(origin), notificationsAuthorized, intendedBundle.isPresent
        else { return .alert }
        return .silent
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

    /// Shown when the mode this Mac points at has no bundle we can find:
    /// switching here is then the only move that leaves it with a tray.
    public static func missingBundleNote(intended: String) -> String {
        "\n\nNo \(intended) app was found in /Applications or ~/Applications, so nothing else is running the daemon on this Mac."
    }

    public static func stuckHolderTitle(holderFlavor: String) -> String {
        "A \(holderFlavor) mattstack is still holding the tray socket"
    }

    public static func stuckHolderBody(holderFlavor: String, myFlavor: String) -> String {
        "The \(holderFlavor) app was asked to retire and did not quit, so the \(myFlavor) app stopped instead of fighting it for the socket. "
            + "Quit the \(holderFlavor) app from its menu bar, or log out and back in."
    }
}
