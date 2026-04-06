import AppKit

// ─── Entry point ────────────────────────────────────────────────────────────

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // Hide from Dock — menu bar only

let delegate = AppDelegate()
app.delegate = delegate
app.run()
