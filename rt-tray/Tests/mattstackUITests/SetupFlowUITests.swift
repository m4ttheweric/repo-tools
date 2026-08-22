import XCTest

final class SetupFlowUITests: XCTestCase {
    private var app: XCUIApplication!
    private var stateDir: URL!
    private var home: URL!

    /// A short random hex string, not a UUID: `home`'s tray.sock path
    /// (`<home>/.mattstack/rt/tray.sock`) has to fit in `sockaddr_un.sun_path`
    /// (104 bytes on Darwin), and `$TMPDIR/home-<uuid>/.mattstack/rt/tray.sock`
    /// alone runs well past that — TrayServer.start() fails to bind, silently,
    /// under the full temporaryDirectory() path. /tmp/ms-<8 hex> stays short
    /// regardless of how deep $TMPDIR is on the machine running the suite.
    private func shortHex() -> String { String(format: "%08x", UInt32.random(in: .min ... .max)) }

    /// The UI test runner is itself sandboxed (com.apple.security.app-sandbox),
    /// so NSHomeDirectory() here returns the runner's OWN container, not the
    /// real account's home -- "<that>/.bun/bin/bun" is never where bun lives.
    /// The sandbox does grant read-only access to the whole filesystem, so
    /// this finds the real one instead of guessing from a home-directory API.
    private func findBun() -> String {
        for candidate in ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"]
        where FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        let users = (try? FileManager.default.contentsOfDirectory(atPath: "/Users")) ?? []
        for user in users {
            let path = "/Users/\(user)/.bun/bin/bun"
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        return "/opt/homebrew/bin/bun"
    }

    override func tearDown() {
        app?.terminate()
        if let home { try? FileManager.default.removeItem(at: home) }
        if let stateDir { try? FileManager.default.removeItem(at: stateDir) }
        super.tearDown()
    }

    private func launch(_ scenario: String) {
        app = XCUIApplication()
        stateDir = URL(fileURLWithPath: "/tmp/ms-state-\(shortHex())")
        home = URL(fileURLWithPath: "/tmp/ms-\(shortHex())")
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let stub = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("stub-rt/stub.ts").path
        app.launchEnvironment["RT_STUB_SCENARIO"] = scenario
        app.launchEnvironment["RT_STUB_PATH"] = stub
        app.launchEnvironment["RT_STUB_STATE_DIR"] = stateDir.path
        app.launchEnvironment["HOME"] = home.path
        // RtBinaryLocator's stub path defaults RT_STUB_BUN to "<HOME>/.bun/bin/bun"
        // -- against the throwaway HOME above that's nowhere real, so the stub
        // process never spawns. Resolve the real one explicitly instead of
        // leaving the app to guess against a HOME that was never real either.
        app.launchEnvironment["RT_STUB_BUN"] = findBun()
        app.launch()
    }

    private func el(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
    /// 20s, not 10: every screen past Welcome/Team-card-selection waits on an
    /// actual `rt` round trip (spawn bun, run the stub script, drain both
    /// pipes to EOF), and a debug build under a loaded machine can visibly
    /// take several seconds just to get there.
    private func waitFor(_ id: String, _ timeout: TimeInterval = 20) {
        XCTAssertTrue(el(id).waitForExistence(timeout: timeout), "missing \(id)")
    }

    func testJoinHappyWalksAllFiveScreens() {
        launch("join-happy")
        waitFor("setup.welcome.screen")
        el("setup.welcome.continue").click()
        waitFor("setup.team.screen")
        el("setup.team.card.join").click()
        el("setup.team.join.code").click()
        el("setup.team.join.code").typeText("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ-2345-6789-ABCD-EFGH")
        el("setup.team.continue").click()
        waitFor("setup.checklist.screen")
        waitFor("setup.checklist.row.perm.fda")
        XCTAssertTrue(el("setup.checklist.continue").waitForExistence(timeout: 20))
        XCTAssertTrue(el("setup.checklist.continue").isEnabled, "join-happy plan is installable")
        el("setup.checklist.continue").click()
        waitFor("setup.install.screen")
        // Not waited on individually: the stub's apply() finishes all 11
        // steps in under 2s and flow.next() fires the instant the last one
        // succeeds, so "verify" can come and go between polls -- the install
        // screen appearing, then done appearing, is what actually proves the
        // run went through.
        waitFor("setup.done.screen", 60)
        // Not clicked: DoneScreen.openBoard() logs instead of opening a real
        // browser tab under stub mode, but there's nothing to assert on from
        // here besides existence/enablement, so leave the real click unfired.
        waitFor("setup.done.openBoard")
        XCTAssertTrue(el("setup.done.openBoard").isEnabled)
        el("setup.done.continue").click()
    }

    func testCreateHappyShowsSlugAndReachesChecklist() {
        launch("create-happy")
        waitFor("setup.welcome.screen")
        el("setup.welcome.continue").click()
        waitFor("setup.team.screen")
        el("setup.team.card.create").click()
        el("setup.team.create.name").click()
        el("setup.team.create.name").typeText("Acme Claims")
        XCTAssertTrue(app.staticTexts["acme-svc"].waitForExistence(timeout: 3))
        // The stub always answers `setup github status` as ready, so
        // TeamChoiceModel.loadGitHubStatus() flips useGhRepo on and the
        // plain remote-URL field never renders; canContinue is already
        // satisfied by the detected GitHub handle alone.
        waitFor("setup.team.create.useGh")
        el("setup.team.continue").click()
        waitFor("setup.checklist.screen")
    }

    func testJoinNoAccessShowsSpecificFailure() {
        launch("join-no-access")
        waitFor("setup.welcome.screen")
        el("setup.welcome.continue").click()
        waitFor("setup.team.screen")
        el("setup.team.card.join").click()
        el("setup.team.join.code").click()
        el("setup.team.join.code").typeText("ABCD")
        el("setup.team.continue").click()
        XCTAssertTrue(app.staticTexts["You don't have access yet: ask matt to grant you access to Acme."].waitForExistence(timeout: 20))
        XCTAssertFalse(el("setup.checklist.screen").exists)
    }

    func testPermissionDeniedThenGrantedEnablesInstall() {
        launch("perm-denied-then-granted")
        waitFor("setup.welcome.screen")
        el("setup.welcome.continue").click()
        waitFor("setup.team.screen")
        el("setup.team.card.join").click()
        el("setup.team.join.code").click(); el("setup.team.join.code").typeText("ABCD")
        el("setup.team.continue").click()
        waitFor("setup.checklist.screen")
        XCTAssertFalse(el("setup.checklist.continue").isEnabled)
        el("setup.checklist.recheck").click()
        let enabled = NSPredicate(format: "isEnabled == true")
        expectation(for: enabled, evaluatedWith: el("setup.checklist.continue"))
        waitForExpectations(timeout: 15)
    }

    func testApplyFailureShowsRemedyAndRetryCompletes() {
        launch("apply-fail-retry")
        waitFor("setup.welcome.screen")
        el("setup.welcome.continue").click()
        waitFor("setup.team.screen")
        el("setup.team.card.join").click()
        el("setup.team.join.code").click(); el("setup.team.join.code").typeText("ABCD")
        el("setup.team.continue").click()
        waitFor("setup.checklist.screen")
        el("setup.checklist.continue").click()
        waitFor("setup.install.retry", 30)
        XCTAssertTrue(app.staticTexts["Open Claude Code once so it finishes first-run, then Retry."].exists)
        el("setup.install.retry").click()
        waitFor("setup.done.screen", 60)
    }

    func testUninstallFromSettingsShowsDryRunList() {
        launch("uninstall")
        // Settings is reachable with ⌘, once a window is key; the setup window is.
        waitFor("setup.welcome.screen")
        app.typeKey(",", modifierFlags: .command)
        // Settings opens on whichever tab was last selected (persisted in
        // UserDefaults) and defaults to General on a clean run, so the
        // Uninstall tab has to be selected explicitly before its button exists.
        waitFor("settings.tab.uninstall")
        el("settings.tab.uninstall").click()
        waitFor("settings.uninstall.button")
        el("settings.uninstall.button").click()
        waitFor("settings.uninstall.confirm")
        XCTAssertTrue(app.staticTexts["Stop and remove the rt daemon and deck services"].exists)
    }
}
