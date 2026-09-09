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

    /// The URL shape is host-agnostic, matching lib/team/invite-crypto.ts: a
    /// link minted under RT_JOIN_BASE_URL carries the code in the same fragment.
    public static func code(fromText text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var candidate = trimmed
        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() {
            if scheme == "mattstack" {
                guard let code = code(from: url) else { return nil }
                candidate = code
            } else if let fragment = url.fragment, !fragment.isEmpty {
                candidate = fragment
            } else if url.host != nil {
                return nil
            }
        }
        let normalized = normalize(candidate)
        guard normalized.count == 77, normalized.allSatisfy({ alphabet.contains($0) }) else { return nil }
        return normalized
    }

    static let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    static func normalize(_ raw: String) -> String {
        String(raw.uppercased().compactMap { ch -> Character? in
            if ch == "-" || ch.isWhitespace || ch.isNewline { return nil }
            if ch == "O" { return "0" }
            if ch == "I" || ch == "L" { return "1" }
            return ch
        })
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
