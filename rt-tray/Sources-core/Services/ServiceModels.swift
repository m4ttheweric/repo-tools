import Foundation

public struct ServiceStatusEntry: Codable, Equatable, Sendable {
    public var label: String
    public var status: String
    public init(label: String, status: String) { self.label = label; self.status = status }
}

public struct ServiceRegisterResult: Codable, Equatable, Sendable {
    public var plist: String
    public var ok: Bool
    public var status: String
    public var error: String?
    public init(plist: String, ok: Bool, status: String, error: String? = nil) {
        self.plist = plist; self.ok = ok; self.status = status; self.error = error
    }
}

public protocol ServicesProviding: Sendable {
    func statuses() async -> [ServiceStatusEntry]
    func register(plists: [String]) async -> [ServiceRegisterResult]
    func unregister(plists: [String]) async -> [ServiceRegisterResult]
    func restart(label: String) async -> Bool
}
