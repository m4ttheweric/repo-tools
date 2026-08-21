import Foundation
import MattstackCore

private final class ScriptedRt: RtRunning, @unchecked Sendable {
    var answers: [String: (Int32, String)] = [:]   // key: args joined by space
    var calls: [(args: [String], stdin: String?)] = []
    func run(_ args: [String], stdin: Data?) async throws -> RtResult {
        calls.append((args, stdin.map { String(decoding: $0, as: UTF8.self) }))
        let key = args.joined(separator: " ")
        // Longest matching prefix wins — deterministic even when two answer
        // keys are both prefixes of the same call (e.g. "restore" and a
        // hypothetical "restore --dry-run").
        let (code, out) = answers.filter { key.hasPrefix($0.key) }.max { $0.key.count < $1.key.count }?.value ?? (1, "")
        return RtResult(exitCode: code, stdout: Data(out.utf8), stderr: Data())
    }
    func stream(_ args: [String], stdin: Data?) -> AsyncThrowingStream<String, Error> { AsyncThrowingStream { $0.finish() } }
}

let teamChoiceChecks: [Check] = [
    Check("Slug.make") { c in
        c.expectEqual(Slug.make("Assured Claims!"), "assured-claims")
        c.expectEqual(Slug.make("  My  Team -- 2 "), "my-team-2")
        c.expectEqual(Slug.make(""), "")
    },
    Check("create: slug preview, gh owner picker from github status, canContinue needs name + remote") { c in
        let rt = ScriptedRt()
        rt.answers["setup github status"] = (0, #"{"contract":1,"status":"ready","handle":"m4ttheweric","owners":["m4ttheweric","assured"]}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await m.loadGitHubStatus()
        await MainActor.run {
            c.expectEqual(m.ghHandle, "m4ttheweric")
            c.expectEqual(m.ghOwners, ["m4ttheweric", "assured"])
            c.expectEqual(m.useGhRepo, true)
            c.expectEqual(m.ghOwner, "m4ttheweric")
            c.expectEqual(m.canContinue, false)
            m.teamName = "Assured Claims"
            c.expectEqual(m.slugPreview, "assured-claims")
            c.expectEqual(m.ghRepoPreview, "m4ttheweric/mattstack-team-assured-claims")
            c.expectEqual(m.canContinue, true)
            m.useGhRepo = false
            c.expectEqual(m.canContinue, false, "URL field now required")
            m.remoteURL = "git@gitlab.assured.com:tools/mattstack-team.git"
            c.expectEqual(m.canContinue, true)
        }
    },
    Check("create: validateAndPrepare calls home init --dry-run then team create, never with secrets on argv") { c in
        let rt = ScriptedRt()
        rt.answers["home init --dry-run"] = (0, #"{"contract":1,"ok":true}"#)
        rt.answers["team create"] = (0, #"{"contract":1,"team":{"slug":"assured-claims","name":"Assured Claims"},"remote":"ok"}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await MainActor.run { m.choice = .create; m.teamName = "Assured Claims"; m.useGhRepo = false; m.remoteURL = "https://example.com/t.git" }
        let err = await m.validateAndPrepare()
        c.expect(err == nil, "got \(err ?? "")")
        try c.require(rt.calls.count >= 2, "expected home init --dry-run then team create, got \(rt.calls.map(\.args))")
        c.expectEqual(rt.calls[0].args.prefix(3), ["home", "init", "--dry-run"])
        c.expectEqual(rt.calls[1].args, ["team", "create", "Assured Claims", "--remote", "https://example.com/t.git", "--others", "--json"])
        let gh = ScriptedRt()
        gh.answers["home init --dry-run"] = (0, #"{"contract":1,"ok":true}"#)
        gh.answers["team create"] = (0, #"{"contract":1,"team":{"slug":"assured-claims","name":"Assured Claims"},"remote":"ok"}"#)
        let m2 = await MainActor.run { TeamChoiceModel(rt: gh) }
        await MainActor.run { m2.choice = .create; m2.teamName = "Assured Claims"; m2.useGhRepo = true; m2.ghOwner = "assured"; m2.othersWillJoin = false }
        c.expect(await m2.validateAndPrepare() == nil)
        try c.require(gh.calls.count >= 2, "expected home init --dry-run then team create, got \(gh.calls.map(\.args))")
        c.expectEqual(gh.calls[1].args, ["team", "create", "Assured Claims", "--create-repo", "assured", "--json"])
    },
    Check("create: loadGitHubStatus only queries rt once — a second call after Back doesn't clobber the user's edits") { c in
        let rt = ScriptedRt()
        rt.answers["setup github status"] = (0, #"{"contract":1,"status":"ready","handle":"m4ttheweric","owners":["m4ttheweric","assured"]}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await m.loadGitHubStatus()
        await MainActor.run {
            c.expectEqual(m.useGhRepo, true)
            m.useGhRepo = false
            m.remoteURL = "git@gitlab.assured.com:tools/mattstack-team.git"
        }
        await m.loadGitHubStatus()
        await MainActor.run {
            c.expectEqual(m.useGhRepo, false, "a second load must not re-overwrite the user's choice")
            c.expectEqual(m.remoteURL, "git@gitlab.assured.com:tools/mattstack-team.git")
        }
        c.expectEqual(rt.calls.filter { $0.args.prefix(3) == ["setup", "github", "status"] }.count, 1)
    },
    Check("create: validateAndPrepare is idempotent for unchanged inputs; a changed field re-runs it") { c in
        let rt = ScriptedRt()
        rt.answers["home init --dry-run"] = (0, #"{"contract":1,"ok":true}"#)
        rt.answers["team create"] = (0, #"{"contract":1,"team":{"slug":"assured-claims","name":"Assured Claims"},"remote":"ok"}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await MainActor.run { m.choice = .create; m.teamName = "Assured Claims"; m.useGhRepo = false; m.remoteURL = "https://example.com/t.git" }
        c.expect(await m.validateAndPrepare() == nil)
        c.expect(await m.validateAndPrepare() == nil, "repeat call with unchanged inputs must still report success")
        c.expectEqual(rt.calls.filter { $0.args.prefix(2) == ["team", "create"] }.count, 1, "unchanged inputs must not re-run team create")
        await MainActor.run { m.teamName = "Assured Claims 2" }
        c.expect(await m.validateAndPrepare() == nil)
        c.expectEqual(rt.calls.filter { $0.args.prefix(2) == ["team", "create"] }.count, 2, "a changed field must re-run team create")
    },
    Check("join: code goes on stdin; success summary; failure copy is specific") { c in
        let rt = ScriptedRt()
        rt.answers["team join --dry-run"] = (0, #"{"contract":1,"team":{"slug":"assured","name":"Assured","owner":"matt"},"access":"ok","peering":"idle","message":"Joining Assured (owner matt)"}"#)
        rt.answers["home init --dry-run"] = (0, #"{"contract":1,"ok":true}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await MainActor.run { m.choice = .join; m.inviteCode = "ABCD-EFGH" }
        let err = await m.validateAndPrepare()
        c.expect(err == nil)
        try c.require(!rt.calls.isEmpty, "expected a team join --dry-run call")
        c.expectEqual(rt.calls[0].args, ["team", "join", "--dry-run", "--json"])
        c.expectEqual(rt.calls[0].stdin, "{\"code\":\"ABCD-EFGH\"}")
        c.expect(rt.calls.allSatisfy { !$0.args.contains("ABCD-EFGH") }, "code never on argv")
        await MainActor.run { c.expectEqual(m.joinSummary, "Joining Assured (owner matt)") }
        let denied = ScriptedRt()
        denied.answers["team join --dry-run"] = (0, #"{"contract":1,"team":{"slug":"assured","name":"Assured","owner":"matt"},"access":"denied","peering":"idle","message":"You don't have access yet: ask matt to grant you access to Assured."}"#)
        let m2 = await MainActor.run { TeamChoiceModel(rt: denied) }
        await MainActor.run { m2.choice = .join; m2.inviteCode = "X" }
        let e2 = await m2.validateAndPrepare()
        c.expectEqual(e2, "You don't have access yet: ask matt to grant you access to Assured.", "access != ok comes back as an exit-0 result, not a user error")
        let unknown = ScriptedRt()
        unknown.answers["team join --dry-run"] = (2, #"{"contract":1,"error":{"code":"invite-unknown","message":""}}"#)
        let m3 = await MainActor.run { TeamChoiceModel(rt: unknown) }
        await MainActor.run { m3.choice = .join; m3.inviteCode = "X" }
        c.expectEqual(await m3.validateAndPrepare(), "Invite not recognized or expired: ask the team owner for a new one.")
        c.expectEqual(TeamChoiceModel.joinFailureCopy(RtUserError(code: "expired", message: ""), owner: "matt", team: nil),
                      "Invite not recognized or expired: ask matt for a new one.")
        c.expectEqual(TeamChoiceModel.joinFailureCopy(RtUserError(code: "wrong-account", message: ""), owner: nil, team: nil),
                      "This code is for a different forge account than you're signed into.")
    },
    Check("join: invite field accepts pasted codes with whitespace/newlines; ~77 chars; no per-char validation") { c in
        let m = await MainActor.run { TeamChoiceModel(rt: ScriptedRt()) }
        await MainActor.run {
            m.choice = .join
            m.inviteCode = " ABCD-EFGH-\nIJKL "
            c.expectEqual(m.normalizedInviteCode, "ABCD-EFGH-IJKL")
            c.expectEqual(m.canContinue, true)
            m.inviteCode = "   "
            c.expectEqual(m.canContinue, false)
            c.expectEqual(TeamChoiceModel.inviteCodeLength, 77)
        }
    },
    Check("restore: repo + key required; the real rt restore runs with the key on stdin, then setup intent restore") { c in
        let rt = ScriptedRt()
        rt.answers["restore"] = (0, #"{"contract":1,"ok":true,"repo":"m4ttheweric/mattstack-home"}"#)
        rt.answers["setup intent restore"] = (0, #"{"contract":1,"ok":true,"intent":"restore","repo":"m4ttheweric/mattstack-home"}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await MainActor.run { m.choice = .restore; m.restoreRepo = "m4ttheweric/mattstack-home"; c.expectEqual(m.canContinue, false); m.restoreAgeKey = "AGE-SECRET-KEY-1XYZ"; c.expectEqual(m.canContinue, true) }
        let err = await m.validateAndPrepare()
        c.expect(err == nil)
        try c.require(rt.calls.count >= 2, "expected restore then setup intent restore, got \(rt.calls.map(\.args))")
        c.expectEqual(rt.calls[0].args, ["restore", "m4ttheweric/mattstack-home", "--json"])
        c.expectEqual(rt.calls[0].stdin, "{\"ageKey\":\"AGE-SECRET-KEY-1XYZ\"}")
        c.expectEqual(rt.calls[1].args, ["setup", "intent", "restore", "m4ttheweric/mattstack-home", "--json"])
        c.expect(rt.calls.allSatisfy { !$0.args.contains("AGE-SECRET-KEY-1XYZ") }, "key never on argv")
    },
]
