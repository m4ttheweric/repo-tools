import Foundation
import Combine

public enum TeamChoice: Equatable, Sendable { case create, join, restore }

public struct GitHubStatus: Codable, Equatable, Sendable {
    public var status: RowStatus
    public var handle: String?
    public var owners: [String]?
}

/// Screen 2 state. Every validation is an rt verb; codes and keys travel on
/// stdin; nothing is pushed until Install.
@MainActor
public final class TeamChoiceModel: ObservableObject {
    public nonisolated static let inviteCodeLength = 77
    public static let explainer = "mattstack keeps your team settings in git. That keeps them safe and gives you a paper trail: skill edits and every change are visible in history. The same goes for your own settings home repo, created by the same step."

    @Published public var choice: TeamChoice = .create
    @Published public var teamName = ""
    @Published public var othersWillJoin = true
    @Published public var useGhRepo = false
    @Published public var ghOwner: String?
    @Published public private(set) var ghOwners: [String] = []
    @Published public private(set) var ghHandle: String?
    @Published public var remoteURL = ""
    @Published public var inviteCode = ""
    @Published public var restoreRepo = ""
    @Published public var restoreAgeKey = ""
    @Published public private(set) var joinSummary: String?
    @Published public private(set) var isChecking = false

    private let rt: RtRunning
    public init(rt: RtRunning) { self.rt = rt }

    public var slugPreview: String { Slug.make(teamName) }
    public var ghRepoPreview: String { "\(ghOwner ?? ghHandle ?? "you")/mattstack-team-\(slugPreview)" }
    public var normalizedInviteCode: String { inviteCode.filter { !$0.isWhitespace && !$0.isNewline } }

    public var canContinue: Bool {
        switch choice {
        case .create:
            guard !slugPreview.isEmpty else { return false }
            return useGhRepo ? (ghHandle != nil) : !remoteURL.trimmingCharacters(in: .whitespaces).isEmpty
        case .join:
            return !normalizedInviteCode.isEmpty
        case .restore:
            return !restoreRepo.trimmingCharacters(in: .whitespaces).isEmpty && !restoreAgeKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    public func loadGitHubStatus() async {
        guard let result = try? await rt.run(["setup", "github", "status", "--json"], stdin: nil),
              let status = try? result.decode(GitHubStatus.self), status.status == .ready else { return }
        ghHandle = status.handle
        ghOwners = status.owners ?? [status.handle].compactMap { $0 }
        ghOwner = ghOwners.first
        useGhRepo = true
    }

    /// Runs the dry-run verbs for the chosen card. Returns nil on success or
    /// the exact sentence to show under the fields.
    public func validateAndPrepare() async -> String? {
        isChecking = true
        defer { isChecking = false }
        do {
            switch choice {
            case .create:
                if let e = await homeInitCheck() { return e }
                var args = ["team", "create", teamName]
                args += useGhRepo ? ["--create-repo", ghOwner ?? ghHandle ?? ""] : ["--remote", remoteURL.trimmingCharacters(in: .whitespaces)]
                if othersWillJoin { args.append("--others") }
                args.append("--json")
                let r = try await rt.run(args, stdin: nil)
                if let e = r.userError { return e.message }
                guard r.exitCode == 0 else { return "rt team create failed (exit \(r.exitCode))." }
                return nil
            case .join:
                let stdin = try JSONEncoder().encode(["code": normalizedInviteCode])
                let r = try await rt.run(["team", "join", "--dry-run", "--json"], stdin: stdin)
                if let e = r.userError { return Self.joinFailureCopy(e, owner: nil, team: nil) }
                guard r.exitCode == 0, let j = try? r.decode(TeamJoinResult.self) else { return "rt team join failed (exit \(r.exitCode))." }
                guard j.access == "ok" else { return Self.joinFailureCopy(RtUserError(code: j.access == "denied" ? "no-access" : "unreachable", message: j.message ?? ""), owner: j.team?.owner, team: j.team?.name) }
                joinSummary = j.message ?? "Joining \(j.team?.name ?? "") (owner \(j.team?.owner ?? ""))"
                return await homeInitCheck()
            case .restore:
                // Ruling R3: the app runs the real restore at Continue (clone
                // + key into the Keychain), then records the intent so
                // `setup apply`'s home.restore step only verifies.
                let repo = restoreRepo.trimmingCharacters(in: .whitespaces)
                let stdin = try JSONEncoder().encode(["ageKey": restoreAgeKey.trimmingCharacters(in: .whitespacesAndNewlines)])
                let r = try await rt.run(["restore", repo, "--json"], stdin: stdin)
                if let e = r.userError { return e.message }
                guard r.exitCode == 0 else { return "rt restore failed (exit \(r.exitCode))." }
                let intent = try await rt.run(["setup", "intent", "restore", repo, "--json"], stdin: nil)
                if let e = intent.userError { return e.message }
                return intent.exitCode == 0 ? nil : "rt setup intent restore failed (exit \(intent.exitCode))."
            }
        } catch {
            return "Could not run rt: \(error)"
        }
    }

    private func homeInitCheck() async -> String? {
        guard let r = try? await rt.run(["home", "init", "--dry-run", "--json"], stdin: nil) else { return "Could not run rt home init." }
        if let e = r.userError { return e.message }
        return r.exitCode == 0 ? nil : "rt home init --dry-run failed (exit \(r.exitCode))."
    }

    public nonisolated static func joinFailureCopy(_ error: RtUserError, owner: String?, team: String?) -> String {
        let who = owner ?? "the team owner"
        switch error.code {
        case "no-access": return error.message.isEmpty ? "You don't have access yet: ask \(who) to grant you access to \(team ?? "the team")." : error.message
        case "expired", "not-found", "redeemed", "invite-unknown": return "Invite not recognized or expired: ask \(who) for a new one."
        case "invite-malformed": return "That doesn't look like an invite code — paste the whole code (about \(inviteCodeLength) characters)."
        case "wrong-account": return "This code is for a different forge account than you're signed into."
        default: return error.message.isEmpty ? "Couldn't redeem the invite." : error.message
        }
    }
}
