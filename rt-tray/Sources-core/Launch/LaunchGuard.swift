import Foundation

public enum LaunchGuard {
    /// Gatekeeper runs a quarantined app from a random read-only mount; a
    /// DMG is a volume. Either way SMAppService and Sparkle cannot work.
    public static func isTranslocatedOrOnRemovableVolume(bundlePath: String) -> Bool {
        bundlePath.contains("/AppTranslocation/") || bundlePath.hasPrefix("/Volumes/")
    }
}

public enum FirstRunDetector {
    public static func needsSetup(home: String, fileExists: (String) -> Bool) -> Bool {
        !fileExists("\(home)/.mattstack/rt/daemon.json")
    }
}

public enum JoinLink {
    public static func code(from url: URL) -> String? {
        guard url.scheme?.lowercased() == "mattstack", url.host?.lowercased() == "join" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 1 else { return nil }
        let code = parts[0].trimmingCharacters(in: .whitespacesAndNewlines)
        return code.isEmpty ? nil : code
    }
}

public enum AppPathSetting {
    /// `JSONEncoder`/plain `JSONSerialization` escape `/` as `\/`, which a
    /// file path has no reason to carry — `.withoutEscapingSlashes` keeps
    /// the value a real JSON string literal without that noise.
    public static func arguments(bundlePath: String) -> [String] {
        let data = (try? JSONSerialization.data(withJSONObject: bundlePath, options: [.fragmentsAllowed, .withoutEscapingSlashes]))
            ?? Data("\"\"".utf8)
        return ["settings", "set", "mattstack.appPath", String(decoding: data, as: UTF8.self), "--scope", "machine"]
    }
}
