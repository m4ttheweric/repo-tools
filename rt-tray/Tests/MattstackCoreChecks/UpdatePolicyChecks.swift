import Foundation
import MattstackCore

let updatePolicyChecks: [Check] = [
    Check("Sparkle starts only for prod builds with a real key and feed") { c in
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: true, publicEDKey: "abc", feedURL: "https://x/appcast.xml", feedOverride: nil), false)
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: false, publicEDKey: UpdatePolicy.placeholderKey, feedURL: "https://x/appcast.xml", feedOverride: nil), false)
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: false, publicEDKey: "", feedURL: "https://x/appcast.xml", feedOverride: nil), false)
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: false, publicEDKey: "abc", feedURL: nil, feedOverride: nil), false)
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: false, publicEDKey: "abc", feedURL: "https://x/appcast.xml", feedOverride: nil), true)
    },
    Check("appcast override: env honoured only in dev flavor or with --allow-appcast-override; starts the updater but never without a real key") { c in
        let env = [UpdatePolicy.overrideEnv: "http://127.0.0.1:8000/appcast.xml"]
        c.expectEqual(UpdatePolicy.feedOverride(environment: env, arguments: ["mattstack"], isDevBuild: false), nil)
        c.expectEqual(UpdatePolicy.feedOverride(environment: env, arguments: ["mattstack"], isDevBuild: true), "http://127.0.0.1:8000/appcast.xml")
        c.expectEqual(UpdatePolicy.feedOverride(environment: env, arguments: ["mattstack", UpdatePolicy.overrideFlag], isDevBuild: false), "http://127.0.0.1:8000/appcast.xml")
        c.expectEqual(UpdatePolicy.feedOverride(environment: [:], arguments: [UpdatePolicy.overrideFlag], isDevBuild: true), nil)
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: true, publicEDKey: "abc", feedURL: nil, feedOverride: "http://127.0.0.1:8000/appcast.xml"), true)
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: true, publicEDKey: UpdatePolicy.placeholderKey, feedURL: nil, feedOverride: "http://127.0.0.1:8000/appcast.xml"), false)
    },
    Check("immediate install only when idle: no setup running, no windows") { c in
        c.expectEqual(UpdatePolicy.allowsImmediateInstall(setupRunning: false, windowsOpen: 0), true)
        c.expectEqual(UpdatePolicy.allowsImmediateInstall(setupRunning: true, windowsOpen: 0), false)
        c.expectEqual(UpdatePolicy.allowsImmediateInstall(setupRunning: false, windowsOpen: 1), false)
    },
]
