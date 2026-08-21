import Foundation

public struct NeedRequest: Codable, Equatable, Sendable {
    public var type: String      // app-register-services | app-unregister-services | app-privileged
    public var plists: [String]?
    public var op: String?       // proxy-install | proxy-remove
    public init(type: String, plists: [String]?, op: String?) { self.type = type; self.plists = plists; self.op = op }
}
