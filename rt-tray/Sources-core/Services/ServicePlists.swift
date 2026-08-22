import Foundation

public struct AgentPlist: Equatable, Sendable {
    public let label: String
    public let fileName: String
    public let bundleProgram: String?
    public init(label: String, fileName: String, bundleProgram: String? = nil) {
        self.label = label; self.fileName = fileName; self.bundleProgram = bundleProgram
    }
}

public enum ServicePlistScanner {
    public static func scan(directory: String, list: (String) -> [String], readLabel: (String) -> String?,
                             readBundleProgram: (String) -> String? = { _ in nil }) -> [AgentPlist] {
        list(directory).sorted().compactMap { file in
            let path = directory + "/" + file
            guard file.hasSuffix(".plist"), let label = readLabel(path) else { return nil }
            return AgentPlist(label: label, fileName: file, bundleProgram: readBundleProgram(path))
        }
    }
    public static func systemList(_ dir: String) -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
    }
    public static func systemReadLabel(_ path: String) -> String? {
        guard let data = FileManager.default.contents(atPath: path),
              let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return nil }
        return dict["Label"] as? String
    }
    public static func systemReadBundleProgram(_ path: String) -> String? {
        guard let data = FileManager.default.contents(atPath: path),
              let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return nil }
        return dict["BundleProgram"] as? String
    }
}

public enum ServiceProgramGuard {
    /// Registering an agent whose BundleProgram isn't in the bundle sends
    /// launchd into a respawn-failure loop (ThrottleInterval keeps retrying a
    /// spawn that can never succeed) -- callers must skip it instead. Returns
    /// the resolved path that's missing, or nil when the plist is safe to
    /// register (no BundleProgram, or it resolves to a real file).
    public static func missingProgramPath(bundleProgram: String?, bundlePath: String, exists: (String) -> Bool) -> String? {
        guard let program = bundleProgram, !program.isEmpty else { return nil }
        let full = bundlePath + "/" + program
        return exists(full) ? nil : full
    }

    /// Splits the scanned plists into the ones this bundle can actually run
    /// and the ones whose BundleProgram isn't shipped (a rendered
    /// `com.mattstack.deck.plist` with no `Contents/Helpers/deck` behind it).
    /// A skipped plist has to stay out of every status sweep, not just out of
    /// register: its permanent `notRegistered` is worst-wins input to the
    /// login-items permission, which is Install's own gate.
    public static func partition(_ agents: [AgentPlist], bundlePath: String,
                                 exists: (String) -> Bool) -> (runnable: [AgentPlist], skipped: [AgentPlist]) {
        var runnable: [AgentPlist] = [], skipped: [AgentPlist] = []
        for agent in agents {
            if missingProgramPath(bundleProgram: agent.bundleProgram, bundlePath: bundlePath, exists: exists) == nil {
                runnable.append(agent)
            } else {
                skipped.append(agent)
            }
        }
        return (runnable, skipped)
    }
}

public enum Kickstart {
    public static func arguments(label: String, uid: uid_t) -> (String, [String]) {
        ("/bin/launchctl", ["kickstart", "-k", "gui/\(uid)/\(label)"])
    }
}

public enum DeckRestart {
    public static func arguments(deckPath: String) -> (String, [String]) { (deckPath, ["restart", "--managed"]) }
}
