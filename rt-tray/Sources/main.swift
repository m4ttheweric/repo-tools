import AppKit

// ─── Entry point ────────────────────────────────────────────────────────────

installTrayCrashHandlers()
TrayLog.info("tray launched", [
    "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
    "bundle": Bundle.main.bundleIdentifier ?? "(unbundled)",
    "daemonLabel": BundleFlavor.daemonLabel,
    "dev": BundleFlavor.isDevBuild,
])

// Mutual exclusion FIRST (spec MAT-383 §3): if a live tray already answers on
// tray.sock, this process exits here — before AppDelegate runs and therefore
// before any SMAppService registration. A loser that registered on its way out
// would leave a second daemon agent behind.
TrayServer.exitIfAnotherTrayOwnsSocket()

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // Hide from Dock — menu bar only

let delegate = AppDelegate()
app.delegate = delegate
app.run()
