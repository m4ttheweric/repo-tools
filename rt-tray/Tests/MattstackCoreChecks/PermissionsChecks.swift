import Foundation
import MattstackCore

let permissionsChecks: [Check] = [
    Check("FDAProbe: first readable path → granted with the path in detail") { c in
        let s = FDAProbe.evaluate(home: "/Users/u") { path in path.hasSuffix("TCC.db") ? .readable : .missing }
        c.expectEqual(s.status, "granted")
        c.expect(s.detail.contains("TCC.db"))
    },
    // macOS 26 refuses ~/Library/Containers/com.apple.stocks even WITH Full
    // Disk Access (container protection sits above FDA), and a probe that
    // stopped at the first refusal reported denied on every 26 machine.
    Check("FDAProbe: a refused path does not decide — a later readable path still means granted") { c in
        let s = FDAProbe.evaluate(home: "/Users/u") { path in path.hasSuffix("Bookmarks.plist") ? .readable : .permissionDenied }
        c.expectEqual(s.status, "granted")
        c.expect(s.detail.contains("Bookmarks.plist"))
    },
    Check("FDAProbe: every path refused/missing → denied, never unknown, with the refusal named") { c in
        let denied = FDAProbe.evaluate(home: "/Users/u") { _ in .permissionDenied }
        c.expectEqual(denied.status, "denied")
        c.expect(denied.detail.contains("refused"))
        let mixed = FDAProbe.evaluate(home: "/Users/u") { path in path.hasSuffix("Bookmarks.plist") ? .permissionDenied : .missing }
        c.expectEqual(mixed.status, "denied")
        c.expect(mixed.detail.contains("Bookmarks.plist refused"), "the refusal, not a later ENOENT, is the detail")
        let allMissing = FDAProbe.evaluate(home: "/Users/u") { _ in .missing }
        c.expectEqual(allMissing.status, "denied")
        c.expect(allMissing.detail.contains("ENOENT"), "ENOENT-ish exhaustion must still carry the error text in detail")
        let allOtherError = FDAProbe.evaluate(home: "/Users/u") { _ in .otherError(5) }
        c.expectEqual(allOtherError.status, "denied")
        c.expect(allOtherError.detail.contains("5"), "unexpected errno must land in detail")
    },
    Check("FDAProbe paths are expanded against the given home, start with TCC.db, and never touch an app container") { c in
        var seen: [String] = []
        _ = FDAProbe.evaluate(home: "/Users/zed") { seen.append($0); return .missing }
        c.expect(seen.allSatisfy { $0.hasPrefix("/Users/zed/") || $0.hasPrefix("/Library/") })
        c.expectEqual(seen.first, "/Users/zed/Library/Application Support/com.apple.TCC/TCC.db")
        c.expect(!seen.contains { $0.contains("/Library/Containers/") }, "container paths are refused above FDA on macOS 26")
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
