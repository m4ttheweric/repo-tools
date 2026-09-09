import Foundation

public struct RouteResponse: Equatable, Sendable {
    public let status: Int
    public let body: String
    public init(status: Int, body: String) { self.status = status; self.body = body }
}

/// The contract's tray.sock additions (§5.3). Pure: providers are injected,
/// HTTP framing stays in TrayServer.
public struct TrayRoutes: Sendable {
    private let permissions: PermissionsProviding
    private let services: ServicesProviding
    private let privileged: PrivilegedInstalling
    private let needs: NeedBroker
    private let updater: UpdateChecking
    private let version: VersionProviding

    public init(permissions: PermissionsProviding, services: ServicesProviding, privileged: PrivilegedInstalling,
                needs: NeedBroker, updater: UpdateChecking, version: VersionProviding) {
        self.permissions = permissions; self.services = services; self.privileged = privileged
        self.needs = needs; self.updater = updater; self.version = version
    }

    public static let paths: Set<String> = ["/permissions", "/permissions/request", "/services", "/services/register",
                                            "/services/restart", "/privileged/proxy-install", "/privileged/proxy-trust",
                                            "/update/check", "/version"]

    public func handle(method: String, path: String, body: Data?) async -> RouteResponse? {
        let isNeed = path.hasPrefix("/setup/need/")
        guard Self.paths.contains(path) || isNeed else { return nil }
        switch (method, path) {
        case ("GET", "/permissions"):
            return encode(await permissions.snapshot())
        case ("POST", "/permissions/request"):
            guard let which = field("which", in: body) else { return bad("which is required") }
            let ok = await permissions.request(which)
            return RouteResponse(status: 200, body: "{\"ok\":\(ok)}")
        case ("GET", "/services"):
            return encode(["agents": await services.statuses()])
        case ("POST", "/services/register"):
            guard let plists = list("plists", in: body) else { return bad("plists is required") }
            let results = await services.register(plists: plists)
            struct Reply: Encodable { let ok: Bool; let results: [ServiceRegisterResult] }
            return encode(Reply(ok: results.allSatisfy(\.ok), results: results))
        case ("POST", "/services/restart"):
            guard let label = field("label", in: body) else { return bad("label is required") }
            return RouteResponse(status: 200, body: "{\"ok\":\(await services.restart(label: label))}")
        case ("POST", "/privileged/proxy-install"):
            return encode(await privileged.proxyInstall())
        case ("POST", "/privileged/proxy-trust"):
            return encode(await privileged.proxyTrust())
        case ("GET", _) where isNeed:
            let id = String(path.dropFirst("/setup/need/".count))
            guard !id.isEmpty else { return bad("need id is required") }
            return encode(await needs.outcome(id: id))
        case ("POST", "/update/check"):
            return RouteResponse(status: 200, body: "{\"ok\":\(await updater.checkForUpdates())}")
        case ("GET", "/version"):
            return encode(version.versionInfo())
        default:
            return RouteResponse(status: 405, body: "{\"ok\":false,\"error\":\"method not allowed\"}")
        }
    }

    private func encode<T: Encodable>(_ value: T) -> RouteResponse {
        let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys]
        guard let data = try? enc.encode(value) else { return RouteResponse(status: 500, body: "{\"ok\":false,\"error\":\"encode\"}") }
        return RouteResponse(status: 200, body: String(decoding: data, as: UTF8.self))
    }
    private func bad(_ msg: String) -> RouteResponse { RouteResponse(status: 400, body: "{\"ok\":false,\"error\":\"\(msg)\"}") }
    private func object(_ body: Data?) -> [String: Any]? {
        guard let body else { return nil }
        return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    }
    private func field(_ name: String, in body: Data?) -> String? { object(body)?[name] as? String }
    private func list(_ name: String, in body: Data?) -> [String]? { object(body)?[name] as? [String] }
}
