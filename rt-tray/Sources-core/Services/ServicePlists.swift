import Foundation

public struct AgentPlist: Equatable, Sendable {
    public let label: String
    public let fileName: String
    public init(label: String, fileName: String) { self.label = label; self.fileName = fileName }
}

public enum ServicePlistScanner {
    public static func scan(directory: String, list: (String) -> [String], readLabel: (String) -> String?) -> [AgentPlist] {
        list(directory).sorted().compactMap { file in
            guard file.hasSuffix(".plist"), let label = readLabel(directory + "/" + file) else { return nil }
            return AgentPlist(label: label, fileName: file)
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
}

public enum Kickstart {
    public static func arguments(label: String, uid: uid_t) -> (String, [String]) {
        ("/bin/launchctl", ["kickstart", "-k", "gui/\(uid)/\(label)"])
    }
}

public enum DeckRestart {
    public static func arguments(deckPath: String) -> (String, [String]) { (deckPath, ["restart", "--managed"]) }
}
