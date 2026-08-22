import Foundation
import MattstackCore

/// One broker per model, over the same fakes TrayRoutesChecks uses: the
/// uninstall stream's `need` events are performed on it.
@MainActor
private func makeTeamSettings(_ rt: RtRunning, services: FakeServices = FakeServices(),
                              privileged: FakePrivileged = FakePrivileged()) -> (TeamSettingsModel, NeedBroker) {
    let broker = NeedBroker(services: services, privileged: privileged)
    return (TeamSettingsModel(rt: rt, needs: broker), broker)
}

let settingsChecks: [Check] = [
    Check("RemoteMasker shows host + repo only, and never leaks stripped credentials on a path-less fallback") { c in
        c.expectEqual(RemoteMasker.mask("git@gitlab.assured.com:tools/mattstack-team.git"), "gitlab.assured.com/tools/mattstack-team")
        c.expectEqual(RemoteMasker.mask("https://user:token@github.com/m4ttheweric/mattstack-home.git"), "github.com/m4ttheweric/mattstack-home")
        c.expectEqual(RemoteMasker.mask("ssh://git@github.com:22/o/r"), "github.com/o/r")
        c.expectEqual(RemoteMasker.mask("weird"), "weird")
        let pathless = RemoteMasker.mask("https://oauth2:glpat-TOPSECRET@gitlab.host")
        c.expectEqual(pathless, "gitlab.host", "a path-less remote still masks to the bare host, not the raw string")
        c.expect(!pathless.contains("glpat-TOPSECRET"), "credentials must never survive masking, even on the no-\"/\" fallback path")
    },
    Check("TeamSettingsModel loads status, mints invites through rt, loads the uninstall dry-run — exact argv, no stdin") { c in
        let rt = ScriptedRt()
        rt.answers["team status"] = (0, #"{"contract":1,"name":"Assured","slug":"assured","remote":"git@github.com:assured/mattstack-team-assured.git","lastPush":"2026-08-21T03:00:00Z","members":[{"username":"matt"},{"username":"bob"}]}"#)
        rt.answers["team invite --handle bob"] = (0, #"{"contract":1,"code":"ABCD","expiresAt":"2026-08-28T00:00:00Z","pasteBlock":"Install mattstack…","forgeAccess":"granted","manualSteps":[]}"#)
        rt.answers["uninstall --dry-run"] = (0, #"{"contract":1,"actions":[{"id":"services.unregister","title":"Stop services"}]}"#)
        let m = await MainActor.run { makeTeamSettings(rt).0 }
        await m.load()
        await MainActor.run {
            c.expectEqual(m.info?.name, "Assured")
            c.expectEqual(m.maskedRemote, "github.com/assured/mattstack-team-assured")
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
    Check("loadUninstallPlan clears a stale plan on a failed reload — Cancel then a failed reopen must not leave the sheet armable") { c in
        let rt = ScriptedRt()
        rt.answers["uninstall --dry-run"] = (0, #"{"contract":1,"actions":[{"id":"services.unregister","title":"Stop services"}]}"#)
        let m = await MainActor.run { makeTeamSettings(rt).0 }
        await m.loadUninstallPlan()
        await MainActor.run { c.expectEqual(m.uninstallPlan?.actions.first?.id, "services.unregister") }
        // User cancels the confirmation sheet here — no model call, uninstallPlan stays set.
        rt.answers["uninstall --dry-run"] = (1, "")
        await m.loadUninstallPlan()
        await MainActor.run {
            c.expectEqual(m.uninstallPlan, nil, "a failed reload must clear the earlier plan, not leave it armable on stale actions")
            c.expect(m.error != nil, "the failure must be surfaced")
        }
    },
    Check("TeamSettingsModel.uninstall(keepData:) streams the exact argv for keep vs delete, no stdin") { c in
        let rt = ScriptedRt()
        let m = await MainActor.run { makeTeamSettings(rt).0 }
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
        let m = await MainActor.run { makeTeamSettings(rt).0 }
        await m.load()
        await MainActor.run {
            c.expectEqual(m.error, "rt team status failed (exit 1).", "a non-2 exit must surface rt's failureCopy, never fall through to a generic \"unexpected reply\"")
            c.expect(m.info == nil)
        }
        rt.answers["team status"] = (0, #"{"contract":1,"name":"Assured"}"#)
        await m.load()
        await MainActor.run {
            c.expectEqual(m.error, nil, "a later success must clear the earlier failure")
            c.expectEqual(m.info?.name, "Assured")
        }
    },
    Check("the uninstall stream performs its need events on the shared NeedBroker — rt polls those outcomes and would otherwise time out") { c in
        let rt = ScriptedRt()
        let services = FakeServices(), privileged = FakePrivileged()
        rt.streamLines = [
            #"{"event":"plan","steps":[{"id":"services.unregister","title":"Stop services","kind":"app"},{"id":"proxy.remove","title":"Remove the proxy","kind":"privileged"}]}"#,
            #"{"event":"step","id":"services.unregister","state":"running"}"#,
            #"{"event":"need","id":"services.unregister","request":{"type":"app-unregister-services","plists":["com.mattstack.daemon.plist"]}}"#,
            #"{"event":"step","id":"services.unregister","state":"done","detail":"done by the app"}"#,
            #"{"event":"need","id":"proxy.remove","request":{"type":"app-privileged","op":"proxy-remove"}}"#,
            #"{"event":"done","ok":true,"failedStep":null}"#,
        ]
        let (m, broker) = await MainActor.run { makeTeamSettings(rt, services: services, privileged: privileged) }
        // An outcome left by an earlier run must not answer this run's poll.
        _ = await broker.perform(id: "services.unregister", request: NeedRequest(type: "stale-need", plists: nil, op: nil))

        var lines: [String] = []
        for try await line in await MainActor.run(body: { m.uninstall(keepData: true) }) { lines.append(line) }

        c.expectEqual(lines, rt.streamLines, "every line still reaches the consumer, unchanged and in order")
        c.expectEqual(services.unregistered, [["com.mattstack.daemon.plist"]], "the app-unregister-services need must reach the services provider")
        c.expectEqual(services.registered, [], "an uninstall must never register anything")
        c.expectEqual(privileged.removes, 1, "proxy.remove must raise the privileged removal, not sit pending")
        let unreg = await broker.outcome(id: "services.unregister")
        let proxy = await broker.outcome(id: "proxy.remove")
        c.expectEqual(unreg.state, "done", "rt polls GET /setup/need/services.unregister until this says done")
        c.expectEqual(proxy.state, "done")
        c.expect(!unreg.detail.contains("stale-need"), "the pre-run ledger entry must be forgotten, not replayed as this run's outcome")
    },
]
