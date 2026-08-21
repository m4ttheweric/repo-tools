import Foundation

public struct RtUserError: Codable, Error, Equatable, Sendable {
    public var code: String?
    public var message: String
    public init(code: String? = nil, message: String) { self.code = code; self.message = message }
}

struct ErrorEnvelope: Decodable { let error: RtUserError }

public struct ConnectResult: Codable, Equatable, Sendable {
    public var integration: String
    public var status: RowStatus
    public var detail: String?
    public var scopesSeen: [String]?
    // rt setup github status only; absent (decodeIfPresent) for other integrations.
    public var handle: String?
    public var owners: [String]?
    public init(integration: String, status: RowStatus, detail: String? = nil, scopesSeen: [String]? = nil,
                handle: String? = nil, owners: [String]? = nil) {
        self.integration = integration; self.status = status; self.detail = detail; self.scopesSeen = scopesSeen
        self.handle = handle; self.owners = owners
    }
}

public struct TeamJoinResult: Codable, Equatable, Sendable {
    public struct Team: Codable, Equatable, Sendable {
        public var slug: String; public var name: String; public var owner: String?
        public init(slug: String, name: String, owner: String? = nil) { self.slug = slug; self.name = name; self.owner = owner }
    }
    public var team: Team?
    public var access: String      // ok | denied | unreachable
    public var peering: String?    // applied | idle | unavailable
    public var message: String?
    public init(team: Team? = nil, access: String, peering: String? = nil, message: String? = nil) {
        self.team = team; self.access = access; self.peering = peering; self.message = message
    }
}

public struct InviteResult: Codable, Equatable, Sendable {
    public var code: String
    public var expiresAt: String
    public var pasteBlock: String
    public var forgeAccess: String    // granted | manual | skipped
    public var manualSteps: [String]?
    public init(code: String, expiresAt: String, pasteBlock: String, forgeAccess: String, manualSteps: [String]? = nil) {
        self.code = code; self.expiresAt = expiresAt; self.pasteBlock = pasteBlock
        self.forgeAccess = forgeAccess; self.manualSteps = manualSteps
    }
}

public struct UninstallPlan: Codable, Equatable, Sendable {
    public struct Action: Codable, Equatable, Identifiable, Sendable {
        public var id: String; public var title: String
        public init(id: String, title: String) { self.id = id; self.title = title }
    }
    public var actions: [Action]
    public init(actions: [Action]) { self.actions = actions }
}

public struct VersionInfo: Codable, Equatable, Sendable {
    public var version: String
    public var build: Int        // numeric CFBundleVersion: major*1e6 + minor*1e3 + patch (L4 scheme; 2.8.0 → 2008000)
    public var flavor: String   // prod | dev
    public var path: String
    public init(version: String, build: Int, flavor: String, path: String) {
        self.version = version; self.build = build; self.flavor = flavor; self.path = path
    }
}
