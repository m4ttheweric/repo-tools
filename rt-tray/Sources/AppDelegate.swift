import AppKit
import UserNotifications
import ServiceManagement
import Network
import SwiftUI
import MattstackCore

// MARK: - AppDelegate

// `VersionProviding` (a `Sendable` protocol, adopted below) lets `TrayRoutes`
// call `versionInfo()` from its own async route-handling `Task`, off the main
// actor — the only member of this class ever reached off-main, and it only
// reads immutable process-global state (`Bundle.main`, `BundleFlavor`).
// `@unchecked` because the compiler can't see that from the conformance site.
class AppDelegate: NSObject, NSApplicationDelegate, @unchecked Sendable {

    // ── Menu bar ────────────────────────────────────────────────────────────
    private var statusItem: NSStatusItem!

    // ── Daemon communication ────────────────────────────────────────────────
    private let daemonClient = DaemonClient()
    private let notificationManager = NotificationManager()
    private let daemonLifecycle = DaemonLifecycle()

    // ── Polling timers ──────────────────────────────────────────────────────
    private var statusTimer: Timer?
    private var notificationTimer: Timer?

    // ── Process panel ──────────────────────────────────────────────────────
    private var processPopover: NSPopover?
    private var processWindow: NSWindow?
    private var keyboardConflictWindow: NSWindow?

    // ── State ───────────────────────────────────────────────────────────────
    private var currentHealth: DaemonHealth = .unknown
    // `lazy`: constructing it starts Sparkle (when enabled). A translocated
    // or DMG-mounted launch returns before `buildServices()` (the first
    // touch) ever runs, so Sparkle never spins up on a copy that's about to
    // be told to quit. Stub mode counts as a dev build here too -- the
    // placeholder SUPublicEDKey already blocks Sparkle in every build this
    // repo produces, but a future real key must not revive it under the
    // stub-driven UI-test/QA harness.
    lazy var updater = UpdaterController(isDevBuild: BundleFlavor.isDevBuild || BundleFlavor.isStubActive, isBusy: { SetupSession.isRunning })
    private var updaterObservation: NSKeyValueObservation?

    // ── Setup / Settings / rt ────────────────────────────────────────────────
    private var permissionsService: PermissionsService!
    private var servicesRegistrar: ServicesRegistrar!
    private var needBroker: NeedBroker!
    private var coordinator: SetupCoordinator?
    private var rtClient: RtClient?
    /// A `mattstack://join/<code>` event can arrive before `buildServices()`
    /// builds the coordinator (launch-by-link). Stashed here and drained at
    /// the end of `buildServices()`.
    private var pendingJoinCode: String?
    /// The stand-down route is decided once, by whichever of the settings
    /// answer and its backstop gets there first.
    @MainActor private var standDownRouted = false

    // MARK: - Lifecycle

