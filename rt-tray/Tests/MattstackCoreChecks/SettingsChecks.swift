import Foundation
import MattstackCore

private final class ScriptedRt: RtRunning, @unchecked Sendable {
    var answers: [String: (Int32, String)] = [:]   // key: args joined by space
    var calls: [(args: [String], stdin: String?)] = []
    func run(_ args: [String], stdin: Data?) async throws -> RtResult {
        calls.append((args, stdin.map { String(decoding: $0, as: UTF8.self) }))
        let key = args.joined(separator: " ")
        // Longest matching prefix wins — deterministic even when two answer
        // keys are both prefixes of the same call.
        let (code, out) = answers.filter { key.hasPrefix($0.key) }.max { $0.key.count < $1.key.count }?.value ?? (1, "")
        return RtResult(exitCode: code, stdout: Data(out.utf8), stderr: Data())
    }
    func stream(_ args: [String], stdin: Data?) -> AsyncThrowingStream<String, Error> { AsyncThrowingStream { $0.finish() } }
}

let settingsChecks: [Check] = [
    Check("RemoteMasker shows host + repo only") { c in
        c.expectEqual(RemoteMasker.mask("git@gitlab.assured.com:tools/mattstack-team.git"), "gitlab.assured.com/tools/mattstack-team")
        c.expectEqual(RemoteMasker.mask("https://user:token@github.com/m4ttheweric/mattstack-home.git"), "github.com/m4ttheweric/mattstack-home")
        c.expectEqual(RemoteMasker.mask("ssh://git@github.com:22/o/r"), "github.com/o/r")
        c.expectEqual(RemoteMasker.mask("weird"), "weird")
    },
    Check("TeamSettingsModel loads status, mints invites through rt, loads the uninstall dry-run") { c in
        let rt = ScriptedRt()
        rt.answers["team status"] = (0, #"{"contract":1,"name":"Assured","slug":"assured","remote":"git@github.com:assured/mattstack-team-assured.git","lastPush":"2026-08-21T03:00:00Z","members":[{"username":"matt"},{"username":"bob"}]}"#)
        rt.answers["team invite --handle bob"] = (0, #"{"contract":1,"code":"ABCD","expiresAt":"2026-08-28T00:00:00Z","pasteBlock":"Install mattstack…","forgeAccess":"granted","manualSteps":[]}"#)
        rt.answers["uninstall --dry-run"] = (0, #"{"contract":1,"actions":[{"id":"services.unregister","title":"Stop services"}]}"#)
        let m = await MainActor.run { TeamSettingsModel(rt: rt) }
        await m.load()
        await MainActor.run {
            c.expectEqual(m.info?.name, "Assured")
            c.expectEqual(m.maskedRemote, "github.com/assured/mattstack-team-assured")
        }
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
    },
]
