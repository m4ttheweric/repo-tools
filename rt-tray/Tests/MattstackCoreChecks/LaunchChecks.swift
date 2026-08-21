import Foundation
import MattstackCore

let launchChecks: [Check] = [
    Check("LaunchGuard flags translocated and volume paths") { c in
        c.expect(LaunchGuard.isTranslocatedOrOnRemovableVolume(bundlePath: "/private/var/folders/zz/T/AppTranslocation/ABC/d/mattstack.app"))
        c.expect(LaunchGuard.isTranslocatedOrOnRemovableVolume(bundlePath: "/Volumes/mattstack-2.8.0/mattstack.app"))
        c.expect(!LaunchGuard.isTranslocatedOrOnRemovableVolume(bundlePath: "/Applications/mattstack.app"))
        c.expect(!LaunchGuard.isTranslocatedOrOnRemovableVolume(bundlePath: "/Users/u/Applications/mattstack-dev.app"))
    },
    Check("FirstRunDetector keys off ~/.mattstack/rt/daemon.json") { c in
        c.expect(FirstRunDetector.needsSetup(home: "/Users/u") { _ in false })
        c.expect(!FirstRunDetector.needsSetup(home: "/Users/u") { $0 == "/Users/u/.mattstack/rt/daemon.json" })
    },
    Check("JoinLink parses mattstack://join/<code> only") { c in
        c.expectEqual(JoinLink.code(from: URL(string: "mattstack://join/ABCD-EFGH-IJKL")!), "ABCD-EFGH-IJKL")
        c.expectEqual(JoinLink.code(from: URL(string: "mattstack://join/ABCD-EFGH-IJKL/")!), "ABCD-EFGH-IJKL")
        c.expectEqual(JoinLink.code(from: URL(string: "mattstack://join/")!), nil)
        c.expectEqual(JoinLink.code(from: URL(string: "mattstack://settings/team")!), nil)
        c.expectEqual(JoinLink.code(from: URL(string: "https://mattstack.dev/join#ABCD")!), nil)
    },
    Check("AppPathSetting writes a JSON string through rt settings set --scope machine") { c in
        c.expectEqual(AppPathSetting.arguments(bundlePath: "/Applications/mattstack.app"),
                      ["settings", "set", "mattstack.appPath", "\"/Applications/mattstack.app\"", "--scope", "machine"])
        let args = AppPathSetting.arguments(bundlePath: "/Users/u/My \"Apps\"/mattstack.app")
        try c.requireEqual(args.count, 6)
        c.expectEqual(args[3], "\"/Users/u/My \\\"Apps\\\"/mattstack.app\"")
    },
]
