import Foundation

/// What rt polls at `GET /setup/need/<id>` while it waits for the app.
public struct NeedOutcome: Codable, Equatable, Sendable {
    public var state: String   // pending | done | failed
    public var detail: String
    public init(state: String, detail: String) { self.state = state; self.detail = detail }
    public static let pending = NeedOutcome(state: "pending", detail: "waiting for the app")
}

/// Executes rt's `need` events exactly once per step id and records the
/// outcome for rt's 1 s poll. Concurrent callers for one id join the same
/// execution; an id nobody has performed yet reads as pending so rt keeps
/// polling until its own 10-minute timeout instead of being told a story.
public actor NeedBroker {
    private let services: ServicesProviding
    private let privileged: PrivilegedInstalling
    private var inFlight: [String: Task<NeedResult, Never>] = [:]
    private var outcomes: [String: NeedOutcome] = [:]

    public init(services: ServicesProviding, privileged: PrivilegedInstalling) {
        self.services = services
        self.privileged = privileged
    }

    public func outcome(id: String) -> NeedOutcome { outcomes[id] ?? .pending }

    public func perform(id: String, request: NeedRequest) async -> NeedResult {
        if let task = inFlight[id] { return await task.value }
        outcomes[id] = .pending
        let services = self.services, privileged = self.privileged
        let task = Task<NeedResult, Never> {
            switch request.type {
            case "app-register-services":
                let results = await services.register(plists: request.plists ?? [])
                let failed = results.filter { !$0.ok }
                if failed.isEmpty {
                    return NeedResult(ok: true, detail: results.map { "\($0.plist): \($0.status)" }.joined(separator: ", "))
                }
                return NeedResult(ok: false, detail: failed.map { "\($0.plist): \($0.error ?? $0.status)" }.joined(separator: "; "))
            case "app-unregister-services":
                let results = await services.unregister(plists: request.plists ?? [])
                let failed = results.filter { !$0.ok }
                if failed.isEmpty {
                    return NeedResult(ok: true, detail: results.map { "\($0.plist): \($0.status)" }.joined(separator: ", "))
                }
                return NeedResult(ok: false, detail: failed.map { "\($0.plist): \($0.error ?? $0.status)" }.joined(separator: "; "))
            case "app-privileged" where request.op == "proxy-install":
                return await privileged.proxyInstall()
            case "app-privileged" where request.op == "proxy-remove":
                return await privileged.proxyRemove()
            default:
                return NeedResult(ok: false, detail: "unknown need type \(request.type)\(request.op.map { "/\($0)" } ?? "")")
            }
        }
        inFlight[id] = task
        let result = await task.value
        outcomes[id] = NeedOutcome(state: result.ok ? "done" : "failed", detail: result.detail)
        return result
    }

    /// A retry (`setup apply --from`) must be allowed to redo a step.
    public func forget(id: String) { inFlight[id] = nil; outcomes[id] = nil }
    public func forgetAll() { inFlight.removeAll(); outcomes.removeAll() }
}
