import Foundation

public enum UpdatePolicy {
    public static let placeholderKey = "REPLACE_WITH_RELEASE_PUBLIC_ED_KEY"
    public static let overrideEnv = "MATTSTACK_APPCAST_URL"
    public static let overrideFlag = "--allow-appcast-override"

    /// The clean-room VM points the app at a loopback appcast. Only the dev
    /// flavor, or a launch that opted in on the command line, may be redirected.
    public static func feedOverride(environment: [String: String], arguments: [String], isDevBuild: Bool) -> String? {
        guard let url = environment[overrideEnv], !url.isEmpty else { return nil }
        return (isDevBuild || arguments.contains(overrideFlag)) ? url : nil
    }

    /// Dev flavor never checks unless a feed override is in force; a build
    /// without a real EdDSA key must not talk to any feed it cannot verify.
    public static func shouldStartUpdater(isDevBuild: Bool, publicEDKey: String?, feedURL: String?, feedOverride: String?) -> Bool {
        guard let key = publicEDKey, !key.isEmpty, key != placeholderKey else { return false }
        if let o = feedOverride, !o.isEmpty { return true }
        guard !isDevBuild, let feed = feedURL, !feed.isEmpty else { return false }
        return true
    }

    public static func allowsImmediateInstall(setupRunning: Bool, windowsOpen: Int) -> Bool {
        !setupRunning && windowsOpen == 0
    }
}
