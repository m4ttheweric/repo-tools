import AppKit

// ─── Entry point ────────────────────────────────────────────────────────────

installTrayCrashHandlers()
TrayLog.info("tray launched", ["version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"])

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // Hide from Dock — menu bar only

let delegate = AppDelegate()
app.delegate = delegate
app.run()
