import Foundation
import MattstackCore

struct FakePlansExhausted: Error {}

/// The model fetches from the visible ticker's task and from user actions, so
/// two fetchPlan calls can overlap; the lock keeps the queue and the counter
/// consistent, and an exhausted queue reports an error the model can record
/// rather than trapping the whole check process.
final class FakePlans: PlanSource, @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [Plan]
    private var fetchCount = 0
    var fetches: Int { lock.lock(); defer { lock.unlock() }; return fetchCount }
    init(_ plans: [Plan]) { self.queue = plans }
    func fetchPlan() async throws -> Plan { try take() }
    /// Synchronous so the lock is never held across an async boundary.
    private func take() throws -> Plan {
        lock.lock(); defer { lock.unlock() }
        fetchCount += 1
        guard let next = queue.first else { throw FakePlansExhausted() }
        if queue.count > 1 { queue.removeFirst() }
        return next
    }
}
/// Checks set `snapshot` from the check's task while the visible ticker's own
/// task is calling `snapshot()`, so every field goes through the lock.
final class FakePermissions: PermissionProbing, @unchecked Sendable {
    private let lock = NSLock()
    private var stored = PermissionSnapshot.unknown
    private var relaunch = false
    private var probeCount = 0
    var snapshot: PermissionSnapshot {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
    var fdaNeedsRelaunch: Bool {
        get { lock.lock(); defer { lock.unlock() }; return relaunch }
        set { lock.lock(); relaunch = newValue; lock.unlock() }
    }
    var probes: Int { lock.lock(); defer { lock.unlock() }; return probeCount }
    func snapshot() async -> PermissionSnapshot { probe() }
    /// Synchronous so the lock is never held across an async boundary.
    private func probe() -> PermissionSnapshot {
        lock.lock(); defer { lock.unlock() }
        probeCount += 1
        return stored
    }
}
final class FakeTicker: TickerScheduling, @unchecked Sendable {
    private let lock = NSLock()
    private var scheduled: [@Sendable () -> Void] = []
    private var cancelCount = 0
    var ticks: [@Sendable () -> Void] { lock.lock(); defer { lock.unlock() }; return scheduled }
    var cancelled: Int { lock.lock(); defer { lock.unlock() }; return cancelCount }
    func schedule(every seconds: TimeInterval, _ tick: @escaping @Sendable () -> Void) -> TickerHandle {
        lock.lock(); scheduled.append(tick); lock.unlock()
        return TickerHandle { [self] in lock.lock(); cancelCount += 1; lock.unlock() }
    }
    func fire() { ticks.forEach { $0() } }
}

func makePlan(fda: RowStatus = .needsYou, gitlab: RowStatus = .missing, chrome: RowStatus = .skipped,
              notifications: RowStatus = .skipped, canInstallOverride: Bool? = nil) -> Plan {
    let rows1 = [
        PlanRow(id: "perm.fda", kind: .permission, title: "Full Disk Access", why: "w", required: true, status: fda,
                action: RowAction(type: .openSettings, label: "Open Full Disk Access Settings…", target: "fda"), recheck: .onActivate),
        PlanRow(id: "perm.notifications", kind: .permission, title: "Notifications", why: "w", required: false,
                optionalNote: "Works without this.", status: notifications, recheck: .onActivate),
    ]
    let rows2 = [
        PlanRow(id: "account.gitlab", kind: .account, title: "GitLab", why: "w", required: true, status: gitlab,
                action: RowAction(type: .connect, label: "Connect", integration: "gitlab"), recheck: .onChange),
        PlanRow(id: "tool.chrome", kind: .tool, title: "Chrome", why: "w", required: false, optionalNote: "Works without this.",
                status: chrome, recheck: .manual),
    ]
    let missing = (rows1 + rows2).filter { $0.required && $0.status != .ready }.map(\.id)
    return Plan(at: "t", team: TeamInfo(slug: "acme", name: "Acme", mode: .join),
                groups: [PlanGroup(id: "mac", title: "Your Mac", rows: rows1), PlanGroup(id: "accounts", title: "Accounts", rows: rows2)],
                canInstall: canInstallOverride ?? missing.isEmpty, requiredMissing: missing)
}

let readinessModelChecks: [Check] = [
    Check("load renders groups and enablement from the plan") { c in
        let plans = FakePlans([makePlan()])
        let m = await MainActor.run { ReadinessModel(plans: plans, permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await MainActor.run {
            c.expectEqual(m.groups.count, 2)
            c.expectEqual(m.team?.mode, .join)
            c.expectEqual(m.canInstall, false)
            c.expectEqual(m.requiredMissing, ["perm.fda", "account.gitlab"])
            c.expectEqual(m.limitedModeAvailable, false)
        }
    },
    Check("limited mode only when every required row is ready and some optional row is not, including a non-ready optional permission") { c in
        let plans = FakePlans([makePlan(fda: .ready, gitlab: .ready, chrome: .ready, notifications: .skipped)])
        let m = await MainActor.run { ReadinessModel(plans: plans, permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await MainActor.run {
            c.expectEqual(m.canInstall, true)
            c.expectEqual(m.limitedModeAvailable, true, "notifications is optional, permission-kind, and not ready → still limited")
        }
        let plans2 = FakePlans([makePlan(fda: .ready, gitlab: .ready, chrome: .ready, notifications: .ready)])
        let m2 = await MainActor.run { ReadinessModel(plans: plans2, permissions: FakePermissions(), ticker: FakeTicker()) }
        await m2.load()
        await MainActor.run { c.expectEqual(m2.limitedModeAvailable, false, "every row ready → not limited") }
    },
    Check("visible → 1s ticker probes permissions and overlays permission rows; hidden cancels") { c in
        let plans = FakePlans([makePlan()])
        let perms = FakePermissions()
        let ticker = FakeTicker()
        let m = await MainActor.run { ReadinessModel(plans: plans, permissions: perms, ticker: ticker) }
        await m.load()
        await MainActor.run { m.becameVisible() }
        c.expectEqual(ticker.ticks.count, 1)
        perms.snapshot = PermissionSnapshot(fda: .init(status: "granted", detail: "probe read ~/Library/Containers/com.apple.stocks"),
                                            notifications: .init(status: "authorized"),
                                            loginItems: .init(status: "requiresApproval"))
        ticker.fire()
        for _ in 0..<100 {
            if await MainActor.run(body: { m.row("perm.fda")?.status == .ready }) { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        await MainActor.run {
            c.expectEqual(m.row("perm.fda")?.status, .ready)
            c.expectEqual(m.row("perm.fda")?.detail, "probe read ~/Library/Containers/com.apple.stocks")
            c.expectEqual(m.row("perm.notifications")?.status, .ready)
            c.expectEqual(m.requiredMissing, ["account.gitlab"], "overlay recomputes enablement")
            m.becameHidden()
        }
        c.expectEqual(ticker.cancelled, 1)
        c.expectEqual(plans.fetches, 1, "the 1s ticker never spawns rt; it probes locally")
    },
    Check("becameVisible/becameHidden are depth-counted: two visible callers, one hiding leaves the tick running; both hiding cancels it") { c in
        let ticker = FakeTicker()
        let m = await MainActor.run { ReadinessModel(plans: FakePlans([makePlan()]), permissions: FakePermissions(), ticker: ticker) }
        await MainActor.run {
            m.becameVisible()   // Setup checklist
            m.becameVisible()   // Settings > Permissions
        }
        c.expectEqual(ticker.ticks.count, 1, "one caller's visibility must not spawn a second ticker")
        await MainActor.run { m.becameHidden() }   // Settings closes
        c.expectEqual(ticker.cancelled, 0, "the checklist is still visible; its tick must survive")
        await MainActor.run { m.becameHidden() }   // Setup closes
        c.expectEqual(ticker.cancelled, 1, "the last visible caller hiding cancels the tick")
        await MainActor.run { m.becameHidden() }   // stray extra call
        c.expectEqual(ticker.cancelled, 1, "depth clamps at 0 — an extra becameHidden() must not cancel again")
    },
    Check("didBecomeActive refetches the plan; afterAction marks the row checking then refetches") { c in
        let plans = FakePlans([makePlan(), makePlan(gitlab: .ready), makePlan(gitlab: .ready)])
        let m = await MainActor.run { ReadinessModel(plans: plans, permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await MainActor.run { m.didBecomeActive() }
        // didBecomeActive's work happens on a detached task; wait for the row
        // the second plan changes, which lands after that task has applied it.
        for _ in 0..<100 {
            if await MainActor.run(body: { m.row("account.gitlab")?.status == .ready }) { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        c.expectEqual(plans.fetches, 2)
        await m.afterAction(rowId: "account.gitlab")
        await MainActor.run {
            c.expectEqual(m.row("account.gitlab")?.status, .ready)
            c.expect(m.checkingRowIds.isEmpty)
        }
        c.expectEqual(plans.fetches, 3)
    },
    Check("a failing plan fetch keeps the last rows and records the error") { c in
        final class Boom: PlanSource, @unchecked Sendable {
            var n = 0
            func fetchPlan() async throws -> Plan { n += 1; if n == 1 { return makePlan() }; throw RtClientError.exited(1, stderr: "boom") }
        }
        let m = await MainActor.run { ReadinessModel(plans: Boom(), permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await m.recheckAll()
        await MainActor.run {
            c.expectEqual(m.groups.count, 2)
            c.expect(m.lastError?.contains("boom") == true)
        }
    },
    Check("recheckAll and afterAction probe permissions locally before refetching the plan") { c in
        let plans = FakePlans([makePlan(gitlab: .missing), makePlan(gitlab: .ready)])
        let perms = FakePermissions()
        let m = await MainActor.run { ReadinessModel(plans: plans, permissions: perms, ticker: FakeTicker()) }
        await m.load()
        c.expectEqual(perms.probes, 0, "load doesn't probe")
        await m.recheckAll()
        c.expectEqual(perms.probes, 1, "recheckAll probes permissions before fetching, mirroring didBecomeActive")
        c.expectEqual(plans.fetches, 2)

        let plans2 = FakePlans([makePlan(), makePlan(gitlab: .ready)])
        let perms2 = FakePermissions()
        let m2 = await MainActor.run { ReadinessModel(plans: plans2, permissions: perms2, ticker: FakeTicker()) }
        await m2.load()
        await m2.afterAction(rowId: "account.gitlab")
        c.expectEqual(perms2.probes, 1, "afterAction probes permissions before fetching")
    },
    Check("canInstall respects rt's own plan.canInstall gate even when every row looks ready") { c in
        let plans = FakePlans([makePlan(fda: .ready, gitlab: .ready, chrome: .ready, notifications: .ready, canInstallOverride: false)])
        let m = await MainActor.run { ReadinessModel(plans: plans, permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await MainActor.run {
            c.expectEqual(m.requiredMissing, [], "no row is actually missing")
            c.expectEqual(m.canInstall, false, "rt gated canInstall on something not expressed as a row")
        }
    },
    Check("PermissionRowOverlay maps contract statuses to row statuses") { c in
        let s = PermissionSnapshot(fda: .init(status: "denied", detail: "EPERM"), notifications: .init(status: "denied"),
                                   loginItems: .init(status: "notRegistered"))
        c.expectEqual(PermissionRowOverlay.status(for: "perm.fda", in: s)?.0, .needsYou)
        c.expectEqual(PermissionRowOverlay.status(for: "perm.notifications", in: s)?.0, .needsYou)
        c.expectEqual(PermissionRowOverlay.status(for: "perm.login-items", in: s)?.0, .missing)
        let u = PermissionSnapshot.unknown
        c.expectEqual(PermissionRowOverlay.status(for: "perm.fda", in: u)?.0, .checking)
        c.expect(PermissionRowOverlay.status(for: "tool.clt", in: s) == nil)
        let ok = PermissionSnapshot(fda: .init(status: "granted", detail: ""), notifications: .init(status: "provisional"),
                                    loginItems: .init(status: "enabled"))
        c.expectEqual(PermissionRowOverlay.status(for: "perm.login-items", in: ok)?.0, .ready)
        c.expectEqual(PermissionRowOverlay.status(for: "perm.notifications", in: ok)?.0, .ready)
        let approval = PermissionSnapshot(fda: .init(status: "granted", detail: ""), notifications: .init(status: "notDetermined"),
                                          loginItems: .init(status: "requiresApproval"))
        c.expectEqual(PermissionRowOverlay.status(for: "perm.login-items", in: approval)?.0, .needsYou)
        c.expectEqual(PermissionRowOverlay.status(for: "perm.notifications", in: approval)?.0, .skipped)
    },
    Check("beginChecking/endChecking mark a row busy independent of afterAction's own insert/remove") { c in
        let plans = FakePlans([makePlan()])
        let m = await MainActor.run { ReadinessModel(plans: plans, permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await MainActor.run {
            m.beginChecking("account.gitlab")
            c.expect(m.checkingRowIds.contains("account.gitlab"), "checking starts before the verb runs, not after it returns")
            m.endChecking("account.gitlab")
            c.expect(!m.checkingRowIds.contains("account.gitlab"))
        }
    },
    Check("probePermissions mirrors the probe's fdaNeedsRelaunch into published state") { c in
        let perms = FakePermissions()
        let m = await MainActor.run { ReadinessModel(plans: FakePlans([makePlan()]), permissions: perms, ticker: FakeTicker()) }
        await MainActor.run { c.expectEqual(m.fdaNeedsRelaunch, false) }
        perms.fdaNeedsRelaunch = true
        await m.recheckAll()
        await MainActor.run { c.expectEqual(m.fdaNeedsRelaunch, true, "the model republishes the probe's own signal so the view can observe it") }
    },
    Check("StatusGlyph follows the spec's symbols") { c in
        c.expectEqual(StatusGlyph.symbol(for: .ready), "checkmark.circle.fill")
        c.expectEqual(StatusGlyph.symbol(for: .error), "xmark.circle")
        c.expectEqual(StatusGlyph.symbol(for: .invalid), "xmark.circle")
        c.expectEqual(StatusGlyph.symbol(for: .needsYou), "exclamationmark.triangle")
        c.expectEqual(StatusGlyph.symbol(for: .missing), "exclamationmark.triangle")
        c.expectEqual(StatusGlyph.symbol(for: .skipped), "circle.dotted")
        c.expectEqual(StatusGlyph.symbol(for: .checking), "progress")
        c.expectEqual(StatusGlyph.tint(for: .ready), .green)
        c.expectEqual(StatusGlyph.tint(for: .needsYou), .yellow)
    },
]
