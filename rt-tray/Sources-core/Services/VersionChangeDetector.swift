import Foundation

public protocol KeyValueStore: Sendable {
    func string(forKey key: String) -> String?
    func set(_ value: String?, forKey key: String)
}

public final class MemoryKeyValueStore: KeyValueStore, @unchecked Sendable {
    private var dict: [String: String] = [:]
    public init() {}
    public func string(forKey key: String) -> String? { dict[key] }
    public func set(_ value: String?, forKey key: String) { dict[key] = value }
}

public enum VersionChange: Equatable, Sendable {
    case firstLaunch
    case unchanged
    case changed(from: String, to: String)
}

/// Sparkle swaps the bundle but launchd keeps running the old inodes; the
/// app must notice its own version changed and restart the agents.
public enum VersionChangeDetector {
    public static let key = "MSLastLaunchedVersion"
    public static func evaluate(current: String, store: KeyValueStore) -> VersionChange {
        guard let last = store.string(forKey: key) else { return .firstLaunch }
        return last == current ? .unchanged : .changed(from: last, to: current)
    }
    public static func record(current: String, store: KeyValueStore) { store.set(current, forKey: key) }
}
