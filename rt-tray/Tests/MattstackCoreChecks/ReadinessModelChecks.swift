import Foundation
import MattstackCore

final class FakePlans: PlanSource, @unchecked Sendable {
    var plans: [Plan]
    private(set) var fetches = 0
    init(_ plans: [Plan]) { self.plans = plans }
    func fetchPlan() async throws -> Plan {
        fetches += 1
        return plans.count > 1 ? plans.removeFirst() : plans[0]
    }
}
final class FakePermissions: PermissionProbing, @unchecked Sendable {
    var snapshot = PermissionSnapshot.unknown
    private(set) var probes = 0
    func snapshot() async -> PermissionSnapshot { probes += 1; return snapshot }
}
final class FakeTicker: TickerScheduling, @unchecked Sendable {
    var ticks: [@Sendable () -> Void] = []
    var cancelled = 0
    func schedule(every seconds: TimeInterval, _ tick: @escaping @Sendable () -> Void) -> TickerHandle {
        ticks.append(tick)
        return TickerHandle { [self] in cancelled += 1 }
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
        try await Task.sleep(nanoseconds: 100_000_000)
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
    Check("didBecomeActive refetches the plan; afterAction marks the row checking then refetches") { c in
        let plans = FakePlans([makePlan(), makePlan(gitlab: .ready), makePlan(gitlab: .ready)])
        let m = await MainActor.run { ReadinessModel(plans: plans, permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await MainActor.run { m.didBecomeActive() }
        try await Task.sleep(nanoseconds: 100_000_000)
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
