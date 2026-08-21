import AppKit
import Sparkle
import MattstackCore

/// Sparkle for an LSUIElement app: gentle reminders instead of a window
/// stealing focus, a menu item bound to canCheckForUpdates, silent install
/// when idle, and nothing at all in the dev flavor.
final class UpdaterController: NSObject, UpdateChecking, SPUUpdaterDelegate, SPUStandardUserDriverDelegate, @unchecked Sendable {
    @objc dynamic private(set) var canCheckForUpdates = false
    var onUpdateAvailable: ((String) -> Void)?
    private let isBusy: () -> Bool
    private let enabled: Bool
    private var controller: SPUStandardUpdaterController?
    private var observation: NSKeyValueObservation?

    private let feedOverride: String?

    init(isDevBuild: Bool, isBusy: @escaping () -> Bool) {
        self.isBusy = isBusy
        let info = Bundle.main.infoDictionary
        feedOverride = UpdatePolicy.feedOverride(environment: ProcessInfo.processInfo.environment,
                                                 arguments: CommandLine.arguments, isDevBuild: isDevBuild)
        enabled = UpdatePolicy.shouldStartUpdater(isDevBuild: isDevBuild,
                                                  publicEDKey: info?["SUPublicEDKey"] as? String,
                                                  feedURL: info?["SUFeedURL"] as? String,
                                                  feedOverride: feedOverride)
        if let feedOverride { TrayLog.info("appcast override in force", ["url": feedOverride]) }
        super.init()
        guard enabled else {
            TrayLog.info("update check skipped (dev build)", ["dev": isDevBuild])
            return
        }
        let c = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: self)
        controller = c
        observation = c.updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] updater, _ in
            self?.canCheckForUpdates = updater.canCheckForUpdates
        }
    }

    var automaticallyChecks: Bool {
        get { controller?.updater.automaticallyChecksForUpdates ?? false }
        set { controller?.updater.automaticallyChecksForUpdates = newValue }
    }
    var isEnabled: Bool { enabled }

    @objc func checkForUpdatesFromMenu() { controller?.checkForUpdates(nil) }

    func checkForUpdates() async -> Bool {
        guard let c = controller else { return false }
        await MainActor.run { c.updater.checkForUpdates() }
        return true
    }

    // MARK: SPUStandardUserDriverDelegate — gentle reminders

    var supportsGentleScheduledUpdateReminders: Bool { true }

    func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool) -> Bool {
        immediateFocus
    }

    func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
        if !handleShowingUpdate || state.userInitiated == false {
            DispatchQueue.main.async { self.onUpdateAvailable?(update.displayVersionString) }
        }
    }

    func standardUserDriverWillFinishUpdateSession() {
        DispatchQueue.main.async { self.onUpdateAvailable?("") }
    }

    // MARK: SPUUpdaterDelegate — feed override, install when idle

    func feedURLString(for updater: SPUUpdater) -> String? { feedOverride }

    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        let idle = UpdatePolicy.allowsImmediateInstall(setupRunning: isBusy(),
                                                       windowsOpen: NSApp.windows.filter { $0.isVisible }.count)
        if idle { DispatchQueue.main.async { immediateInstallHandler() } }
        return idle
    }
}
