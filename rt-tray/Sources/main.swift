import AppKit
import MattstackCore

// ─── Entry point ────────────────────────────────────────────────────────────

installTrayCrashHandlers()
TrayLog.info("tray launched", [
    "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
    "bundle": Bundle.main.bundleIdentifier ?? "(unbundled)",
    "daemonLabel": BundleFlavor.daemonLabel,
    "dev": BundleFlavor.isDevBuild,
])

// Which flavor this machine is set to, decided before anything is bound or
// registered. A failed read means serve — the tray must never dismantle
// itself, or anyone else, on a guess.
let modeRead = FlavorModeReader.readTuple()
FlavorGateState.action = FlavorGate.decide(myFlavorIsDev: BundleFlavor.isDevBuild, modeReadResult: modeRead)
FlavorGateState.intentConfirmed = FlavorIntent.confirms(myFlavorIsDev: BundleFlavor.isDevBuild, modeReadResult: modeRead)

// Mutual exclusion FIRST (spec MAT-383 §3): if a live tray already answers on
// tray.sock, this process exits here — before AppDelegate runs and therefore
// before any SMAppService registration. A loser that registered on its way out
// would leave a second daemon agent behind.
//
// The guard is the taking-the-socket path, so a tray that is standing down
// skips it entirely: it must neither bind nor evict the flavor that owns this
// machine. AppDelegate decides what it does instead.
if case .standDown(let intended) = FlavorGateState.action {
    TrayLog.warn("intended mode belongs to the other flavor; standing down",
                 ["intended": intended, "flavor": FlavorIdentity.flavorName(isDevBuild: BundleFlavor.isDevBuild)])
} else {
    TrayServer.exitIfAnotherTrayOwnsSocket()
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // Hide from Dock — menu bar only

let delegate = AppDelegate()
app.delegate = delegate
app.run()
