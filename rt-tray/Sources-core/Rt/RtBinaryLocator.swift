import Foundation

/// Where the app's rt lives. Order: the DEBUG-only stub override, then
/// per flavor — dev resolves only its source wrapper (never the bundled
/// shim), prod resolves only its bundled binary. Returns nil rather than
/// guessing at a PATH lookup.
public enum RtBinaryLocator {
    public static func resolve(bundlePath: String, isDevBuild: Bool, isDebugBuild: Bool,
                               environment: [String: String], home: String,
                               fileExists: (String) -> Bool) -> RtLocation? {
        if isDebugBuild,
           let scenario = environment["RT_STUB_SCENARIO"], !scenario.isEmpty,
           let stub = environment["RT_STUB_PATH"], !stub.isEmpty {
            let bun = environment["RT_STUB_BUN"] ?? "\(home)/.bun/bin/bun"
            return RtLocation(executable: URL(fileURLWithPath: bun), argumentPrefix: [stub], source: .stub)
        }
        if isDevBuild {
            let wrapper = "\(home)/.local/bin/rt"
            if fileExists(wrapper) {
                return RtLocation(executable: URL(fileURLWithPath: wrapper), argumentPrefix: [], source: .devWrapper)
            }
            // The dev bundle's Contents/MacOS/rt is the DAEMON SHIM — invoking
            // it as a CLI starts a rogue daemon. No wrapper ⇒ no CLI.
            return nil
        }
        let bundled = "\(bundlePath)/Contents/MacOS/rt"
        if fileExists(bundled) {
            return RtLocation(executable: URL(fileURLWithPath: bundled), argumentPrefix: [], source: .bundled)
        }
        return nil
    }
}
