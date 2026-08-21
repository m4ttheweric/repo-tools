import Foundation

// MARK: - BundleFlavor

/// Per-flavor identity, templated into Info.plist by build.sh (spec MAT-383
/// §1/§3). The prod and dev bundles are the same compiled binary with
/// different Info.plist values — nothing about the flavor is a compile flag,
/// so every flavor-dependent decision reads from here.
///
/// Keys:
///   MSDaemonLabel — the launchd Label this flavor owns (`com.rt.daemon`
///                   prod, `com.rt.daemon.dev` dev). DaemonLifecycle derives
///                   both the agent plist name and every launchctl label
///                   from it.
///   MSDevBuild    — true only in the dev bundle. Gates the menu-bar `dev`
///                   mark and silences UpdaterController.
enum BundleFlavor {

    /// Fallback when MSDaemonLabel is absent (an unbundled `swift run` build,
    /// or a bundle built before the key existed): the prod label, which is
    /// what every pre-MAT-383 build hardcoded.
    static let defaultDaemonLabel = "com.mattstack.daemon"

    static var daemonLabel: String {
        guard let label = Bundle.main.object(forInfoDictionaryKey: "MSDaemonLabel") as? String,
              !label.isEmpty
        else { return defaultDaemonLabel }
        return label
    }

    static var isDevBuild: Bool {
        Bundle.main.object(forInfoDictionaryKey: "MSDevBuild") as? Bool ?? false
    }
}

// MARK: - LoginItemPreference

/// The user's explicit start-at-login choice, recorded in the app's own
/// UserDefaults (per-flavor, since the bundle ids differ).
///
/// AppDelegate auto-registers `SMAppService.mainApp` at startup so a flavor
/// switch preserves start-at-login without a manual re-toggle — but an
/// explicitly disabled login item must never be re-enabled behind the user's
/// back. The panel toggle writes this flag; startup honours it.
enum LoginItemPreference {

    static let optOutKey = "MSLoginItemOptOut"

    /// True when the user turned "Start at Login" OFF themselves.
    static var isOptedOut: Bool {
        get { UserDefaults.standard.bool(forKey: optOutKey) }
        set { UserDefaults.standard.set(newValue, forKey: optOutKey) }
    }
}
