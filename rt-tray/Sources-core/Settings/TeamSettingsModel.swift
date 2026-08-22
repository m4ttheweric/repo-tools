import Foundation
import Combine

public struct TeamSettingsInfo: Codable, Equatable, Sendable {
    public struct Member: Codable, Equatable, Sendable { public var username: String }
    public var name: String?
    public var slug: String?
    public var remote: String?
    public var lastPush: String?
    public var members: [Member]?
}

@MainActor
public final class TeamSettingsModel: ObservableObject {
    @Published public private(set) var info: TeamSettingsInfo?
    @Published public private(set) var invite: InviteResult?
    @Published public private(set) var uninstallPlan: UninstallPlan?
    @Published public private(set) var error: String?
    private let rt: RtRunning
    private let needs: NeedBroker
    public init(rt: RtRunning, needs: NeedBroker) { self.rt = rt; self.needs = needs }

    public var maskedRemote: String { info?.remote.map(RemoteMasker.mask) ?? "—" }

    public func load() async {
        if let decoded = await runJSON(["team", "status", "--json"], verb: "team status", as: TeamSettingsInfo.self) { info = decoded }
    }

    public func mintInvite(handle: String) async {
        if let decoded = await runJSON(["team", "invite", "--handle", handle, "--json"], verb: "team invite", as: InviteResult.self) { invite = decoded }
    }

    public func loadUninstallPlan() async {
        // Cleared before the call, not just left alone on failure: an
        // earlier successful load followed by Cancel must not let a later
        // failed reload arm the confirmation sheet on stale actions.
        uninstallPlan = nil
        if let decoded = await runJSON(["uninstall", "--dry-run", "--json"], verb: "uninstall --dry-run", as: UninstallPlan.self) { uninstallPlan = decoded }
    }

    /// `--yes`: the Uninstall pane's sheet is the confirmation; without it
    /// rt exits 2 `confirm-required` for `--delete-data` on a non-TTY.
    ///
    /// The real run is NDJSON like `setup apply`, `need` events included
    /// (`services.unregister` unregisters the agents, `proxy.remove` raises
    /// the admin prompt), so it goes through the same NeedBroker the install
    /// screen uses — rt waits on those outcomes before it can finish.
    public func uninstall(keepData: Bool) -> AsyncThrowingStream<String, Error> {
        NeedPump.performing(rt.stream(["uninstall", keepData ? "--keep-data" : "--delete-data", "--yes", "--json"], stdin: nil),
                            needs: needs)
    }

    /// Same failure shape everywhere a JSON verb is called: `userError`
    /// (exit 2) wins outright; any other non-zero exit, or a 0-exit reply
    /// that doesn't decode, falls to `failureCopy(verb:)` (rt's own
    /// stderr-derived copy — never a bare "unexpected reply" for an actual
    /// failure, since that sentence is `failureCopy`'s own 0-exit case);
    /// a thrown `RtClientError` (spawn failure) uses its `.copy`. Clears
    /// `error` up front so a retry after a fix doesn't leave stale text
    /// under a result that already succeeded.
    private func runJSON<T: Decodable>(_ args: [String], verb: String, as type: T.Type) async -> T? {
        error = nil
        do {
            let r = try await rt.run(args, stdin: nil)
            if let e = r.userError { error = e.message; return nil }
            guard r.exitCode == 0, let decoded = try? r.decode(T.self) else {
                error = r.failureCopy(verb: verb)
                return nil
            }
            return decoded
        } catch {
            self.error = (error as? RtClientError)?.copy ?? "rt \(verb) failed to start."
            return nil
        }
    }
}
