import Foundation
import MattstackCore

let settingsChecks: [Check] = [
    Check("RemoteMasker shows host + repo only, and never leaks stripped credentials on a path-less fallback") { c in
        c.expectEqual(RemoteMasker.mask("git@gitlab.example.com:tools/mattstack-team.git"), "gitlab.example.com/tools/mattstack-team")
        c.expectEqual(RemoteMasker.mask("https://user:token@github.com/m4ttheweric/mattstack-home.git"), "github.com/m4ttheweric/mattstack-home")
        c.expectEqual(RemoteMasker.mask("ssh://git@github.com:22/o/r"), "github.com/o/r")
        c.expectEqual(RemoteMasker.mask("weird"), "weird")
        let pathless = RemoteMasker.mask("https://oauth2:glpat-TOPSECRET@gitlab.host")
        c.expectEqual(pathless, "gitlab.host", "a path-less remote still masks to the bare host, not the raw string")
        c.expect(!pathless.contains("glpat-TOPSECRET"), "credentials must never survive masking, even on the no-\"/\" fallback path")
    },
    Check("TeamSettingsModel loads status, mints invites through rt, loads the uninstall dry-run — exact argv, no stdin") { c in
        let rt = ScriptedRt()
        rt.answers["team status"] = (0, #"{"contract":1,"name":"Acme","slug":"acme","remote":"git@github.com:acme/mattstack-team-acme.git","lastPush":"2026-08-21T03:00:00Z","members":[{"username":"matt"},{"username":"bob"}]}"#)
        rt.answers["team invite --handle bob"] = (0, #"{"contract":1,"code":"ABCD","expiresAt":"2026-08-28T00:00:00Z","pasteBlock":"Install mattstack…","forgeAccess":"granted","manualSteps":[]}"#)
        rt.answers["uninstall --dry-run"] = (0, #"{"contract":1,"actions":[{"id":"services.unregister","title":"Stop services"}]}"#)
        let m = await MainActor.run { TeamSettingsModel(rt: rt) }
        await m.load()
        await MainActor.run {
            c.expectEqual(m.info?.name, "Acme")
            c.expectEqual(m.maskedRemote, "github.com/acme/mattstack-team-acme")
        }
        try c.require(rt.calls.count >= 1, "expected a team status call")
        c.expectEqual(rt.calls[0].args, ["team", "status", "--json"])
        c.expectEqual(rt.calls[0].stdin, nil)

        await m.mintInvite(handle: "bob")
        await MainActor.run { c.expectEqual(m.invite?.code, "ABCD") }
        try c.require(rt.calls.count >= 2, "expected team status then team invite, got \(rt.calls.map(\.args))")
        c.expectEqual(rt.calls[1].args, ["team", "invite", "--handle", "bob", "--json"])

        await m.loadUninstallPlan()
        await MainActor.run {
            let plan = m.uninstallPlan
            c.expect(plan != nil, "expected an uninstall plan")
            c.expectEqual(plan?.actions.first?.id, "services.unregister")
        }
        try c.require(rt.calls.count >= 3, "expected a third call for uninstall --dry-run, got \(rt.calls.map(\.args))")
        c.expectEqual(rt.calls[2].args, ["uninstall", "--dry-run", "--json"])
        c.expectEqual(rt.calls[2].stdin, nil)
    },
    Check("TeamSettingsModel.uninstall(keepData:) streams the exact argv for keep vs delete, no stdin") { c in
        let rt = ScriptedRt()
        let m = await MainActor.run { TeamSettingsModel(rt: rt) }
        _ = await MainActor.run { m.uninstall(keepData: true) }
        _ = await MainActor.run { m.uninstall(keepData: false) }
        try c.require(rt.calls.count >= 2, "expected two streamed uninstall calls, got \(rt.calls.map(\.args))")
        c.expectEqual(rt.calls[0].args, ["uninstall", "--keep-data", "--yes", "--json"])
        c.expectEqual(rt.calls[0].stdin, nil)
        c.expectEqual(rt.calls[1].args, ["uninstall", "--delete-data", "--yes", "--json"])
        c.expectEqual(rt.calls[1].stdin, nil)
    },
    Check("TeamSettingsModel surfaces a non-2 exit as rt's own failureCopy, and clears it once a later call succeeds") { c in
        let rt = ScriptedRt()
        rt.answers["team status"] = (1, "")
        let m = await MainActor.run { TeamSettingsModel(rt: rt) }
        await m.load()
        await MainActor.run {
            c.expectEqual(m.error, "rt team status failed (exit 1).", "a non-2 exit must surface rt's failureCopy, never fall through to a generic \"unexpected reply\"")
            c.expect(m.info == nil)
        }
        rt.answers["team status"] = (0, #"{"contract":1,"name":"Acme"}"#)
        await m.load()
        await MainActor.run {
            c.expectEqual(m.error, nil, "a later success must clear the earlier failure")
            c.expectEqual(m.info?.name, "Acme")
        }
    },
]
