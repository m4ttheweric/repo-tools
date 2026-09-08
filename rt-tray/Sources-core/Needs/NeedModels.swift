import Foundation

public struct NeedResult: Codable, Equatable, Sendable {
    public var ok: Bool
    public var detail: String
    public init(ok: Bool, detail: String) { self.ok = ok; self.detail = detail }
}

public protocol PrivilegedInstalling: Sendable {
    func proxyInstall() async -> NeedResult
    func proxyRemove() async -> NeedResult
    func proxyTrust() async -> NeedResult
}

public protocol PrivilegeEscalator: Sendable {
    func runAsAdmin(executable: String, args: [String], prompt: String) async -> CommandOutcome
}

public enum ProxyHelper {
    public static let relativePath = "Contents/Helpers/mattstack-proxy-install"
    public static func path(bundlePath: String) -> String { bundlePath + "/" + relativePath }
    /// macOS asks for the certificate separately, under its own authorization
    /// (`com.apple.trust-settings.admin`, which caches nothing), so promising a
    /// single prompt would be untrue every time.
    public static let promptText = "mattstack needs administrator access to install the local HTTPS proxy (portless) for the board and deck. macOS will ask twice: once for this install, then again to trust the proxy's local certificate."
    public static let trustPromptText = "mattstack needs administrator access to trust the local proxy's certificate, so browsers stop warning about the board and deck."
}
