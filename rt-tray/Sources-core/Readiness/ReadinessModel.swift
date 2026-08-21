import Foundation
import Combine

public protocol PlanSource: Sendable { func fetchPlan() async throws -> Plan }
public protocol PermissionProbing: Sendable { func snapshot() async -> PermissionSnapshot }

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

    public static let permissionTickSeconds: TimeInterval = 1

    private let plans: PlanSource
    private let permissions: PermissionProbing
    private let ticker: TickerScheduling
    private var tick: TickerHandle?
    private var lastSnapshot = PermissionSnapshot.unknown
    private var hasProbedPermissions = false

    public init(plans: PlanSource, permissions: PermissionProbing, ticker: TickerScheduling) {
        self.plans = plans; self.permissions = permissions; self.ticker = ticker
    }

    public var allRows: [PlanRow] { groups.flatMap(\.rows) }
    public func row(_ id: String) -> PlanRow? { allRows.first { $0.id == id } }

    /// Every required row ready, at least one optional non-permission row
    /// not ready. Permission rows resolve via the local overlay, not the
    /// plan's stale snapshot, so they never gate limited mode on their own.
    public var limitedModeAvailable: Bool {
        canInstall && allRows.contains { !$0.required && $0.kind != .permission && $0.status != .ready }
    }

    public func load() async { await fetch() }
    public func recheckAll() async { await fetch() }

    public func afterAction(rowId: String) async {
        checkingRowIds.insert(rowId)
        await fetch()
        checkingRowIds.remove(rowId)
    }

    public func becameVisible() {
        tick?.cancel()
        tick = ticker.schedule(every: Self.permissionTickSeconds) { [weak self] in
            Task { @MainActor [weak self] in await self?.probePermissions() }
        }
        Task { await probePermissions() }
    }

    public func becameHidden() {
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
            lastError = nil
            // Only re-overlay once a local probe has actually run; before
            // that, rt's own permission status in the plan is the freshest
            // thing we have, and .unknown must not clobber it.
            if hasProbedPermissions { applyOverlay(lastSnapshot) }
            recomputeEnablement()
        } catch {
            lastError = String(describing: error)
        }
    }

    private func probePermissions() async {
        let snap = await permissions.snapshot()
        lastSnapshot = snap
        hasProbedPermissions = true
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

    private func recomputeEnablement() {
        requiredMissing = allRows.filter { $0.required && $0.status != .ready }.map(\.id)
        canInstall = requiredMissing.isEmpty
    }
}
