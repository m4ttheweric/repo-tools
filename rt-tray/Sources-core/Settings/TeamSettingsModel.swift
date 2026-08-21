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
    public init(rt: RtRunning) { self.rt = rt }

    public var maskedRemote: String { info?.remote.map(RemoteMasker.mask) ?? "—" }

    public func load() async {
        do {
            let r = try await rt.run(["team", "status", "--json"], stdin: nil)
            if let e = r.userError { error = e.message; return }
            info = try r.decode(TeamSettingsInfo.self)
        } catch { self.error = Self.describe(error) }
    }

    public func mintInvite(handle: String) async {
        do {
            let r = try await rt.run(["team", "invite", "--handle", handle, "--json"], stdin: nil)
            if let e = r.userError { error = e.message; return }
            invite = try r.decode(InviteResult.self)
        } catch { self.error = Self.describe(error) }
    }

    public func loadUninstallPlan() async {
        do {
            let r = try await rt.run(["uninstall", "--dry-run", "--json"], stdin: nil)
            if let e = r.userError { error = e.message; return }
            uninstallPlan = try r.decode(UninstallPlan.self)
        } catch { self.error = Self.describe(error) }
    }

    /// `--yes`: the Uninstall pane's sheet is the confirmation; without it
    /// rt exits 2 `confirm-required` for `--delete-data` on a non-TTY.
    public func uninstall(keepData: Bool) -> AsyncThrowingStream<String, Error> {
        rt.stream(["uninstall", keepData ? "--keep-data" : "--delete-data", "--yes", "--json"], stdin: nil)
    }

    /// `rt.run` throws only `RtClientError`; `decode` can throw a
    /// `DecodingError` when a reply doesn't match the contract. Neither raw
    /// case is fit for UI text, so both collapse to a fixed sentence instead
    /// of interpolating the error.
    private static func describe(_ error: Error) -> String {
        (error as? RtClientError)?.copy ?? "rt returned an unexpected reply."
    }
}
