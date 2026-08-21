import Foundation

public enum TeamMode: String, Codable, Equatable, Sendable { case join, create, restore, none }

public struct TeamInfo: Codable, Equatable, Sendable {
    public var slug: String?
    public var name: String?
    public var mode: TeamMode
    public init(slug: String? = nil, name: String? = nil, mode: TeamMode) {
        self.slug = slug; self.name = name; self.mode = mode
    }
}

public enum RowKind: String, Codable, Equatable, Sendable { case permission, tool, account, access, info }

/// Unknown values decode as `.error` so one new status from a newer rt
/// cannot blank the whole checklist.
public enum RowStatus: String, Codable, Equatable, Sendable {
    case ready, missing, invalid, checking, skipped, error
    case needsYou = "needs-you"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RowStatus(rawValue: raw) ?? .error
    }
}

public enum RecheckPolicy: String, Codable, Equatable, Sendable {
    case onActivate = "on-activate"
    case onChange = "on-change"
    case manual
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RecheckPolicy(rawValue: raw) ?? .manual
    }
}

public enum ActionType: String, Codable, Equatable, Sendable {
    case openSettings = "open-settings"
    case requestPermission = "request-permission"
    case connect, oauth, install, steps, run
    case ownerOnce = "owner-once"
    case linkBundled = "link-bundled"
    case openURL = "open-url"
    case unknown
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ActionType(rawValue: raw) ?? .unknown
    }
}

public struct ActionField: Codable, Equatable, Sendable {
    public var name: String
    public var label: String
    public var secret: Bool
    public var hint: String?
    public init(name: String, label: String, secret: Bool, hint: String? = nil) {
        self.name = name; self.label = label; self.secret = secret; self.hint = hint
    }
}

public struct ActionAlternative: Codable, Equatable, Sendable {
    public var id: String
    public var label: String
    public init(id: String, label: String) { self.id = id; self.label = label }
}

/// One shape for every contract action; which optionals are present is
/// discriminated by `type`. Kept flat so rt can add a field without a
/// decoder change here.
public struct RowAction: Codable, Equatable, Sendable {
    public var type: ActionType
    public var label: String
    public var target: String?
    public var which: String?
    public var integration: String?
    public var fields: [ActionField]?
    public var alternatives: [ActionAlternative]?
    public var verb: [String]?
    public var tool: String?
    public var via: String?
    public var steps: [String]?
    public var url: String?
    public init(type: ActionType, label: String, target: String? = nil, which: String? = nil,
                integration: String? = nil, fields: [ActionField]? = nil,
                alternatives: [ActionAlternative]? = nil, verb: [String]? = nil, tool: String? = nil,
                via: String? = nil, steps: [String]? = nil, url: String? = nil) {
        self.type = type; self.label = label; self.target = target; self.which = which
        self.integration = integration; self.fields = fields; self.alternatives = alternatives
        self.verb = verb; self.tool = tool; self.via = via; self.steps = steps; self.url = url
    }
}

public struct PlanRow: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var kind: RowKind
    public var title: String
    public var why: String
    public var required: Bool
    public var optionalNote: String?
    public var status: RowStatus
    public var detail: String?
    public var action: RowAction?
    public var recheck: RecheckPolicy
    public init(id: String, kind: RowKind, title: String, why: String, required: Bool,
                optionalNote: String? = nil, status: RowStatus, detail: String? = nil,
                action: RowAction? = nil, recheck: RecheckPolicy) {
        self.id = id; self.kind = kind; self.title = title; self.why = why; self.required = required
        self.optionalNote = optionalNote; self.status = status; self.detail = detail
        self.action = action; self.recheck = recheck
    }
}

public struct PlanGroup: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var rows: [PlanRow]
    public init(id: String, title: String, rows: [PlanRow]) { self.id = id; self.title = title; self.rows = rows }
}

public struct Plan: Codable, Equatable, Sendable {
    public var contract: Int
    public var at: String
    public var team: TeamInfo
    public var groups: [PlanGroup]
    public var canInstall: Bool
    public var requiredMissing: [String]
    public init(contract: Int = 1, at: String, team: TeamInfo, groups: [PlanGroup],
                canInstall: Bool, requiredMissing: [String]) {
        self.contract = contract; self.at = at; self.team = team; self.groups = groups
        self.canInstall = canInstall; self.requiredMissing = requiredMissing
    }
}
