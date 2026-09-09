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

        let results = await withTaskGroup(of: Bool.self, returning: [Bool].self) { group in
            for _ in 0..<8 {
                group.addTask {
                    await gate.run(.start) {
                        await rec.enter("start")
                        await yieldTwice()
                        await rec.leave()
                        return true
                    }
                }
            }
            var out: [Bool] = []
            for await r in group { out.append(r) }
            return out
        }

        c.expectEqual(await rec.invocations, 1, "26 watchers finding the socket down must cost one register+kickstart")
        c.expectEqual(results.count, 8)
        c.expect(results.allSatisfy { $0 }, "every joined caller gets the in-flight start's result")
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
