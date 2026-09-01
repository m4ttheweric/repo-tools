import Foundation
import MattstackCore

private let epoch = Date(timeIntervalSince1970: 1_700_000_000)
private let acme = ReadyHeldRepo(repo: "gitlab.com/acme/acme-dev", hash: "aaa")
private let acmeEdited = ReadyHeldRepo(repo: "gitlab.com/acme/acme-dev", hash: "bbb")

let readyHeldChecks: [Check] = [
    Check("a newly held ladder notifies once and is recorded") { c in
        let out = ReadyHeldNotifier.decide(held: [acme], ledger: [:], now: epoch)
        c.expectEqual(out.notify, [acme])
        c.expectEqual(out.ledger.count, 1)
    },
    Check("the same held ladder does not notify again inside the re-nag window") { c in
        let first = ReadyHeldNotifier.decide(held: [acme], ledger: [:], now: epoch)
        let second = ReadyHeldNotifier.decide(held: [acme], ledger: first.ledger,
                                              now: epoch.addingTimeInterval(6 * 60 * 60))
        c.expectEqual(second.notify, [])
        c.expectEqual(second.ledger, first.ledger)
    },
    Check("a held ladder notifies again once the re-nag window elapses, and re-stamps") { c in
        let first = ReadyHeldNotifier.decide(held: [acme], ledger: [:], now: epoch)
        let later = epoch.addingTimeInterval(ReadyHeldNotifier.reNagInterval + 1)
        let second = ReadyHeldNotifier.decide(held: [acme], ledger: first.ledger, now: later)
        c.expectEqual(second.notify, [acme])
        c.expect(second.ledger != first.ledger, "the ledger must re-stamp so the next window starts now")
    },
    Check("a team edit to the ladder re-arms immediately: a new hash is a new notification") { c in
        let first = ReadyHeldNotifier.decide(held: [acme], ledger: [:], now: epoch)
        let second = ReadyHeldNotifier.decide(held: [acmeEdited], ledger: first.ledger,
                                              now: epoch.addingTimeInterval(60))
        c.expectEqual(second.notify, [acmeEdited])
    },
    Check("approving clears the ledger entry, so a later re-hold notifies immediately") { c in
        let first = ReadyHeldNotifier.decide(held: [acme], ledger: [:], now: epoch)
        let cleared = ReadyHeldNotifier.decide(held: [], ledger: first.ledger,
                                               now: epoch.addingTimeInterval(60))
        c.expectEqual(cleared.notify, [])
        c.expectEqual(cleared.ledger, [:])

        let reheld = ReadyHeldNotifier.decide(held: [acme], ledger: cleared.ledger,
                                              now: epoch.addingTimeInterval(120))
        c.expectEqual(reheld.notify, [acme])
    },
    Check("nothing held means nothing to notify and an empty ledger") { c in
        let out = ReadyHeldNotifier.decide(held: [], ledger: [:], now: epoch)
        c.expectEqual(out.notify, [])
        c.expectEqual(out.ledger, [:])
    },
]
