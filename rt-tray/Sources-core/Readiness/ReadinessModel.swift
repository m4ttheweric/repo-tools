import Foundation
import Combine

public protocol PlanSource: Sendable { func fetchPlan() async throws -> Plan }
public protocol PermissionProbing: Sendable {
    func snapshot() async -> PermissionSnapshot
    var fdaNeedsRelaunch: Bool { get }
}

public final class TickerHandle: Sendable {
    public let cancel: @Sendable () -> Void
    public init(_ cancel: @escaping @Sendable () -> Void) { self.cancel = cancel }
}
public protocol TickerScheduling: Sendable {
    func schedule(every seconds: TimeInterval, _ tick: @escaping @Sendable () -> Void) -> TickerHandle
}

/// The checklist's view state. Rows come only from rt; the three permission
/// rows are overlaid from the app's own probe (the same probe rt folds in
/// via GET /permissions), so the 1 s visible-timer never spawns rt.
@MainActor
public final class ReadinessModel: ObservableObject {
    @Published public private(set) var groups: [PlanGroup] = []
    @Published public private(set) var team: TeamInfo?
    @Published public private(set) var canInstall = false
    @Published public private(set) var requiredMissing: [String] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var lastError: String?
    @Published public private(set) var checkingRowIds: Set<String> = []
    @Published public private(set) var fdaNeedsRelaunch = false
    /// The last local probe — Settings > Permissions reads this instead of
    /// running its own second poll of the same three rows.
    @Published public private(set) var permissionSnapshot = PermissionSnapshot.unknown

    public static let permissionTickSeconds: TimeInterval = 1

    private let plans: PlanSource
    private let permissions: PermissionProbing
    private let ticker: TickerScheduling
    private var tick: TickerHandle?
    private var hasProbedPermissions = false
    private var planCanInstall = false
    /// Setup and Settings can both be visible at once and both call
    /// became{Visible,Hidden} on this shared model; a depth count means
    /// either one hiding while the other is still up leaves the tick running.
    private var visibilityDepth = 0

    public init(plans: PlanSource, permissions: PermissionProbing, ticker: TickerScheduling) {
        self.plans = plans; self.permissions = permissions; self.ticker = ticker
    }

    public var allRows: [PlanRow] { groups.flatMap(\.rows) }
    public func row(_ id: String) -> PlanRow? { allRows.first { $0.id == id } }

    /// Every required row ready, at least one optional row (permission or
    /// otherwise) not ready — a denied optional permission counts.
    public var limitedModeAvailable: Bool {
        canInstall && allRows.contains { !$0.required && $0.status != .ready }
    }

    /// Steps Install could not take for the user and will not take on a
    /// retry: optional rows still not ready whose action a person performs by
    /// hand. `skipped` is excluded deliberately, since it means the row had
    /// nothing to check rather than something outstanding.
    public var outstandingManualRows: [PlanRow] {
        allRows.filter { row in
            guard !row.required, row.status != .ready, row.status != .skipped else { return false }
            guard let type = row.action?.type else { return false }
            return type == .steps || type == .openURL
        }
    }

    public func load() async { await fetch() }

    public func recheckAll() async {
        await probePermissions()
        await fetch()
    }

    public func afterAction(rowId: String) async {
        checkingRowIds.insert(rowId)
        await probePermissions()
        await fetch()
        checkingRowIds.remove(rowId)
    }

    /// The screen marks a row checking before it starts a verb — `afterAction`
    /// only inserts once the verb has already returned, which is too late to
    /// block a second click during a long-running one.
    public func beginChecking(_ rowId: String) { checkingRowIds.insert(rowId) }
    public func endChecking(_ rowId: String) { checkingRowIds.remove(rowId) }

    public func becameVisible() {
        visibilityDepth += 1
        guard visibilityDepth == 1 else { return }
        tick?.cancel()
        tick = ticker.schedule(every: Self.permissionTickSeconds) { [weak self] in
            Task { @MainActor [weak self] in await self?.probePermissions() }
        }
        Task { await probePermissions() }
    }

    public func becameHidden() {
        visibilityDepth = max(0, visibilityDepth - 1)
        guard visibilityDepth == 0 else { return }
        tick?.cancel()
        tick = nil
    }

    public func didBecomeActive() {
        Task { await probePermissions(); await fetch() }
    }

    private func fetch() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let plan = try await plans.fetchPlan()
            team = plan.team
            groups = plan.groups
            planCanInstall = plan.canInstall
            lastError = nil
            // Only re-overlay once a local probe has actually run; before
            // that, rt's own permission status in the plan is the freshest
            // thing we have, and .unknown must not clobber it.
            if hasProbedPermissions { applyOverlay(permissionSnapshot) }
            recomputeEnablement()
        } catch {
            lastError = String(describing: error)
        }
    }

    private func probePermissions() async {
        let snap = await permissions.snapshot()
        permissionSnapshot = snap
        hasProbedPermissions = true
        fdaNeedsRelaunch = permissions.fdaNeedsRelaunch
        applyOverlay(snap)
        recomputeEnablement()
    }

    private func applyOverlay(_ snap: PermissionSnapshot) {
        for g in groups.indices {
            for r in groups[g].rows.indices where groups[g].rows[r].kind == .permission {
                if let (status, detail) = PermissionRowOverlay.status(for: groups[g].rows[r].id, in: snap) {
                    groups[g].rows[r].status = status
                    groups[g].rows[r].detail = detail
                }
            }
        }
    }

    /// rt can gate installability on something not expressed as a row, so
    /// its own plan.canInstall is a hard veto — never enable Install just
    /// because every visible row happens to look ready.
    private func recomputeEnablement() {
        requiredMissing = allRows.filter { $0.required && $0.status != .ready }.map(\.id)
        canInstall = planCanInstall && requiredMissing.isEmpty
    }
}
