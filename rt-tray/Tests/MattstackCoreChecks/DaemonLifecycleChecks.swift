import Foundation
import MattstackCore

/// Records what a gated body did, so a check can assert on invocation counts
/// and on whether two bodies were ever in flight at once.
private actor BodyRecorder {
    private(set) var invocations = 0
    private(set) var maxConcurrent = 0
    private(set) var order: [String] = []
    private var active = 0

    func enter(_ tag: String) {
        invocations += 1
        active += 1
        maxConcurrent = max(maxConcurrent, active)
        order.append(tag)
    }

    func leave() { active -= 1 }
}

/// Suspends the body at least once so the actor has a real chance to let
/// another call in — a body that never awaits could pass a serialization
/// check for the wrong reason.
private func yieldTwice() async {
    await Task.yield()
    await Task.yield()
}

/// Holds a body open until the check decides the scenario is fully assembled,
/// so concurrency assertions don't depend on scheduler timing.
private actor Latch {
    private var conts: [CheckedContinuation<Void, Never>] = []
    private var isOpen = false
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { conts.append($0) }
    }
    func open() {
        isOpen = true
        for c in conts { c.resume() }
        conts = []
    }
}

/// Yields until `condition` holds; fails the check instead of hanging when it
/// never does.
private func spinUntil(_ c: CheckContext, _ what: String, _ condition: () async -> Bool) async {
    for _ in 0..<200_000 where !(await condition()) {
        await Task.yield()
    }
    if !(await condition()) { c.fail("timed out waiting for \(what)") }
}

