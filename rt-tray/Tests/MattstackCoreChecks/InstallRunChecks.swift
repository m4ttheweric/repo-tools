import Foundation
import MattstackCore

func lines(_ s: [String]) -> AsyncThrowingStream<String, Error> {
    AsyncThrowingStream { cont in for l in s { cont.yield(l) }; cont.finish() }
}
let planLine = #"{"event":"plan","steps":[{"id":"home.init","title":"Home repo","kind":"rt"},{"id":"services.register","title":"Register services","kind":"app"},{"id":"plugins.install","title":"Plugins","kind":"rt"}]}"#

let installRunChecks: [Check] = [
    Check("ApplyEvent decodes every contract event and tolerates unknown ones") { c in
        c.expectEqual(try ApplyEvent.decode(#"{"event":"step","id":"home.init","state":"running"}"#), .step(id: "home.init", state: .running, detail: nil, remedy: nil))
        c.expectEqual(try ApplyEvent.decode(#"{"event":"log","id":"home.init","line":"gh repo create"}"#), .log(id: "home.init", line: "gh repo create"))
        c.expectEqual(try ApplyEvent.decode(#"{"event":"need","id":"proxy.install","request":{"type":"app-privileged","op":"proxy-install"}}"#),
                      .need(id: "proxy.install", request: NeedRequest(type: "app-privileged", plists: nil, op: "proxy-install")))
        c.expectEqual(try ApplyEvent.decode(#"{"event":"done","ok":false,"failedStep":"plugins.install"}"#), .done(ok: false, failedStep: "plugins.install"))
        c.expectEqual(try ApplyEvent.decode(#"{"event":"spark","x":1}"#), .unknown("spark"))
        guard case .plan(let steps) = try ApplyEvent.decode(planLine) else { c.fail("plan"); return }
        try c.requireEqual(steps.count, 3)
        c.expectEqual(steps[1].kind, .app)
    },
    Check("reducer: plan seeds pending steps; step events update state/detail/remedy") { c in
        var steps: [InstallStep] = []
        InstallRunModel.apply(try ApplyEvent.decode(planLine), to: &steps)
        try c.requireEqual(steps.map(\.state), [.pending, .pending, .pending])
        InstallRunModel.apply(.step(id: "home.init", state: .running, detail: nil, remedy: nil), to: &steps)
        InstallRunModel.apply(.step(id: "home.init", state: .done, detail: "pushed main", remedy: nil), to: &steps)
        InstallRunModel.apply(.step(id: "plugins.install", state: .failed, detail: "exit 1", remedy: "Open Claude Code once, then Retry."), to: &steps)
        c.expectEqual(steps[0].state, .done); c.expectEqual(steps[0].detail, "pushed main")
        c.expectEqual(steps[2].state, .failed); c.expectEqual(steps[2].remedy, "Open Claude Code once, then Retry.")
        InstallRunModel.apply(.need(id: "services.register", request: NeedRequest(type: "app-register-services", plists: ["a"], op: nil)), to: &steps)
        c.expectEqual(steps[1].waitingOnYou, true)
    },
    Check("a full happy stream ends succeeded, need events are performed through the broker, logs are kept per step") { c in
        let services = FakeServices(), privileged = FakePrivileged()
        let broker = NeedBroker(services: services, privileged: privileged)
        let stream: ApplyStreamFactory = { _ in lines([
            planLine,
            #"{"event":"step","id":"home.init","state":"running"}"#,
            #"{"event":"log","id":"home.init","line":"gh repo create"}"#,
            #"{"event":"step","id":"home.init","state":"done","detail":"pushed main"}"#,
            #"{"event":"step","id":"services.register","state":"running"}"#,
            #"{"event":"need","id":"services.register","request":{"type":"app-register-services","plists":["com.mattstack.daemon.plist"]}}"#,
            #"{"event":"step","id":"services.register","state":"done"}"#,
            #"{"event":"step","id":"plugins.install","state":"running"}"#,
            #"{"event":"step","id":"plugins.install","state":"done"}"#,
            #"{"event":"done","ok":true,"failedStep":null}"#,
        ]) }
        let m = await MainActor.run { InstallRunModel(stream: stream, needs: broker) }
        await MainActor.run { m.start() }
        for _ in 0..<50 { if await MainActor.run(body: { m.phase == .succeeded }) { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        await MainActor.run {
            c.expectEqual(m.phase, .succeeded)
            c.expectEqual(m.logLines(for: "home.init"), ["gh repo create"])
            c.expectEqual(m.steps.map(\.state), [.done, .done, .done])
        }
        c.expectEqual(services.registered, [["com.mattstack.daemon.plist"]])
    },
    Check("a failed step stops the run with its remedy; retryFromFailure re-streams with --from and forgets the need") { c in
        final class Count: @unchecked Sendable { var froms: [String?] = [] }
        let count = Count()
        let broker = NeedBroker(services: FakeServices(), privileged: FakePrivileged())
        let stream: ApplyStreamFactory = { from in
            count.froms.append(from)
            if from == nil {
                return lines([planLine,
                              #"{"event":"step","id":"plugins.install","state":"failed","detail":"exit 1","remedy":"Open Claude Code once, then Retry."}"#,
                              #"{"event":"done","ok":false,"failedStep":"plugins.install"}"#])
            }
            return lines([#"{"event":"plan","steps":[{"id":"plugins.install","title":"Plugins","kind":"rt"}]}"#,
                          #"{"event":"step","id":"plugins.install","state":"done"}"#,
                          #"{"event":"done","ok":true,"failedStep":null}"#])
        }
        let m = await MainActor.run { InstallRunModel(stream: stream, needs: broker) }
        await MainActor.run { m.start() }
        for _ in 0..<50 { if await MainActor.run(body: { m.failedStepId != nil }) { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        await MainActor.run {
            c.expectEqual(m.phase, .failed(stepId: "plugins.install", remedy: "Open Claude Code once, then Retry."))
            m.retryFromFailure()
        }
        for _ in 0..<50 { if await MainActor.run(body: { m.phase == .succeeded }) { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        try await MainActor.run {
            c.expectEqual(m.phase, .succeeded)
            try c.requireEqual(m.steps.map(\.id), ["home.init", "services.register", "plugins.install"], "earlier steps keep their rows")
            c.expectEqual(m.steps[2].state, .done)
        }
        c.expectEqual(count.froms, [nil, "plugins.install"])
    },
    Check("a stream error surfaces as streamError") { c in
        let stream: ApplyStreamFactory = { _ in AsyncThrowingStream { $0.finish(throwing: RtClientError.exited(1, stderr: "boom")) } }
        let m = await MainActor.run { InstallRunModel(stream: stream, needs: NeedBroker(services: FakeServices(), privileged: FakePrivileged())) }
        await MainActor.run { m.start() }
        for _ in 0..<50 { if await MainActor.run(body: { if case .streamError = m.phase { return true }; return false }) { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        await MainActor.run { if case .streamError(let s) = m.phase { c.expect(s.contains("boom")) } else { c.fail("expected streamError, got \(m.phase)") } }
    },
    Check("unknown step kind/state values survive decode without discarding the event") { c in
        let weirdPlan = #"{"event":"plan","steps":[{"id":"a","title":"A","kind":"rt"},{"id":"b","title":"B","kind":"mystery"}]}"#
        guard case .plan(let steps) = try ApplyEvent.decode(weirdPlan) else {
            c.fail("expected the plan to survive an unknown step kind"); return
        }
        try c.requireEqual(steps.count, 2, "an unrecognized kind must not blank the rest of the plan")
        c.expectEqual(steps[0].kind, .rt)
        c.expectEqual(steps[1].kind, .unknown)
        c.expectEqual(try ApplyEvent.decode(#"{"event":"step","id":"a","state":"retrying"}"#), .step(id: "a", state: .unknown, detail: nil, remedy: nil))
    },
    Check("plan merge on a known id preserves state, clears remedy/detail/waitingOnYou; unknown ids append pending") { c in
        var steps: [InstallStep] = []
        InstallRunModel.apply(try ApplyEvent.decode(planLine), to: &steps)
        InstallRunModel.apply(.step(id: "home.init", state: .failed, detail: "exit 1", remedy: "fix it"), to: &steps)
        InstallRunModel.apply(.need(id: "services.register", request: NeedRequest(type: "app-register-services", plists: ["a"], op: nil)), to: &steps)
        InstallRunModel.apply(try ApplyEvent.decode(planLine), to: &steps)
        try c.requireEqual(steps.count, 3, "known ids merge in place, they don't duplicate")
        c.expectEqual(steps[0].state, .failed, "a re-sent plan must not revert a step's state")
        c.expectEqual(steps[0].detail, nil, "stale detail from the last attempt must not survive a re-plan")
        c.expectEqual(steps[0].remedy, nil)
        c.expectEqual(steps[1].waitingOnYou, false)
    },
    Check("done ok:false with no identifiable step never fabricates a step id") { c in
        var steps: [InstallStep] = []
        InstallRunModel.apply(try ApplyEvent.decode(planLine), to: &steps)
        let broker = NeedBroker(services: FakeServices(), privileged: FakePrivileged())
        let stream: ApplyStreamFactory = { _ in lines([planLine, #"{"event":"done","ok":false,"failedStep":null}"#]) }
        let m = await MainActor.run { InstallRunModel(stream: stream, needs: broker) }
        await MainActor.run { m.start() }
        for _ in 0..<50 {
            let settled = await MainActor.run { () -> Bool in
                if case .running = m.phase { return false }; return true
            }
            if settled { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        await MainActor.run {
            c.expectEqual(m.phase, .streamError("rt reported failure without identifying a step"))
            c.expectEqual(m.resumableStepId, nil, "a phase with no real failing step must not hand back a fabricated retry target")
        }
    },
    Check("resumableStepId resumes retry after a streamError, from the step that was running when it died") { c in
        final class Count: @unchecked Sendable { var froms: [String?] = [] }
        let count = Count()
        let broker = NeedBroker(services: FakeServices(), privileged: FakePrivileged())
        let stream: ApplyStreamFactory = { from in
            count.froms.append(from)
            if from == nil {
                return AsyncThrowingStream { cont in
                    cont.yield(planLine)
                    cont.yield(#"{"event":"step","id":"home.init","state":"done"}"#)
                    cont.yield(#"{"event":"step","id":"services.register","state":"running"}"#)
                    cont.finish(throwing: RtClientError.exited(1, stderr: "connection reset"))
                }
            }
            return lines([#"{"event":"plan","steps":[{"id":"services.register","title":"Register services","kind":"app"}]}"#,
                          #"{"event":"step","id":"services.register","state":"done"}"#,
                          #"{"event":"step","id":"plugins.install","state":"done"}"#,
                          #"{"event":"done","ok":true,"failedStep":null}"#])
        }
        let m = await MainActor.run { InstallRunModel(stream: stream, needs: broker) }
        await MainActor.run { m.start() }
        for _ in 0..<50 { if await MainActor.run(body: { if case .streamError = m.phase { return true }; return false }) { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        await MainActor.run {
            c.expectEqual(m.resumableStepId, "services.register")
            m.retryFromFailure()
        }
        for _ in 0..<50 { if await MainActor.run(body: { m.phase == .succeeded }) { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        await MainActor.run { c.expectEqual(m.phase, .succeeded) }
        c.expectEqual(count.froms, [nil, "services.register"])
    },
    Check("generation guard: a stale run's late stream event cannot overwrite a newer run's phase") { c in
        final class Gate: @unchecked Sendable { var first: AsyncThrowingStream<String, Error>.Continuation? }
        let gate = Gate()
        final class Calls: @unchecked Sendable { var n = 0 }
        let calls = Calls()
        let broker = NeedBroker(services: FakeServices(), privileged: FakePrivileged())
        let stream: ApplyStreamFactory = { _ in
            calls.n += 1
            if calls.n == 1 {
                return AsyncThrowingStream { cont in gate.first = cont; cont.yield(planLine) }
            }
            return lines([planLine,
                          #"{"event":"step","id":"home.init","state":"done"}"#,
                          #"{"event":"step","id":"services.register","state":"done"}"#,
                          #"{"event":"step","id":"plugins.install","state":"done"}"#,
                          #"{"event":"done","ok":true,"failedStep":null}"#])
        }
        let m = await MainActor.run { InstallRunModel(stream: stream, needs: broker) }
        await MainActor.run { m.start() }
        for _ in 0..<50 { if await MainActor.run(body: { !m.steps.isEmpty }) { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        await MainActor.run { m.start() }
        for _ in 0..<50 { if await MainActor.run(body: { m.phase == .succeeded }) { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        await MainActor.run { c.expectEqual(m.phase, .succeeded) }
        gate.first?.yield(#"{"event":"done","ok":false,"failedStep":"plugins.install"}"#)
        gate.first?.finish()
        try await Task.sleep(nanoseconds: 100_000_000)
        await MainActor.run { c.expectEqual(m.phase, .succeeded, "the superseded run's late event must not clobber the live run's phase") }
    },
    Check("a stream that throws after already sending done:false keeps the failed phase, not streamError") { c in
        let broker = NeedBroker(services: FakeServices(), privileged: FakePrivileged())
        let stream: ApplyStreamFactory = { _ in
            AsyncThrowingStream { cont in
                cont.yield(planLine)
                cont.yield(#"{"event":"step","id":"plugins.install","state":"failed","detail":"exit 1","remedy":"Open Claude Code once, then Retry."}"#)
                cont.yield(#"{"event":"done","ok":false,"failedStep":"plugins.install"}"#)
                cont.finish(throwing: RtClientError.exited(1, stderr: "process group cleanup raced the final line"))
            }
        }
        let m = await MainActor.run { InstallRunModel(stream: stream, needs: broker) }
        await MainActor.run { m.start() }
        for _ in 0..<50 { if await MainActor.run(body: { m.failedStepId != nil }) { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        try await Task.sleep(nanoseconds: 100_000_000)
        await MainActor.run {
            c.expectEqual(m.phase, .failed(stepId: "plugins.install", remedy: "Open Claude Code once, then Retry."), "a late throw after done:false must not overwrite the failed phase it already reported")
            c.expectEqual(m.resumableStepId, "plugins.install")
        }
    },
    Check("dropping the last reference mid-run lets the model deinit and cancels its task") { c in
        final class TerminationFlag: @unchecked Sendable { var cancelled = false }
        let flag = TerminationFlag()
        let stream: ApplyStreamFactory = { _ in
            AsyncThrowingStream { cont in
                cont.onTermination = { _ in flag.cancelled = true }
                cont.yield(planLine)
                // deliberately never finishes — mirrors a long-lived rt process stream
            }
        }
        final class Holder: @unchecked Sendable { var model: InstallRunModel? }
        let holder = Holder()
        let broker = NeedBroker(services: FakeServices(), privileged: FakePrivileged())
        holder.model = await MainActor.run { InstallRunModel(stream: stream, needs: broker) }
        weak var weakModel = holder.model
        await MainActor.run { holder.model?.start() }
        for _ in 0..<50 { if await MainActor.run(body: { !(holder.model?.steps.isEmpty ?? true) }) { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        holder.model = nil
        for _ in 0..<50 { if weakModel == nil { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        c.expect(weakModel == nil, "the model must be free to deinit while its run task is suspended between stream lines, not held strong for the run's whole lifetime")
        for _ in 0..<50 { if flag.cancelled { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        c.expect(flag.cancelled, "deinit must cancel the in-flight task so the stream tears down")
    },
    Check("generation guard: a stale need result cannot mutate a newer run's steps") { c in
        final class Calls: @unchecked Sendable { var n = 0 }
        let calls = Calls()
        let slowServices = FakeServices()
        slowServices.registerDelayNs = 150_000_000
        let broker = NeedBroker(services: slowServices, privileged: FakePrivileged())
        let stream: ApplyStreamFactory = { _ in
            calls.n += 1
            if calls.n == 1 {
                return lines([planLine,
                              #"{"event":"step","id":"home.init","state":"running"}"#,
                              #"{"event":"need","id":"home.init","request":{"type":"app-register-services","plists":["stale.plist"]}}"#])
            }
            return lines([planLine,
                          #"{"event":"step","id":"home.init","state":"done"}"#,
                          #"{"event":"step","id":"services.register","state":"done"}"#,
                          #"{"event":"step","id":"plugins.install","state":"done"}"#,
                          #"{"event":"done","ok":true,"failedStep":null}"#])
        }
        let m = await MainActor.run { InstallRunModel(stream: stream, needs: broker) }
        await MainActor.run { m.start() }
        for _ in 0..<50 { if await MainActor.run(body: { !m.steps.isEmpty }) { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        await MainActor.run { m.start() }
        for _ in 0..<50 { if await MainActor.run(body: { m.phase == .succeeded }) { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        await MainActor.run { c.expectEqual(m.phase, .succeeded) }
        try await Task.sleep(nanoseconds: 250_000_000)
        await MainActor.run {
            c.expectEqual(m.phase, .succeeded, "a stale needs.perform() resolving late must not reopen the finished run")
            c.expectEqual(m.steps.map(\.state), [.done, .done, .done])
        }
    },
]