    /// Registered ahead of the first event so a `mattstack://join/<code>` link
    /// used to launch the app (not just to activate an already-running one)
    /// still reaches `handleGetURL`.
    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleGetURL(_:with:)),
                                                     forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if LaunchGuard.isTranslocatedOrOnRemovableVolume(bundlePath: Bundle.main.bundlePath) {
            showMoveToApplicationsAlert()
            return
        }
        // The launch event is only current while AppKit is dispatching it, so
        // the origin is read here rather than anywhere downstream.
        if case .standDown(let intended) = FlavorGateState.action {
            standDown(intended: intended, origin: TrayLaunchOrigin.current())
            return
        }
        startNormalOperation()
    }

    /// Everything a serving tray does at launch. Reachable a second time from
    /// the mismatch alert: after a switch this process IS the intended flavor,
    /// and re-`open`ing the bundle would only activate the process that is
    /// already running.
    @MainActor
    private func startNormalOperation() {
        buildServices()
        installMainMenu()
        setupMenuBar()
        setupNotifications()
        setupTrayServer()
        startPolling()
        setupAutoUpdate()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(showProcessPanel),
            name: .showProcessPanel,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(detachProcessPanel),
            name: .detachProcessPanel,
            object: nil
        )

        // Gear-menu actions posted by the panel's status strip
        NotificationCenter.default.addObserver(
            self, selector: #selector(restartDaemon), name: .rtRestartDaemon, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(stopDaemon), name: .rtStopDaemon, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(viewDaemonLogs), name: .rtViewDaemonLogs, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(checkForUpdates), name: .rtCheckUpdates, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(showKeyboardConflictWindow), name: .showKeyboardConflict, object: nil)

        // Setup / Settings surfaces, posted by the gear menu and the Done screen
        NotificationCenter.default.addObserver(self, selector: #selector(showSetupStatus), name: .rtShowSetupStatus, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(showSettings), name: .rtShowSettings, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(showUninstall), name: .rtShowUninstall, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(showSettingsTeam), name: .rtShowSettingsTeam, object: nil)

        checkMissionControlConflict()
        autoRegisterLoginItem()

        Task { @MainActor in
            setHealth(.starting)
            if BundleFlavor.isStubActive {
                TrayLog.info("stub mode: skipping real service registration and version-change restart")
            } else {
                servicesRegistrar.registerAll()
                let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
                let change = await servicesRegistrar.handleVersionChange(current: version, store: UserDefaults.standard)
                TrayLog.info("version change evaluated", ["change": String(describing: change)])
            }
            await recordAppPath()

            // First-run Setup has no daemon dependency — show it now rather
            // than after the wait loop below, or a genuine first run (daemon
            // not installed yet) sits at a blank menu bar for the full 4s.
            if let coordinator, !coordinator.setupIsComplete { coordinator.showSetup() }

            // Wait for launchd to bring the daemon up
            for _ in 0..<8 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                if await daemonClient.isReachable() { break }
            }
            await refreshStatus()
            await drainPendingNotifications()
        }
    }

    // MARK: - Flavor stand-down

    /// This Mac is set to the other flavor.
    ///
    /// A login-item launch is the app coming back on its own, so it can retire
    /// itself without asking — but only when the user will see that it did and
    /// the flavor taking over is actually installed. Every other launch, every
    /// launch this process could not identify, and every case where one of
    /// those two conditions fails, hands the decision to the user instead:
    /// unregistering the daemon agent and the login item behind someone's back
    /// costs them a trip through System Settings to undo.
    @MainActor
    private func standDown(intended: String, origin: LaunchOrigin) {
        let myFlavor = FlavorIdentity.flavorName(isDevBuild: BundleFlavor.isDevBuild)
        let bundle = FlavorBundle.presence(ofFlavor: intended, home: AppHome.current,
                                           fileExists: { FileManager.default.fileExists(atPath: $0) })
        StandDownNotice.isAuthorized { authorized in
            Task { @MainActor in
                self.routeStandDown(intended: intended, myFlavor: myFlavor, origin: origin,
                                    bundle: bundle, notificationsAuthorized: authorized)
            }
        }
        // A launch that stands down has no menu bar and no window: if the
        // notification centre never answers, nothing would ever route and the
        // app would sit invisible forever. The backstop routes it the safe
        // way, and whichever arrives first wins.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            routeStandDown(intended: intended, myFlavor: myFlavor, origin: origin,
                           bundle: bundle, notificationsAuthorized: false)
        }
    }

    @MainActor
    private func routeStandDown(intended: String, myFlavor: String, origin: LaunchOrigin,
                                bundle: BundlePresence, notificationsAuthorized: Bool) {
        guard !standDownRouted else { return }
        standDownRouted = true
        let route = StandDownPlan.route(origin: origin, notificationsAuthorized: notificationsAuthorized,
                                        intendedBundle: bundle)
        TrayLog.info("flavor stand-down", ["intended": intended, "flavor": myFlavor,
                                           "origin": String(describing: origin),
                                           "notifications": notificationsAuthorized,
                                           "intendedBundle": String(describing: bundle),
                                           "route": String(describing: route)])
        switch route {
        case .alert:
            showFlavorMismatchAlert(intended: intended, myFlavor: myFlavor,
                                    intendedBundle: bundle, resumeStartup: true)
        case .silent:
            retireSelf(intended: intended, myFlavor: myFlavor)
        }
    }

    @MainActor
    private func retireSelf(intended: String, myFlavor: String) {
        daemonLifecycle.stopDaemon()
        do {
            try SMAppService.mainApp.unregister()
        } catch {
            // Unregistering an already-unregistered login item throws; the
            // status logged below is the ground truth.
            TrayLog.warn("login item unregister failed", ["err": String(describing: error)])
        }
        TrayLog.info("stood down", ["daemon": TrayServer.statusName(daemonLifecycle.status),
                                    "loginItem": TrayServer.statusName(SMAppService.mainApp.status)])
        // The notification is the only trace this leaves, so the quit waits
        // for delivery — with a backstop for a callback that never comes.
        StandDownNotice.post(title: FlavorStandDownCopy.notificationTitle(myFlavor: myFlavor),
                             body: FlavorStandDownCopy.notificationBody(intended: intended),
                             identifier: "mattstack-flavor-stand-down") {
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { NSApp.terminate(nil) }
    }

    /// `resumeStartup` is false for a tray that is already serving (the
    /// failed-read re-check): a switch in its favour changes nothing about a
    /// launch it already completed, and running the startup path twice would
    /// double every timer, observer and registration.
    @MainActor
    private func showFlavorMismatchAlert(intended: String, myFlavor: String,
                                         intendedBundle: BundlePresence, resumeStartup: Bool) {
        let alert = NSAlert()
        alert.messageText = FlavorStandDownCopy.alertTitle(intended: intended)
        alert.informativeText = FlavorStandDownCopy.alertBody(myFlavor: myFlavor, intended: intended)
            + (intendedBundle.isPresent ? "" : FlavorStandDownCopy.missingBundleNote(intended: intended))
        alert.addButton(withTitle: FlavorStandDownCopy.switchButton(myFlavor: myFlavor))
        alert.addButton(withTitle: FlavorStandDownCopy.quitButton)
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else {
            TrayLog.info("flavor mismatch: quit", ["intended": intended])
            NSApp.terminate(nil)
            return
        }
        switchIntendedFlavor(to: myFlavor, resumeStartup: resumeStartup)
    }

    /// Run the real toggle, which writes the intended mode AND retires, quits
    /// and hands the CLI over from the other flavor — then take the socket and
    /// start serving in place.
    @MainActor
    private func switchIntendedFlavor(to myFlavor: String, resumeStartup: Bool) {
        guard let rt = RtClientFactory.make() else {
            reportSwitchFailure("mattstack could not find its rt command, so it can't switch this Mac to \(myFlavor).",
                                fatal: resumeStartup)
            return
        }
        Task { @MainActor in
            let verb = "settings dev-mode"
            do {
                let r = try await rt.run(["settings", "dev-mode", myFlavor], stdin: nil)
                guard r.exitCode == 0 else {
                    reportSwitchFailure(r.userError?.message ?? r.failureCopy(verb: verb), fatal: resumeStartup)
                    return
                }
            } catch {
                reportSwitchFailure((error as? RtClientError)?.copy ?? "rt \(verb) failed to start.", fatal: resumeStartup)
                return
            }
            TrayLog.info("flavor switched", ["flavor": myFlavor, "resumeStartup": resumeStartup])
            FlavorGateState.action = .serve
            FlavorGateState.intentConfirmed = true
            FlavorGateState.readFailed = false
            guard resumeStartup else { return }
            switch TrayServer.claimSocket() {
            case .claimed:
                startNormalOperation()
            case .heldByPeer(let flavor), .heldByStuckHolder(let flavor):
                reportSwitchFailure(FlavorStandDownCopy.stuckHolderBody(holderFlavor: flavor, myFlavor: myFlavor),
                                    fatal: true)
            }
        }
    }

    /// `fatal` distinguishes a failure during launch — nothing is running, so
    /// quitting is the honest end — from one raised by an already-serving tray,
    /// which keeps working with the mode it has.
    @MainActor
    private func reportSwitchFailure(_ message: String, fatal: Bool) {
        TrayLog.error("flavor switch failed", ["err": message, "fatal": fatal])
        let alert = NSAlert()
        alert.messageText = "The switch didn't finish"
        alert.informativeText = message
        alert.addButton(withTitle: fatal ? FlavorStandDownCopy.quitButton : "OK")
        alert.runModal()
        if fatal { NSApp.terminate(nil) }
    }

    /// A launch whose mode read failed served on an assumption; ask once
    /// more at the next activation. Login-item confidence is stale by then,
    /// so a mismatch found here can only ever take the alert, never the
    /// silent path.
    func applicationDidBecomeActive(_ notification: Notification) {
        guard FlavorGateState.readFailed, !FlavorGateState.recheckStarted else { return }
        FlavorGateState.recheckStarted = true
        DispatchQueue.global(qos: .utility).async {
            let read = FlavorModeReader.readTuple()
            let action = FlavorGate.decide(myFlavorIsDev: BundleFlavor.isDevBuild, modeReadResult: read)
            let confirmed = FlavorIntent.confirms(myFlavorIsDev: BundleFlavor.isDevBuild, modeReadResult: read)
            Task { @MainActor in
                FlavorGateState.readFailed = read == nil
                FlavorGateState.intentConfirmed = confirmed
                guard case .standDown(let intended) = action else { return }
                let myFlavor = FlavorIdentity.flavorName(isDevBuild: BundleFlavor.isDevBuild)
                TrayLog.warn("mode re-read says this Mac belongs to the other flavor",
                             ["intended": intended, "flavor": myFlavor])
                let bundle = FlavorBundle.presence(ofFlavor: intended, home: AppHome.current,
                                                   fileExists: { FileManager.default.fileExists(atPath: $0) })
                self.showFlavorMismatchAlert(intended: intended, myFlavor: myFlavor,
                                             intendedBundle: bundle, resumeStartup: false)
            }
        }
    }

    @MainActor
    private func buildServices() {
        permissionsService = PermissionsService(bundleId: Bundle.main.bundleIdentifier ?? "com.mattstack.app",
                                                agentStatuses: { [weak self] in self?.servicesRegistrar.smStatuses() ?? [] },
                                                runner: SystemCommandRunner())
        servicesRegistrar = ServicesRegistrar(bundlePath: Bundle.main.bundlePath, runner: SystemCommandRunner())
        daemonLifecycle.services = servicesRegistrar
        let privileged = PrivilegedInstaller(bundlePath: Bundle.main.bundlePath, escalator: AuthorizationServicesEscalator())
        // Stub mode never lets a real provider reach a mutating/probing call.
        #if DEBUG
        let servicesForNeeds: ServicesProviding = BundleFlavor.isStubActive ? StubServicesProvider() : servicesRegistrar
        let privilegedForNeeds: PrivilegedInstalling = BundleFlavor.isStubActive ? StubPrivilegedInstaller() : privileged
        let permissionProbe: PermissionProbing? = BundleFlavor.isStubActive ? StubPermissionProbe() : nil
        #else
        let servicesForNeeds: ServicesProviding = servicesRegistrar
        let privilegedForNeeds: PrivilegedInstalling = privileged
        let permissionProbe: PermissionProbing? = nil
        #endif
        needBroker = NeedBroker(services: servicesForNeeds, privileged: privilegedForNeeds)
        // Assigned here, in buildServices(), and not in setupTrayServer():
        // applicationDidFinishLaunching runs buildServices() before it starts
        // the listener, so no connection can arrive while `routes` is still
        // nil and fall through to the legacy 404 handler.
        TrayServer.shared.routes = TrayRoutes(permissions: permissionsService, services: servicesForNeeds, privileged: privilegedForNeeds,
                                              needs: needBroker, updater: updater, version: self)
        rtClient = RtClientFactory.make()
        if let rt = rtClient {
            coordinator = SetupCoordinator(rt: rt, permissions: permissionsService, permissionProbe: permissionProbe, needs: needBroker, updater: updater)
            if let code = pendingJoinCode {
                pendingJoinCode = nil
                coordinator?.handleJoin(code: code)
            }
        } else if pendingJoinCode != nil {
            pendingJoinCode = nil
            TrayLog.warn("mattstack://join link received but rt could not be resolved; dropping")
        }
        updaterObservation = updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { u, _ in
            DispatchQueue.main.async { TrayState.shared.canCheckForUpdates = u.canCheckForUpdates }
        }
    }

    /// The machine store learns where this bundle lives, every launch — rt
    /// owns the store, so the app only ever writes through `rt settings set`.
    private func recordAppPath() async {
        guard let rt = rtClient else { return }
        do {
            let r = try await rt.run(AppPathSetting.arguments(bundlePath: Bundle.main.bundlePath), stdin: nil)
            if r.exitCode != 0 {
                TrayLog.warn("mattstack.appPath write failed", ["exit": Int(r.exitCode), "err": r.userError?.message ?? r.failureCopy(verb: "settings set")])
            }
        } catch {
            TrayLog.warn("mattstack.appPath write failed to start", ["err": (error as? RtClientError)?.copy ?? "rt settings set failed to start."])
        }
    }

    /// The App menu carries the only global keyboard shortcut an LSUIElement
    /// app can offer (there is no Window menu): ⌘, opens Settings whenever
    /// any window is key, matching every other Mac app.
    private func installMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        let settingsItem = appMenu.addItem(withTitle: "Settings…", action: #selector(showSettings), keyEquivalent: ",")
        settingsItem.setAccessibilityIdentifier(AXID.menuAppSettings)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit mattstack", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }

    /// Gatekeeper's translocation and a DMG mount both make SMAppService and
    /// Sparkle unusable — the only recovery is a real, on-disk copy.
    private func showMoveToApplicationsAlert() {
        let alert = NSAlert()
        alert.messageText = "Move mattstack to Applications"
        alert.informativeText = "mattstack is running from a disk image or a temporary location, so it can't register its background services. Drag mattstack.app to /Applications (or ~/Applications) and open it from there."
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }

    @objc private func handleGetURL(_ event: NSAppleEventDescriptor, with reply: NSAppleEventDescriptor) {
        guard let s = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue, let url = URL(string: s) else { return }
        guard let code = JoinLink.code(from: url) else {
            // Never the raw string: an unrecognized URL can carry a
            // malformed invite code in its path.
            TrayLog.warn("ignored URL", ["scheme": url.scheme ?? "", "host": url.host ?? ""])
            return
        }
        Task { @MainActor in
            guard let coordinator else {
                // Launch-by-link: the kAEGetURL event can arrive before
                // buildServices() constructs the coordinator. buildServices()
                // drains this once it exists.
                pendingJoinCode = code
                return
            }
            coordinator.handleJoin(code: code)
        }
    }

    @objc private func showSetupStatus() { Task { @MainActor in coordinator?.openSetupStatus() } }
    @objc private func showSettings() { Task { @MainActor in coordinator?.showSettings() } }
    @objc private func showUninstall() { Task { @MainActor in coordinator?.showSettings(pane: .uninstall) } }
    @objc private func showSettingsTeam() { Task { @MainActor in coordinator?.showSettings(pane: .team) } }

    func applicationWillTerminate(_ notification: Notification) {
        statusTimer?.invalidate()
        notificationTimer?.invalidate()
        TrayServer.shared.stop()
    }

    // MARK: - Login Item

    /// Idempotent start-at-login registration (spec MAT-383 §3).
    ///
    /// A flavor switch installs a DIFFERENT bundle id, so the outgoing
    /// flavor's login item does nothing for the incoming one — without this
    /// the user has to re-toggle "Start at Login" by hand after every
    /// `rt settings dev-mode on|off`.
    ///
    /// The user's own choice still wins: the panel toggle records an opt-out
    /// when they switch it OFF, and an explicitly disabled login item is
    /// never re-enabled here. Only `.notRegistered` is acted on —
    /// `.requiresApproval` is the user's pending decision in System Settings
    /// and re-registering would not change it.
    private func autoRegisterLoginItem() {
        guard !BundleFlavor.isStubActive else {
            TrayLog.info("login item auto-register skipped (stub mode)")
            return
        }
        guard !LoginItemPreference.isOptedOut else {
            TrayLog.info("login item auto-register skipped (user opted out)")
            return
        }
        let status = SMAppService.mainApp.status
        guard status == .notRegistered else { return }
        do {
            try SMAppService.mainApp.register()
            TrayLog.info("login item auto-registered",
                         ["status": TrayServer.statusName(SMAppService.mainApp.status)])
        } catch {
            TrayLog.error("login item auto-register failed", ["err": String(describing: error)])
        }
    }

    // MARK: - Menu Bar Setup

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateMenuBarTitle(status: .unknown)

        // Single-view design: any click on the status item toggles the
        // process popover. All former menu actions live in the panel's
        // status strip / gear menu.
        if let button = statusItem.button {
            button.action = #selector(showProcessPanel)
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
    }

    /// Update the menu bar button with "m" text + colored status dot.
    private func updateMenuBarTitle(status: DaemonHealth) {
        guard let button = statusItem.button else { return }

        let dotColor: NSColor
        switch status {
        case .healthy:
            dotColor = .systemGreen
        case .starting:
            dotColor = .systemYellow
        case .warning:
            dotColor = .systemOrange
        case .degraded:
            dotColor = .systemPink
        case .down:
            dotColor = .systemRed
        case .unknown:
            dotColor = .tertiaryLabelColor
        }

        let attributed = NSMutableAttributedString()

        // "m" in monospace — matches the app icon's wordmark
        let mAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .medium),
            .foregroundColor: NSColor.labelColor,
        ]
        attributed.append(NSAttributedString(string: "m", attributes: mAttrs))

        // Stacked-layers mark trailing the "m" — the SF Symbol closest to the
        // app icon's lucide "layers" glyph. Embedded as a text attachment so
        // it sits between the wordmark and the dev tag / status dot; palette
        // labelColor keeps it tracking menu bar light/dark like the "m" (the
        // flavor colors belong to the app icon only).
        if let symbol = NSImage(systemSymbolName: "square.3.layers.3d", accessibilityDescription: "stack")
            ?? NSImage(systemSymbolName: "square.stack.3d.up", accessibilityDescription: "stack") {
            let config = NSImage.SymbolConfiguration(pointSize: 10, weight: .medium)
                .applying(NSImage.SymbolConfiguration(paletteColors: [.labelColor]))
            let attachment = NSTextAttachment()
            attachment.image = symbol.withSymbolConfiguration(config) ?? symbol
            let mark = NSMutableAttributedString(attributedString: NSAttributedString(attachment: attachment))
            mark.addAttribute(.baselineOffset, value: -0.5, range: NSRange(location: 0, length: mark.length))
            attributed.append(NSAttributedString(string: " "))
            attributed.append(mark)
        }

        // Dev flavor wears a visible mark (spec MAT-383 §3) — the dev and
        // prod trays are otherwise identical in the menu bar, and mistaking
        // one for the other is how you debug the wrong daemon.
        if BundleFlavor.isDevBuild {
            let devAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 9, weight: .semibold),
                .foregroundColor: NSColor.systemOrange,
            ]
            attributed.append(NSAttributedString(string: " dev", attributes: devAttrs))
        }

        // Space
        attributed.append(NSAttributedString(string: " "))

        // Colored dot
        let dotAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 8),
            .foregroundColor: dotColor,
        ]
        attributed.append(NSAttributedString(string: "●", attributes: dotAttrs))

        button.attributedTitle = attributed
    }

    // MARK: - Health Management

    private func setHealth(_ health: DaemonHealth) {
        currentHealth = health
        updateMenuBarTitle(status: health)
        TrayState.shared.health = health
        switch health {
        case .starting:
            TrayState.shared.statusText = "Daemon: starting…"
            TrayState.shared.needsApproval = false
        case .down:
            switch daemonLifecycle.status {
            case .requiresApproval:
                TrayState.shared.statusText = "Daemon: needs approval in Login Items"
                TrayState.shared.bootVerdict = nil
            case .notRegistered, .notFound:
                TrayState.shared.statusText = "Daemon: not registered"
                TrayState.shared.bootVerdict = nil
            case .enabled:
                // launchd considers the job registered and enabled, yet
                // `ping` isn't answering — alive but not serving, the third
                // named verdict (S026), distinct from "not registered".
                TrayState.shared.statusText = "Daemon: alive but not serving"
                TrayState.shared.bootVerdict = "alive but not serving"
            default:
                TrayState.shared.statusText = "Daemon: not running"
                TrayState.shared.bootVerdict = nil
            }
            TrayState.shared.needsApproval = needsLoginItemApproval()
        default:
            break
        }
    }

    /// The worst status across every agent this bundle registers (daemon,
    /// deck, …), not just the daemon — a single-agent check would miss a
    /// second agent stuck in Login Items while the daemon itself is fine.
    private func needsLoginItemApproval() -> Bool {
        PermissionsService.combinedLoginItems(servicesRegistrar?.smStatuses() ?? []) == "requiresApproval"
    }

    // MARK: - Actions

    @objc private func restartDaemon() {
        Task { @MainActor in
            setHealth(.starting)

            await daemonLifecycle.restartDaemon()

            // Poll until it comes back (up to 8s)
            for _ in 0..<16 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                if await daemonClient.isReachable() {
                    await refreshStatus()
                    return
                }
            }
            setHealth(.down)
        }
    }

    @objc private func stopDaemon() {
        Task { @MainActor in
            // Unregister from launchd — the agent has KeepAlive=true, so an
            // HTTP shutdown alone would be undone by a launchd restart.
            // Unregistering makes launchd SIGTERM the daemon and keep it down.
            daemonLifecycle.stopDaemon()
            try? await Task.sleep(nanoseconds: 500_000_000)
            setHealth(.down)
        }
    }

    /// Open the logdy-based daemon log viewer in the user's default browser.
    /// If logdy is already serving on :5544 (e.g. previous click), just opens
    /// the URL. Otherwise spawns `rt daemon logs` via a login shell so it
    /// picks up the user's PATH (rt-tray inherits launchd's minimal PATH).
    @objc private func viewDaemonLogs() {
        let url = URL(string: "http://localhost:5544")!
        Task { @MainActor in
            if await self.isLogdyUp() {
                NSWorkspace.shared.open(url)
                return
            }
            self.spawnRtDaemonLogs()
            // Poll until logdy answers, up to ~4s, then open.
            for _ in 0..<20 {
                try? await Task.sleep(nanoseconds: 200_000_000)
                if await self.isLogdyUp() {
                    NSWorkspace.shared.open(url)
                    return
                }
            }
            // Fallback: open the URL anyway — user sees a connection error if
            // logdy never came up (e.g. logdy not installed).
            NSWorkspace.shared.open(url)
        }
    }

    /// Probe localhost:5544 with a short TCP connect.
    private func isLogdyUp() async -> Bool {
        return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            let conn = NWConnection(host: "127.0.0.1", port: 5544, using: .tcp)
            // Serialize resume checks — the state handler and the timeout run on
            // independent queues, and racing them can double-resume (a crash).
            let guardQueue = DispatchQueue(label: "rt.logdy-probe")
            var resumed = false
            let finish: (Bool) -> Void = { result in
                guardQueue.sync {
                    guard !resumed else { return }
                    resumed = true
                    conn.cancel()
                    cont.resume(returning: result)
                }
            }
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finish(true)
                case .failed:
                    finish(false)
                default: break
                }
            }
            conn.start(queue: .global())
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
                finish(false)
            }
        }
    }

    /// Spawn `rt daemon logs` detached. Uses the installed CLI at
    /// ~/.local/bin/rt (wrapper script in dev mode, binary in prod), else this
    /// bundle's own embedded daemon binary, else a login-shell PATH lookup.
    ///
    /// Logdy stays running in the background after this method returns;
    /// it's killed only if the user Ctrl-Cs the spawned rt OR the rt-tray
    /// app group is terminated.
    private func spawnRtDaemonLogs() {
        let home = AppHome.current
        let candidates = [
            "\(home)/.local/bin/rt",
            Bundle.main.bundlePath + "/Contents/MacOS/rt",
        ]
        let rtBin = candidates.first { FileManager.default.isExecutableFile(atPath: $0) }

        let task = Process()
        if let rtBin = rtBin {
            task.executableURL = URL(fileURLWithPath: rtBin)
            task.arguments = ["daemon", "logs"]
        } else {
            // Last-resort PATH lookup via login shell.
            task.executableURL = URL(fileURLWithPath: "/bin/zsh")
            task.arguments = ["-lc", "exec rt daemon logs"]
            TrayLog.warn("no rt binary found in known locations; falling back to PATH lookup")
        }
        TrayLog.spawnLoggedDetached(task, label: "rt daemon logs")
    }

    @objc private func checkForUpdates() {
        updater.checkForUpdatesFromMenu()
    }

    @objc private func showProcessPanel() {
        if processPopover == nil {
            let popover = NSPopover()
            popover.contentSize = NSSize(width: 900, height: 600)
            popover.contentViewController = NSHostingController(rootView: ProcessPanelView())
            popover.behavior = .transient
            processPopover = popover
        }

        if let popover = processPopover {
            if popover.isShown {
                popover.performClose(nil)
            } else if let button = statusItem.button {
                NSApp.activate(ignoringOtherApps: true)
                popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
                popover.contentViewController?.view.window?.makeKey()
            }
        }
    }

    @objc private func detachProcessPanel() {
        processPopover?.performClose(nil)

        if let window = processWindow {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "mattstack processes"
        window.contentViewController = NSHostingController(rootView: ProcessPanelView(isDetached: true))
        // Setting contentViewController shrinks the window to the SwiftUI
        // view's fitting size (its 600x400 minimum); re-apply the intended
        // size after. The autosave name then keeps the user's own size and
        // position across pop-outs, once one exists.
        window.setContentSize(NSSize(width: 1000, height: 700))
        window.center()
        window.setFrameAutosaveName("rt-process-panel")
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        processWindow = window
    }

    // MARK: - Auto-Update

    private func setupAutoUpdate() {
        updater.onUpdateAvailable = { version in
            TrayState.shared.updateAvailable = version.isEmpty ? nil : version
        }
    }

    // MARK: - Polling

    private func startPolling() {
        statusTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { await self?.refreshStatus() }
        }

        notificationTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { await self?.drainPendingNotifications() }
        }
    }

    private var isRefreshing = false
    private var consecutiveStatusFailures = 0
    /// Derived from the last successful poll's `uptime`; used to tell a
    /// stale crash/log artifact from a current one (S029) without needing
    /// to touch the daemon-side writer.
    private var lastKnownDaemonStartedAt: Date?

    /// Main-actor so `isRefreshing` and all menu/UI mutations are serialized;
    /// the daemon queries themselves still run off-main across the awaits.
    @MainActor
    private func refreshStatus() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        guard let status = await daemonClient.queryTrayStatus() else {
            consecutiveStatusFailures += 1
            // A single missed poll is usually a transient daemon stall, not an
            // outage — hold the last known state and only go red on the second
            // consecutive miss.
            guard consecutiveStatusFailures >= 2, currentHealth != .starting else { return }
            if currentHealth != .down {
                TrayLog.warn("daemon unreachable, marking down", ["failures": consecutiveStatusFailures])
            }
            setHealth(.down)
            return
        }
        if consecutiveStatusFailures >= 2 {
            TrayLog.info("daemon reachable again", ["failures": consecutiveStatusFailures])
        }
        consecutiveStatusFailures = 0

        var health: DaemonHealth = status.pendingNotifications > 0 ? .warning : .healthy

        if let procData = await daemonClient.querySystemProcesses() {
            if procData.processes.contains(where: { $0.isRunaway }) {
                health = .warning
            }
        }

        // Phase 2 health level: a degraded/unhealthy daemon-reported level
        // outranks the local heuristics above — it names the actual failing
        // subsystem instead of leaving the operator to guess from a color.
        var failingSubsystem: String?
        if let level = status.healthLevel, level != "ok" {
            health = .degraded
            failingSubsystem = status.healthReasons.first ?? level
        }

        lastKnownDaemonStartedAt = Date().addingTimeInterval(-Double(status.uptime) / 1000)

        currentHealth = health
        updateMenuBarTitle(status: health)
        TrayState.shared.health = health
        TrayState.shared.failingSubsystem = failingSubsystem
        if let failingSubsystem {
            TrayState.shared.statusText = "Daemon: degraded — \(failingSubsystem)"
        } else {
            TrayState.shared.statusText = "Daemon: running · pid \(status.pid) · \(formatUptime(status.uptime))"
        }
        // The daemon being reachable only proves the daemon's own agent is
        // approved — another registered agent (deck) can still be pending.
        TrayState.shared.needsApproval = needsLoginItemApproval()

        await refreshBootDiagnostics()
    }

    /// Restart count, last-crash reason, and boot verdict (S026) — a separate
    /// query from the main status poll since this data only lives on the
    /// `ping` reply (see `DaemonClient.querySupervision`), not `tray:status`.
    /// Best-effort: a nil result just means the gear menu shows no boot info,
    /// same as before this feature existed.
    private func refreshBootDiagnostics() async {
        guard let supervision = await daemonClient.querySupervision() else { return }
        TrayState.shared.restartCount = supervision.bootAttempts
        let now = Date()
        if let (verdict, reason) = bootVerdict(from: supervision, now: now) {
            TrayState.shared.bootVerdict = verdict
            TrayState.shared.lastCrashReason = reason
        } else {
            TrayState.shared.bootVerdict = nil
            TrayState.shared.lastCrashReason = supervision.lastExit?.reason
        }
    }

    private func drainPendingNotifications() async {
        guard let events = await daemonClient.fetchNotifications() else { return }
        for event in events {
            notificationManager.fire(event)
        }
    }

    // MARK: - Notifications Setup

    private func setupNotifications() {
        notificationManager.requestPermission()
        notificationManager.registerCategories()
    }

    // MARK: - Tray Server (receives daemon pushes)

    private func setupTrayServer() {
        TrayServer.shared.onNotification = { [weak self] event in
            self?.notificationManager.fire(event)
        }
        TrayServer.shared.daemonLifecycle = daemonLifecycle
        TrayServer.shared.start()
    }

    // MARK: - Keyboard Conflict

    private func checkMissionControlConflict() {
        guard !MissionControlCheck.hasShownNotification else { return }
        guard MissionControlCheck.isControlUpBoundToMissionControl() else { return }

        TrayLog.info("Mission Control has Control+Up bound -- firing keyboard-conflict notification")

        let content = UNMutableNotificationContent()
        content.title = "Keyboard Shortcut Conflict"
        content.body = "Control+Up is reserved by Mission Control. rt needs this key for navigation."
        content.sound = nil
        content.categoryIdentifier = "keyboard_conflict"
        NotificationManager.playSound(for: "keyboard_conflict")

        let request = UNNotificationRequest(
            identifier: "rt-keyboard-conflict",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    @objc private func showKeyboardConflictWindow() {
        if let window = keyboardConflictWindow {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let window = NSWindow(
            contentRect: .zero,
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "mattstack -- Keyboard Shortcut Conflict"
        let hostingController = NSHostingController(rootView: KeyboardConflictView())
        window.contentViewController = hostingController

        // Let SwiftUI determine the content size, then position
        let fittingSize = hostingController.view.fittingSize
        window.setContentSize(fittingSize)

        if let screen = NSScreen.main {
            let visibleFrame = screen.visibleFrame
            let x = visibleFrame.midX - fittingSize.width / 2
            let y = visibleFrame.maxY - (visibleFrame.height * 0.17) - fittingSize.height
            window.setFrameOrigin(NSPoint(x: x, y: y))
        } else {
            window.center()
        }
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        keyboardConflictWindow = window
    }

    // MARK: - Helpers

    private func formatUptime(_ ms: Int) -> String {
        let seconds = ms / 1000
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        let remainingMinutes = minutes % 60
        return "\(hours)h \(remainingMinutes)m"
    }
}

extension AppDelegate: VersionProviding {
    /// `build` is the numeric CFBundleVersion L4 writes — major*1e6 +
    /// minor*1e3 + patch (e.g. 2.8.0 → 2008000) — never a string; a
    /// non-numeric or missing value reads as 0, but never silently: a build
    /// pipeline that regresses to a dotted string should show up in logs,
    /// not just as a suspiciously-always-0 build number.
    func versionInfo() -> VersionInfo {
        let raw = Bundle.main.infoDictionary?["CFBundleVersion"] as? String
        let build = raw.flatMap(Int.init) ?? {
            TrayLog.warn("CFBundleVersion not numeric", ["value": raw ?? "(missing)"])
            return 0
        }()
        return VersionInfo(version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
                           build: build,
                           flavor: BundleFlavor.isDevBuild ? "dev" : "prod",
                           path: Bundle.main.bundlePath)
    }
}

// MARK: - Types

enum DaemonHealth {
    case healthy    // Green dot — daemon running, all good
    case starting   // Yellow dot — daemon is starting/restarting
    case warning    // Orange dot — running but has pending notifications
    case degraded   // Pink dot — daemon reports health.level != "ok" (a named subsystem cause, not a guess)
    case down       // Red dot — daemon not reachable
    case unknown    // Grey dot — initial state before first poll
}

/// Classifies a `SupervisionInfo` reading into one of the two verdicts
/// observable while the daemon is still answering `ping` (a successful
/// `querySupervision` already proves it's alive and serving) -- mirrors
/// `classifyDaemonStatus`'s crash-looping/boot-failed branches in
/// `lib/daemon-status.ts` at the same n=3-within-5-minutes threshold as
/// `isCrashLooping` (`lib/daemon/supervision-state.ts`). The third named
/// verdict, "alive but not serving", only applies once `ping` itself fails
/// (see `setHealth`'s `.down` branch) and so can't be reached here.
private func bootVerdict(from info: SupervisionInfo, now: Date) -> (verdict: String, reason: String)? {
    let windowMs: Double = 5 * 60_000
    let floorMs = now.timeIntervalSince1970 * 1000 - windowMs
    let recentCount = info.recentFailures.filter { Double($0.at) > floorMs }.count

    if recentCount >= 3 {
        let reason = info.lastExit?.kind == "boot-failed"
            ? (info.lastExit?.reason ?? "unknown")
            : (info.recentFailures.last?.reason ?? "unknown")
        return ("crash-looping", reason)
    }
    if info.lastExit?.kind == "boot-failed" {
        return ("boot-failed", info.lastExit?.reason ?? "unknown")
    }
    return nil
}

struct DaemonStatus {
    let pid: Int
    let uptime: Int
    let memoryUsage: Int
    let watchedRepos: Int
    let cacheEntries: Int
    let portsCached: Int
    let portsByRepo: [String: Int]
    let pendingNotifications: Int
    let lastRefresh: Int?
    /// "ok" / "degraded" / "unhealthy", nil if the daemon didn't report one.
    let healthLevel: String?
    let healthReasons: [String]
}
