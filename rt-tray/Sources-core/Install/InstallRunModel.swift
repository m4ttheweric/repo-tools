import Foundation
import Combine

public typealias ApplyStreamFactory = @Sendable (_ from: String?) -> AsyncThrowingStream<String, Error>

public struct InstallStep: Equatable, Identifiable, Sendable {
    public var info: StepInfo
    public var state: StepState
    public var detail: String?
    public var remedy: String?
    public var waitingOnYou: Bool
    public var id: String { info.id }
    public init(info: StepInfo, state: StepState = .pending, detail: String? = nil, remedy: String? = nil, waitingOnYou: Bool = false) {
        self.info = info; self.state = state; self.detail = detail; self.remedy = remedy; self.waitingOnYou = waitingOnYou
    }
}

/// Renders `rt setup apply --json`. Steps come only from the stream's plan
/// event; the app executes `need` events through NeedBroker and otherwise
/// just shows what rt says. Retry resumes from the failed step and keeps
/// the earlier rows so the list never "forgets" what already happened.
@MainActor
public final class InstallRunModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case idle, running, succeeded
        case failed(stepId: String, remedy: String?)
        case streamError(String)
    }

    @Published public private(set) var steps: [InstallStep] = []
    @Published public private(set) var phase: Phase = .idle
    @Published public private(set) var logs: [String: [String]] = [:]

    private let stream: ApplyStreamFactory
    private let needs: NeedBroker
    private var task: Task<Void, Never>?
    public static let logCapPerStep = 500

    public init(stream: @escaping ApplyStreamFactory, needs: NeedBroker) {
        self.stream = stream
        self.needs = needs
    }

    public var isRunning: Bool { phase == .running }
    public var failedStepId: String? { if case .failed(let id, _) = phase { return id }; return nil }
    public func logLines(for id: String) -> [String] { logs[id] ?? [] }

    /// A fresh run (not a retry) must not see need outcomes left over from a
    /// previous attempt at this window's lifetime, or a step could report
    /// success from a need it never actually performed this time.
    public func start(from: String? = nil) {
        task?.cancel()
        phase = .running
        if from == nil {
            steps = []
            logs = [:]
            Task { await needs.forgetAll() }
        }
        let stream = self.stream(from)
        task = Task { [weak self] in
            do {
                for try await line in stream {
                    guard let self else { return }
                    let event: ApplyEvent
                    do { event = try ApplyEvent.decode(line) } catch { self.append(log: "unparsed: \(line)", to: "_stream"); continue }
                    await self.handle(event)
                }
                guard let self, self.phase == .running else { return }
                self.phase = .streamError("rt setup apply ended without a done event")
            } catch {
                self?.phase = .streamError(String(describing: error))
            }
        }
    }

    public func retryFromFailure() {
        guard let id = failedStepId else { return }
        Task { await needs.forget(id: id) }
        start(from: id)
    }

    private func handle(_ event: ApplyEvent) async {
        Self.apply(event, to: &steps)
        switch event {
        case .log(let id, let line):
            append(log: line, to: id)
        case .need(let id, let request):
            let result = await needs.perform(id: id, request: request)
            append(log: "\(request.type): \(result.detail)", to: id)
            if let i = steps.firstIndex(where: { $0.id == id }) {
                steps[i].waitingOnYou = false
                if !result.ok { steps[i].detail = result.detail }
            }
        case .done(let ok, let failedStep):
            if ok { phase = .succeeded }
            else {
                let id = failedStep ?? steps.last(where: { $0.state == .failed })?.id ?? "?"
                phase = .failed(stepId: id, remedy: steps.first(where: { $0.id == id })?.remedy)
            }
        default:
            break
        }
    }

    private func append(log line: String, to id: String) {
        var arr = logs[id] ?? []
        arr.append(line)
        if arr.count > Self.logCapPerStep { arr.removeFirst(arr.count - Self.logCapPerStep) }
        logs[id] = arr
    }

    /// Pure reducer, shared with the checks. A `plan` after a retry merges by
    /// id: existing rows keep their place, new ids append.
    public static nonisolated func apply(_ event: ApplyEvent, to steps: inout [InstallStep]) {
        switch event {
        case .plan(let infos):
            for info in infos {
                if let i = steps.firstIndex(where: { $0.id == info.id }) {
                    steps[i].info = info
                    steps[i].state = .pending
                    steps[i].remedy = nil
                    steps[i].waitingOnYou = false
                } else {
                    steps.append(InstallStep(info: info))
                }
            }
        case .step(let id, let state, let detail, let remedy):
            guard let i = steps.firstIndex(where: { $0.id == id }) else { return }
            steps[i].state = state
            if let detail { steps[i].detail = detail }
            if let remedy { steps[i].remedy = remedy }
            if state != .running { steps[i].waitingOnYou = false }
        case .need(let id, _):
            if let i = steps.firstIndex(where: { $0.id == id }) { steps[i].waitingOnYou = true }
        case .log, .done, .unknown:
            break
        }
    }
}
