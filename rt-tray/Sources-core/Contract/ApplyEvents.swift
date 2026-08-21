import Foundation

public struct NeedRequest: Codable, Equatable, Sendable {
    public var type: String      // app-register-services | app-unregister-services | app-privileged
    public var plists: [String]?
    public var op: String?       // proxy-install | proxy-remove
    public init(type: String, plists: [String]?, op: String?) { self.type = type; self.plists = plists; self.op = op }
}

/// Raw-value decoding is deliberately lenient: an unrecognized `kind`/`state`
/// must not throw and discard the whole event (a plan carries many steps —
/// one unfamiliar kind shouldn't blank the rest), so it falls back to
/// `.unknown` instead of failing decode.
public enum StepKind: String, Equatable, Sendable, Codable {
    case rt, app, privileged, unknown
    public init(from decoder: Decoder) throws {
        self = StepKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}
public enum StepState: String, Equatable, Sendable, Codable {
    case pending, running, done, failed, skipped, unknown
    public init(from decoder: Decoder) throws {
        self = StepState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

public struct StepInfo: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var kind: StepKind
    public init(id: String, title: String, kind: StepKind) { self.id = id; self.title = title; self.kind = kind }
}

/// One line of `rt setup apply --json`. `decode` never throws on an event
/// name it doesn't recognize — the contract can grow events the app hasn't
/// learned yet, and `.unknown` keeps the stream alive instead of killing the run.
public enum ApplyEvent: Equatable, Sendable {
    case plan([StepInfo])
    case step(id: String, state: StepState, detail: String?, remedy: String?)
    case log(id: String, line: String)
    case need(id: String, request: NeedRequest)
    case done(ok: Bool, failedStep: String?)
    case unknown(String)

    private struct Raw: Decodable {
        let event: String
        let steps: [StepInfo]?
        let id: String?
        let state: StepState?
        let detail: String?
        let remedy: String?
        let line: String?
        let request: NeedRequest?
        let ok: Bool?
        let failedStep: String?
    }

    public static func decode(_ line: String) throws -> ApplyEvent {
        let r = try JSONDecoder().decode(Raw.self, from: Data(line.utf8))
        switch r.event {
        case "plan": return .plan(r.steps ?? [])
        case "step": return .step(id: r.id ?? "", state: r.state ?? .pending, detail: r.detail, remedy: r.remedy)
        case "log": return .log(id: r.id ?? "", line: r.line ?? "")
        case "need": return .need(id: r.id ?? "", request: r.request ?? NeedRequest(type: "", plists: nil, op: nil))
        case "done": return .done(ok: r.ok ?? false, failedStep: r.failedStep)
        default: return .unknown(r.event)
        }
    }
}
