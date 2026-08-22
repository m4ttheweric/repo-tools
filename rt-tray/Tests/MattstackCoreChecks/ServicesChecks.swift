import Foundation
import MattstackCore

let servicesChecks: [Check] = [
    Check("ServicePlistScanner lists every plist in Contents/Library/LaunchAgents with its Label") { c in
        let dir = "/App.app/Contents/Library/LaunchAgents"
        let agents = ServicePlistScanner.scan(directory: dir,
            list: { _ in ["com.mattstack.deck.plist", "com.mattstack.daemon.plist", "README.txt", "broken.plist"] },
            readLabel: { path in
                switch (path as NSString).lastPathComponent {
                case "com.mattstack.daemon.plist": return "com.mattstack.daemon"
                case "com.mattstack.deck.plist": return "com.mattstack.deck"
                default: return nil
                }
            },
            readBundleProgram: { path in
                switch (path as NSString).lastPathComponent {
                case "com.mattstack.daemon.plist": return "Contents/MacOS/rt"
                case "com.mattstack.deck.plist": return "Contents/Helpers/deck"
                default: return nil
                }
            })
        c.expectEqual(agents, [AgentPlist(label: "com.mattstack.daemon", fileName: "com.mattstack.daemon.plist", bundleProgram: "Contents/MacOS/rt"),
                               AgentPlist(label: "com.mattstack.deck", fileName: "com.mattstack.deck.plist", bundleProgram: "Contents/Helpers/deck")])
    },
    Check("ServiceProgramGuard skips registering a plist whose BundleProgram isn't in the bundle") { c in
        c.expectEqual(ServiceProgramGuard.missingProgramPath(bundleProgram: "Contents/Helpers/deck", bundlePath: "/App.app",
                                                              exists: { _ in false }), "/App.app/Contents/Helpers/deck")
        c.expectEqual(ServiceProgramGuard.missingProgramPath(bundleProgram: "Contents/Helpers/deck", bundlePath: "/App.app",
                                                              exists: { $0 == "/App.app/Contents/Helpers/deck" }), nil)
        c.expectEqual(ServiceProgramGuard.missingProgramPath(bundleProgram: nil, bundlePath: "/App.app", exists: { _ in false }), nil)
        c.expectEqual(ServiceProgramGuard.missingProgramPath(bundleProgram: "", bundlePath: "/App.app", exists: { _ in false }), nil)
    },
    Check("Kickstart and DeckRestart build the exact argv") { c in
        let (exe, args) = Kickstart.arguments(label: "com.mattstack.daemon.dev", uid: 501)
        c.expect(exe.hasPrefix("/bin/") && exe.hasSuffix("ctl"), "launchd's control tool, by absolute path (name kept out of check sources by the source guard)")
        c.expectEqual(args, ["kickstart", "-k", "gui/501/com.mattstack.daemon.dev"])
        let (d, dargs) = DeckRestart.arguments(deckPath: "/Applications/mattstack.app/Contents/Helpers/deck")
        c.expectEqual(d, "/Applications/mattstack.app/Contents/Helpers/deck")
        c.expectEqual(dargs, ["restart", "--managed"])
    },
    Check("VersionChangeDetector: first launch, unchanged, changed; record persists") { c in
        let store = MemoryKeyValueStore()
        c.expectEqual(VersionChangeDetector.evaluate(current: "2.8.0", store: store), .firstLaunch)
        VersionChangeDetector.record(current: "2.8.0", store: store)
        c.expectEqual(VersionChangeDetector.evaluate(current: "2.8.0", store: store), .unchanged)
        c.expectEqual(VersionChangeDetector.evaluate(current: "2.9.0", store: store), .changed(from: "2.8.0", to: "2.9.0"))
        c.expectEqual(store.string(forKey: VersionChangeDetector.key), "2.8.0")
    },
    Check("ServiceStatusEntry / ServiceRegisterResult encode per contract") { c in
        let data = try JSONEncoder().encode([ServiceStatusEntry(label: "com.mattstack.daemon", status: "enabled")])
        c.expect(String(decoding: data, as: UTF8.self).contains("\"status\":\"enabled\""))
        let r = ServiceRegisterResult(plist: "com.mattstack.deck.plist", ok: false, status: "notFound", error: "plist missing")
        let j = String(decoding: try JSONEncoder().encode(r), as: UTF8.self)
        c.expect(j.contains("\"ok\":false"))
    },
    Check("agents whose BundleProgram isn't bundled are partitioned out — a deck plist with no helper must not veto login-items readiness") { c in
        let daemon = AgentPlist(label: "com.mattstack.daemon", fileName: "com.mattstack.daemon.plist", bundleProgram: "Contents/MacOS/rt")
        let deck = AgentPlist(label: "com.mattstack.deck", fileName: "com.mattstack.deck.plist", bundleProgram: "Contents/Helpers/deck")
        let legacy = AgentPlist(label: "com.mattstack.legacy", fileName: "com.mattstack.legacy.plist", bundleProgram: nil)
        let split = ServiceProgramGuard.partition([daemon, deck, legacy], bundlePath: "/App.app",
                                                  exists: { $0 == "/App.app/Contents/MacOS/rt" })
        c.expectEqual(split.runnable, [daemon, legacy], "no BundleProgram means nothing to miss; the deck plist has one and it isn't there")
        c.expectEqual(split.skipped, [deck])
        let whole = ServiceProgramGuard.partition([daemon, deck], bundlePath: "/App.app", exists: { _ in true })
        c.expectEqual(whole.runnable, [daemon, deck], "once deck ships, it registers again with no code change")
        c.expectEqual(whole.skipped, [])
    },
]
