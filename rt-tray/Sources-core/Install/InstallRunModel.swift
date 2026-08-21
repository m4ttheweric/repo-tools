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
    /// Parse failures and contract events this build doesn't recognize —
    /// surfaced for diagnostics, never blocks the run.
    @Published public private(set) var streamNotes: [String] = []

    private let stream: ApplyStreamFactory
    private let needs: NeedBroker
    private var task: Task<Void, Never>?
    /// Bumped on every start(); every write a run task makes is guarded by
    /// the generation it was born with, so a stale task from a superseded
    /// run — cancellation is cooperative, not preemptive — can never mutate
    /// state a newer run owns, however late its stream or its in-flight
    /// needs.perform() resolves.
    private var generation = 0
    public static let logCapPerStep = 500

    public init(stream: @escaping ApplyStreamFactory, needs: NeedBroker) {
        self.stream = stream
        self.needs = needs
    }

    public var isRunning: Bool { phase == .running }
    public var failedStepId: String? { if case .failed(let id, _) = phase { return id }; return nil }
    /// The step to resume from: the failed step, or — if the stream itself
    /// died — whichever step was still running when it did.
    public var resumableStepId: String? {
        switch phase {
        case .failed(let id, _): return id
        case .streamError: return steps.first(where: { $0.state == .running })?.id
        default: return nil
        }
    }
    public func logLines(for id: String) -> [String] { logs[id] ?? [] }

    public func start(from: String? = nil) {
        task?.cancel()
        generation += 1
        let gen = generation
        phase = .running
        if from == nil {
            steps = []
            logs = [:]
            streamNotes = []
        }
        // Captured up front, without touching self, so the needs-ledger
        // clear and stream creation never hold a strong self across their
        // awaits — a dismissed owning view must be free to deallocate the
        // model while a run is still in flight, not just after it ends.
        let needs = self.needs
        let makeStream = self.stream
        task = Task { [weak self] in
            // A retry must forget only the failed step's need so earlier
            // steps' outcomes survive; a fresh run forgets everything. Both
            // are awaited before the stream factory runs, so rt never races
            // a poll against a ledger entry this run hasn't cleared yet.
            if let from { await needs.forget(id: from) } else { await needs.forgetAll() }
            guard self?.generation == gen else { return }
            let stream = makeStream(from)
            do {
                for try await line in stream {
                    // Re-derived every iteration and released at its end, so
                    // no strong self is held while suspended waiting on the
                    // next line — only for the synchronous work plus one
                    // handle() call this iteration needs.
                    guard let self, self.generation == gen else { return }
                    let event: ApplyEvent
                    do { event = try ApplyEvent.decode(line) }
                    catch { self.noteStreamIssue("unparsed: \(line)", gen: gen); continue }
                    await self.handle(event, gen: gen)
                }
                guard self?.generation == gen, self?.phase == .running else { return }
                self?.phase = .streamError("rt setup apply ended without a done event")
            } catch {
                // rt can throw after already emitting `done` (e.g. a nonzero
                // exit racing the final line); a phase a `done` event already
                // terminalized must not be clobbered, same as the normal-
                // completion branch above.
                guard self?.generation == gen, self?.phase == .running else { return }
                self?.phase = .streamError(Self.describe(error))
            }
        }
    }

    public func retryFromFailure() {
        guard let id = resumableStepId else { return }
        start(from: id)
    }

    deinit { task?.cancel() }

    private func handle(_ event: ApplyEvent, gen: Int) async {
        guard generation == gen else { return }
        Self.apply(event, to: &steps)
        switch event {
        case .log(let id, let line):
            appendLog(line, to: id)
        case .need(let id, let request):
            let result = await needs.perform(id: id, request: request)
            guard generation == gen else { return }
            appendLog("\(request.type): \(result.detail)", to: id)
            if let i = steps.firstIndex(where: { $0.id == id }) {
                steps[i].waitingOnYou = false
                if !result.ok { steps[i].detail = result.detail }
            }
        case .done(let ok, let failedStep):
            if ok {
                phase = .succeeded
            } else if let failedStep {
                phase = .failed(stepId: failedStep, remedy: steps.first(where: { $0.id == failedStep })?.remedy)
            } else if let failing = steps.first(where: { $0.state == .failed }) {
                phase = .failed(stepId: failing.id, remedy: failing.remedy)
            } else if let running = steps.first(where: { $0.state == .running }) {
                // rt reported failure without naming a step but left one
                // running — treat that one as the failure rather than
                // inventing an id nothing in the plan owns.
                phase = .failed(stepId: running.id, remedy: nil)
            } else {
                phase = .streamError("rt reported failure without identifying a step")
            }
        case .unknown(let name):
            noteStreamIssue("unknown event: \(name)", gen: gen)
        case .plan, .step:
            break
        }
    }

    private func appendLog(_ line: String, to id: String) {
        var arr = logs[id] ?? []
        arr.append(line)
        if arr.count > Self.logCapPerStep { arr.removeFirst(arr.count - Self.logCapPerStep) }
        logs[id] = arr
    }

    private func noteStreamIssue(_ note: String, gen: Int) {
        guard generation == gen else { return }
        streamNotes.append(note)
        if streamNotes.count > Self.logCapPerStep { streamNotes.removeFirst(streamNotes.count - Self.logCapPerStep) }
    }

    /// RtClientError carries the operator-facing message in its payload;
    /// String(describing:) would print the raw Swift case instead.
    private static func describe(_ error: Error) -> String {
        if let e = error as? RtClientError {
            switch e {
            case .spawnFailed(let message): return message
            case .exited(let code, let stderr): return stderr.isEmpty ? "rt exited \(code)" : stderr
            }
        }
        if let e = error as? LocalizedError, let message = e.errorDescription { return message }
        return error.localizedDescription
    }

    /// Pure reducer, shared with the checks. A `plan` merges by id: existing
    /// rows keep their place and their state (the contract doesn't promise a
    /// truncated plan under --from, so a full re-sent plan must not revert
    /// finished rows to pending) but drop stale remedy/detail/waiting flags
    /// from the prior attempt; new ids append as pending.
    public static nonisolated func apply(_ event: ApplyEvent, to steps: inout [InstallStep]) {
        switch event {
        case .plan(let infos):
            for info in infos {
                if let i = steps.firstIndex(where: { $0.id == info.id }) {
                    steps[i].info = info
                    steps[i].remedy = nil
                    steps[i].detail = nil
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
