import Foundation

public struct NeedResult: Codable, Equatable, Sendable {
    public var ok: Bool
    public var detail: String
    public init(ok: Bool, detail: String) { self.ok = ok; self.detail = detail }
}

public protocol PrivilegedInstalling: Sendable {
    func proxyInstall() async -> NeedResult
    func proxyRemove() async -> NeedResult
}

public protocol PrivilegeEscalator: Sendable {
    func runAsAdmin(executable: String, args: [String], prompt: String) async -> CommandOutcome
}

public enum ProxyHelper {
    public static let relativePath = "Contents/Helpers/mattstack-proxy-install"
    public static func path(bundlePath: String) -> String { bundlePath + "/" + relativePath }
    public static let promptText = "mattstack needs administrator access once to install the local HTTPS proxy (portless) for the board and deck."
}