let daemonLifecycleChecks: [Check] = [
    Check("DaemonOrigin names the socket client, and says so when there isn't one") { c in
        c.expectEqual(DaemonOrigin.http(clientHeader: "rt-cli/54625"), "socket rt-cli/54625")
        c.expectEqual(DaemonOrigin.http(clientHeader: "  rt-client/20469 "), "socket rt-client/20469")
        c.expectEqual(DaemonOrigin.http(clientHeader: nil), "socket (unidentified client)")
        c.expectEqual(DaemonOrigin.http(clientHeader: "   "), "socket (unidentified client)")
        c.expectEqual(DaemonOrigin.menu, "gear menu")
    },

    Check("DaemonOrigin.header reads X-RT-Client out of a raw request, case-insensitively") { c in
        let req = "POST /daemon/restart HTTP/1.1\r\nHost: localhost\r\nX-RT-Client: rt-cli/54625\r\n\r\n"
        c.expectEqual(DaemonOrigin.header("X-RT-Client", in: req), "rt-cli/54625")
        c.expectEqual(DaemonOrigin.header("x-rt-client", in: req), "rt-cli/54625")
        c.expectEqual(DaemonOrigin.header("Content-Type", in: req), nil)

        // The request line is never a header, even when it contains a colon.
        let noHeaders = "GET /health HTTP/1.1\r\n\r\n"
        c.expectEqual(DaemonOrigin.header("GET /health HTTP/1.1", in: noHeaders), nil)

        // A value that is present but empty is absent, not "".
        let empty = "POST /daemon/start HTTP/1.1\r\nX-RT-Client:\r\n\r\n"
        c.expectEqual(DaemonOrigin.header("X-RT-Client", in: empty), nil)

        // A body containing a header-shaped line must not be mistaken for one.
        let withBody = "POST /daemon/start HTTP/1.1\r\nX-RT-Client: rt-cli/1\r\n\r\nX-RT-Client: spoofed\r\n"
        c.expectEqual(DaemonOrigin.header("X-RT-Client", in: withBody), "rt-cli/1")

        // The value lands in every lifecycle log line; a client stuffing the
        // header can't inflate the log past the cap.
        let huge = "POST /x HTTP/1.1\r\nX-RT-Client: " + String(repeating: "a", count: 5_000) + "\r\n\r\n"
        c.expectEqual(DaemonOrigin.header("X-RT-Client", in: huge)?.count, 128)
    },

    Check("DaemonLifecycleGate never lets two lifecycle ops overlap") { c in
        let gate = DaemonLifecycleGate()
        let rec = BodyRecorder()

        await withTaskGroup(of: Void.self) { group in
            for op in [DaemonLifecycleOp.restart, .stop, .restart, .stop] {
                group.addTask {
                    _ = await gate.run(op) {
                        await rec.enter(op.rawValue)
                        await yieldTwice()
                        await rec.leave()
                        return true
                    }
                }
            }
        }

        c.expectEqual(await rec.maxConcurrent, 1, "an unregister must never land inside another op's register+kickstart")
        c.expectEqual(await rec.invocations, 4, "non-start ops all run; only starts coalesce")
    },

    Check("DaemonLifecycleGate collapses a herd of concurrent starts into one") { c in
        let gate = DaemonLifecycleGate()
        let rec = BodyRecorder()
        let latch = Latch()

        // The leading start's body is held open until every joiner has
        // demonstrably parked on the gate — without that, a joiner the
        // scheduler starts late could arrive after startPending cleared and
        // run a second body, and the ==1 assertion would flake under load.
        let results = await withTaskGroup(of: Bool.self, returning: [Bool].self) { group in
            group.addTask {
                await gate.run(.start) {
                    await rec.enter("start")
                    await latch.wait()
                    await rec.leave()
                    return true
                }
            }
            await spinUntil(c, "the leading start to enter its body") { await rec.invocations == 1 }
            for _ in 0..<7 {
                group.addTask {
                    await gate.run(.start) {
                        await rec.enter("start")
                        await rec.leave()
                        return true
                    }
                }
            }
            await spinUntil(c, "all 7 joiners to park") { await gate.startJoinerCount == 7 }
            await latch.open()
            var out: [Bool] = []
            for await r in group { out.append(r) }
            return out
        }

        c.expectEqual(await rec.invocations, 1, "26 watchers finding the socket down must cost one register+kickstart")
        c.expectEqual(results.count, 8)
        c.expect(results.allSatisfy { $0 }, "every joined caller gets the in-flight start's result")
    },

    Check("DaemonLifecycleGate.retire waits for the running op; ops behind it never run their bodies") { c in
        let gate = DaemonLifecycleGate()
        let rec = BodyRecorder()
        let latch = Latch()

        // Op 1: a restart held mid-body — the in-flight work teardown must
        // wait for.
        let op1 = Task {
            await gate.run(.restart) {
                await rec.enter("restart")
                await latch.wait()
                await rec.leave()
                return true
            }
        }
        await spinUntil(c, "the restart to enter its body") { await rec.invocations == 1 }

        // Teardown arrives while the restart is in flight and parks.
        let retire = Task {
            await gate.retire {
                await rec.enter("retire")
                await rec.leave()
                return true
            }
        }
        await spinUntil(c, "retire to park behind the running op") { await gate.waiterCount == 1 }

        await latch.open()
        _ = await op1.value
        let retired = await retire.value
        c.expect(retired, "the teardown unregister itself ran")
        c.expectEqual(await rec.order, ["restart", "retire"], "retire runs after the op it waited for")
        c.expectEqual(await rec.maxConcurrent, 1)

        // The 2026-09-09 shape in reverse: the client herd's start arriving
        // after teardown must not re-register the agent the app just gave up.
        let started = await gate.run(.start) {
            await rec.enter("post-retire start")
            await rec.leave()
            return true
        }
        c.expectEqual(started, false, "a start after retire reports failure, not a phantom success")
        c.expectEqual(await rec.invocations, 2, "the post-retire start body never ran")
    },

    Check("DaemonLifecycleGate: an op parked when retire latches is skipped, and its joiners get false") { c in
        let gate = DaemonLifecycleGate()
        let rec = BodyRecorder()
        let latch = Latch()

        let op1 = Task {
            await gate.run(.restart) {
                await rec.enter("restart")
                await latch.wait()
                await rec.leave()
                return true
            }
        }
        await spinUntil(c, "the restart to enter its body") { await rec.invocations == 1 }

        // Queue order matters: retire parks first, then a start leader parks
        // behind it, then a second start joins the leader.
        let retire = Task { await gate.retire { true } }
        await spinUntil(c, "retire to park") { await gate.waiterCount == 1 }
        let leader = Task {
            await gate.run(.start) {
                await rec.enter("parked start")
                await rec.leave()
                return true
            }
        }
        await spinUntil(c, "the start leader to park") { await gate.waiterCount == 2 }
        let joiner = Task {
            await gate.run(.start) {
                await rec.enter("joined start")
                await rec.leave()
                return true
            }
        }
        await spinUntil(c, "the second start to join") { await gate.startJoinerCount == 1 }

        await latch.open()
        _ = await op1.value
        _ = await retire.value
        c.expectEqual(await leader.value, false, "a start parked behind retire is skipped")
        c.expectEqual(await joiner.value, false, "its joiner gets the same false, not a hang")
        c.expectEqual(await rec.invocations, 1, "no start body ran after the latch")
    },

    Check("DaemonLifecycleGate reports the real start result to joiners, failures included") { c in
        let gate = DaemonLifecycleGate()

        let results = await withTaskGroup(of: Bool.self, returning: [Bool].self) { group in
            for _ in 0..<4 {
                group.addTask {
                    await gate.run(.start) {
                        await yieldTwice()
                        return false
                    }
                }
            }
            var out: [Bool] = []
            for await r in group { out.append(r) }
            return out
        }

        c.expectEqual(results.count, 4)
        c.expect(results.allSatisfy { $0 == false }, "a joiner must not read a failed start as a success")
    },

    Check("DaemonLifecycleGate frees the slot after a start, so a later start really runs") { c in
        let gate = DaemonLifecycleGate()
        let rec = BodyRecorder()

        _ = await gate.run(.start) { await rec.enter("first"); await rec.leave(); return true }
        _ = await gate.run(.start) { await rec.enter("second"); await rec.leave(); return true }

        c.expectEqual(await rec.invocations, 2, "coalescing is per in-flight start, not a one-shot latch")
        c.expectEqual(await rec.order, ["first", "second"])
    },
]
