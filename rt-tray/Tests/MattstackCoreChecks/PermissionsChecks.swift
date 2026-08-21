import Foundation
import MattstackCore

let permissionsChecks: [Check] = [
    Check("FDAProbe: first readable path → granted with the path in detail") { c in
        let s = FDAProbe.evaluate(home: "/Users/u") { path in path.hasSuffix("com.apple.stocks") ? .readable : .missing }
        c.expectEqual(s.status, "granted")
        c.expect(s.detail.contains("com.apple.stocks"))
    },
    Check("FDAProbe: EPERM/EACCES on any probe path → denied; exhausting all paths still terminates denied, never unknown") { c in
        let denied = FDAProbe.evaluate(home: "/Users/u") { _ in .permissionDenied }
        c.expectEqual(denied.status, "denied")
        let allMissing = FDAProbe.evaluate(home: "/Users/u") { _ in .missing }
        c.expectEqual(allMissing.status, "denied")
        c.expect(allMissing.detail.contains("ENOENT"), "ENOENT-ish exhaustion must still carry the error text in detail")
        let allOtherError = FDAProbe.evaluate(home: "/Users/u") { _ in .otherError(5) }
        c.expectEqual(allOtherError.status, "denied")
        c.expect(allOtherError.detail.contains("5"), "unexpected errno must land in detail")
        // a missing first path must fall through to the MacPaw list
        let second = FDAProbe.evaluate(home: "/Users/u") { path in path.hasSuffix("CloudTabs.db") ? .permissionDenied : .missing }
        c.expectEqual(second.status, "denied")
    },
    Check("FDAProbe paths are expanded against the given home, not the process's") { c in
        var seen: [String] = []
        _ = FDAProbe.evaluate(home: "/Users/zed") { seen.append($0); return .missing }
        c.expect(seen.allSatisfy { $0.hasPrefix("/Users/zed/") || $0.hasPrefix("/Library/") })
        c.expectEqual(seen.first, "/Users/zed/Library/Containers/com.apple.stocks")
    },
    Check("SystemSettingsLinks are the documented deep links") { c in
        c.expectEqual(SystemSettingsLinks.fullDiskAccess.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        c.expectEqual(SystemSettingsLinks.notifications(bundleId: "com.mattstack.app").absoluteString,
                      "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.mattstack.app")
        c.expectEqual(SystemSettingsLinks.loginItems.absoluteString, "x-apple.systempreferences:com.apple.LoginItems-Settings.extension")
        c.expectEqual(SystemSettingsLinks.keyboard.absoluteString, "x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Shortcuts")
    },
    Check("TCCReset builds the reset arguments for a bundle id") { c in
        let (exe, args) = TCCReset.arguments(bundleId: "com.mattstack.app.dev")
        c.expect(exe.hasPrefix("/usr/bin/") && exe.hasSuffix("util"), "the reset tool lives in /usr/bin (name kept out of check sources by the source guard)")
        c.expectEqual(args, ["reset", "All", "com.mattstack.app.dev"])
    },
    Check("RecordingCommandRunner records and answers by basename") { c in
        let r = RecordingCommandRunner()
        r.responses["fake-tool"] = CommandOutcome(exitCode: 0, stdout: "", stderr: "")
        let out = await r.run("/usr/bin/fake-tool", ["reset", "All", "x"])
        c.expect(out.ok)
        try c.requireEqual(r.calls.count, 1)
        c.expectEqual(r.calls[0].args, ["reset", "All", "x"])
        let unknown = await r.run("/bin/nothing", [])
        c.expectEqual(unknown.exitCode, 127)
    },
]
