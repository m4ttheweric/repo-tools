import Foundation
import MattstackCore

let teamChoiceChecks: [Check] = [
    Check("Slug.make") { c in
        c.expectEqual(Slug.make("Acme Claims!"), "acme-svc")
        c.expectEqual(Slug.make("  My  Team -- 2 "), "my-team-2")
        c.expectEqual(Slug.make(""), "")
    },
    Check("create: slug preview, gh owner picker from github status, canContinue needs name + remote") { c in
        let rt = ScriptedRt()
        rt.answers["setup github status"] = (0, #"{"contract":1,"status":"ready","handle":"m4ttheweric","owners":["m4ttheweric","acme"]}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await m.loadGitHubStatus()
        await MainActor.run {
            c.expectEqual(m.ghHandle, "m4ttheweric")
            c.expectEqual(m.ghOwners, ["m4ttheweric", "acme"])
            c.expectEqual(m.useGhRepo, true)
            c.expectEqual(m.ghOwner, "m4ttheweric")
            c.expectEqual(m.canContinue, false)
            m.teamName = "Acme Claims"
            c.expectEqual(m.slugPreview, "acme-svc")
            c.expectEqual(m.ghRepoPreview, "m4ttheweric/mattstack-team-acme-claims")
            c.expectEqual(m.canContinue, true)
            m.useGhRepo = false
            c.expectEqual(m.canContinue, false, "URL field now required")
            m.remoteURL = "git@gitlab.example.com:tools/mattstack-team.git"
            c.expectEqual(m.canContinue, true)
        }
    },
    Check("create: validateAndPrepare calls home init --dry-run then team create, never with secrets on argv") { c in
        let rt = ScriptedRt()
        rt.answers["home init --dry-run"] = (0, #"{"contract":1,"ok":true}"#)
        rt.answers["team create"] = (0, #"{"contract":1,"team":{"slug":"acme-svc","name":"Acme Claims"},"remote":"ok"}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await MainActor.run { m.choice = .create; m.teamName = "Acme Claims"; m.useGhRepo = false; m.remoteURL = "https://example.com/t.git" }
        let err = await m.validateAndPrepare()
        c.expect(err == nil, "got \(err ?? "")")
        try c.require(rt.calls.count >= 2, "expected home init --dry-run then team create, got \(rt.calls.map(\.args))")
        c.expectEqual(rt.calls[0].args.prefix(3), ["home", "init", "--dry-run"])
        c.expectEqual(rt.calls[1].args, ["team", "create", "Acme Claims", "--remote", "https://example.com/t.git", "--others", "--json"])
        let gh = ScriptedRt()
        gh.answers["home init --dry-run"] = (0, #"{"contract":1,"ok":true}"#)
        gh.answers["team create"] = (0, #"{"contract":1,"team":{"slug":"acme-svc","name":"Acme Claims"},"remote":"ok"}"#)
        let m2 = await MainActor.run { TeamChoiceModel(rt: gh) }
        await MainActor.run { m2.choice = .create; m2.teamName = "Acme Claims"; m2.useGhRepo = true; m2.ghOwner = "acme"; m2.othersWillJoin = false }
        c.expect(await m2.validateAndPrepare() == nil)
        try c.require(gh.calls.count >= 2, "expected home init --dry-run then team create, got \(gh.calls.map(\.args))")
        c.expectEqual(gh.calls[1].args, ["team", "create", "Acme Claims", "--create-repo", "acme", "--json"])
    },
    Check("create: loadGitHubStatus only queries rt once — a second call after Back doesn't clobber the user's edits") { c in
        let rt = ScriptedRt()
        rt.answers["setup github status"] = (0, #"{"contract":1,"status":"ready","handle":"m4ttheweric","owners":["m4ttheweric","acme"]}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await m.loadGitHubStatus()
        await MainActor.run {
            c.expectEqual(m.useGhRepo, true)
            m.useGhRepo = false
            m.remoteURL = "git@gitlab.example.com:tools/mattstack-team.git"
        }
        await m.loadGitHubStatus()
        await MainActor.run {
            c.expectEqual(m.useGhRepo, false, "a second load must not re-overwrite the user's choice")
            c.expectEqual(m.remoteURL, "git@gitlab.example.com:tools/mattstack-team.git")
        }
        c.expectEqual(rt.calls.filter { $0.args.prefix(3) == ["setup", "github", "status"] }.count, 1)
    },
    Check("create: validateAndPrepare is idempotent for unchanged inputs; a changed field re-runs it") { c in
        let rt = ScriptedRt()
        rt.answers["home init --dry-run"] = (0, #"{"contract":1,"ok":true}"#)
        rt.answers["team create"] = (0, #"{"contract":1,"team":{"slug":"acme-svc","name":"Acme Claims"},"remote":"ok"}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await MainActor.run { m.choice = .create; m.teamName = "Acme Claims"; m.useGhRepo = false; m.remoteURL = "https://example.com/t.git" }
        c.expect(await m.validateAndPrepare() == nil)
        c.expect(await m.validateAndPrepare() == nil, "repeat call with unchanged inputs must still report success")
        c.expectEqual(rt.calls.filter { $0.args.prefix(2) == ["team", "create"] }.count, 1, "unchanged inputs must not re-run team create")
        await MainActor.run { m.teamName = "Acme Claims 2" }
        c.expect(await m.validateAndPrepare() == nil)
        c.expectEqual(rt.calls.filter { $0.args.prefix(2) == ["team", "create"] }.count, 2, "a changed field must re-run team create")
    },
    Check("join: code goes on stdin; success summary; failure copy is specific") { c in
        let rt = ScriptedRt()
        rt.answers["team join --dry-run"] = (0, #"{"contract":1,"team":{"slug":"acme","name":"Acme","owner":"matt"},"access":"ok","peering":"idle","message":"Joining Acme (owner matt)"}"#)
        rt.answers["home init --dry-run"] = (0, #"{"contract":1,"ok":true}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await MainActor.run { m.choice = .join; m.inviteCode = "ABCD-EFGH" }
        let err = await m.validateAndPrepare()
        c.expect(err == nil)
        try c.require(!rt.calls.isEmpty, "expected a team join --dry-run call")
        c.expectEqual(rt.calls[0].args, ["team", "join", "--dry-run", "--json"])
        c.expectEqual(rt.calls[0].stdin, "{\"code\":\"ABCD-EFGH\"}")
        c.expect(rt.calls.allSatisfy { !$0.args.contains("ABCD-EFGH") }, "code never on argv")
        await MainActor.run { c.expectEqual(m.joinSummary, "Joining Acme (owner matt)") }
        let denied = ScriptedRt()
        denied.answers["team join --dry-run"] = (0, #"{"contract":1,"team":{"slug":"acme","name":"Acme","owner":"matt"},"access":"denied","peering":"idle","message":"You don't have access yet: ask matt to grant you access to Acme."}"#)
        let m2 = await MainActor.run { TeamChoiceModel(rt: denied) }
        await MainActor.run { m2.choice = .join; m2.inviteCode = "X" }
        let e2 = await m2.validateAndPrepare()
        c.expectEqual(e2, "You don't have access yet: ask matt to grant you access to Acme.", "access != ok comes back as an exit-0 result, not a user error")
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
    Check("a finished restore survives Back→Continue: the wiped key doesn't disable Continue and doesn't re-run the real restore") { c in
        let rt = ScriptedRt()
        rt.answers["restore"] = (0, #"{"contract":1,"ok":true,"repo":"m4ttheweric/mattstack-home"}"#)
        rt.answers["setup intent restore"] = (0, #"{"contract":1,"ok":true,"intent":"restore","repo":"m4ttheweric/mattstack-home"}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await MainActor.run { m.choice = .restore; m.restoreRepo = "m4ttheweric/mattstack-home"; m.restoreAgeKey = "AGE-SECRET-KEY-1XYZ" }
        c.expect(await m.validateAndPrepare() == nil)
        let afterFirst = rt.calls.count
        await MainActor.run {
            c.expectEqual(m.restoreAgeKey, "", "the key is wiped once the restore lands")
            c.expectEqual(m.canContinue, true, "Back→Continue must stay live for a repo already restored")
        }
        c.expect(await m.validateAndPrepare() == nil, "Continue again is a no-op, not a failure")
        c.expectEqual(rt.calls.count, afterFirst, "the real restore must not run a second time")
        // A different repo is a different restore: it needs its own key again.
        await MainActor.run {
            m.restoreRepo = "m4ttheweric/other-home"
            c.expectEqual(m.canContinue, false)
        }
    },
]
