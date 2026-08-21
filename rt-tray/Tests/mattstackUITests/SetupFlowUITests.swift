import XCTest

final class SetupFlowUITests: XCTestCase {
    private var app: XCUIApplication!
    private var stateDir: URL!
    private var home: URL!

    private func launch(_ scenario: String) {
        app = XCUIApplication()
        stateDir = FileManager.default.temporaryDirectory.appendingPathComponent("stub-\(UUID().uuidString)")
        home = FileManager.default.temporaryDirectory.appendingPathComponent("home-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let stub = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("stub-rt/stub.ts").path
        app.launchEnvironment["RT_STUB_SCENARIO"] = scenario
        app.launchEnvironment["RT_STUB_PATH"] = stub
        app.launchEnvironment["RT_STUB_STATE_DIR"] = stateDir.path
        app.launchEnvironment["HOME"] = home.path
        app.launch()
    }

    private func el(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
    private func waitFor(_ id: String, _ timeout: TimeInterval = 10) {
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
        XCTAssertTrue(el("setup.checklist.continue").waitForExistence(timeout: 10))
        XCTAssertTrue(el("setup.checklist.continue").isEnabled, "join-happy plan is installable")
        el("setup.checklist.continue").click()
        waitFor("setup.install.screen")
        waitFor("setup.install.step.verify", 30)
        waitFor("setup.done.screen", 60)
        el("setup.done.openBoard").click()
        el("setup.done.continue").click()
    }

    func testCreateHappyShowsSlugAndReachesChecklist() {
        launch("create-happy")
        waitFor("setup.welcome.screen")
        el("setup.welcome.continue").click()
        waitFor("setup.team.screen")
        el("setup.team.card.create").click()
        el("setup.team.create.name").click()
        el("setup.team.create.name").typeText("Assured Claims")
        XCTAssertTrue(app.staticTexts["assured-claims"].waitForExistence(timeout: 3))
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
        el("setup.team.card.join").click()
        el("setup.team.join.code").click()
        el("setup.team.join.code").typeText("ABCD")
        el("setup.team.continue").click()
        XCTAssertTrue(app.staticTexts["You don't have access yet: ask matt to grant you access to Assured."].waitForExistence(timeout: 10))
        XCTAssertFalse(el("setup.checklist.screen").exists)
    }

    func testPermissionDeniedThenGrantedEnablesInstall() {
        launch("perm-denied-then-granted")
        waitFor("setup.welcome.screen")
        el("setup.welcome.continue").click()
        el("setup.team.card.join").click()
        el("setup.team.join.code").click(); el("setup.team.join.code").typeText("ABCD")
        el("setup.team.continue").click()
        waitFor("setup.checklist.screen")
        XCTAssertFalse(el("setup.checklist.continue").isEnabled)
        // The real FDA probe runs against a temp HOME, so the overlay reports
        // "unknown" → checking; the plan's second fetch (Re-check) flips the stub's row.
        el("setup.checklist.recheck").click()
        let enabled = NSPredicate(format: "isEnabled == true")
        expectation(for: enabled, evaluatedWith: el("setup.checklist.continue"))
        waitForExpectations(timeout: 15)
    }

    func testApplyFailureShowsRemedyAndRetryCompletes() {
        launch("apply-fail-retry")
        waitFor("setup.welcome.screen")
        el("setup.welcome.continue").click()
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
        waitFor("settings.tab.uninstall", 10)
        el("settings.tab.uninstall").click()
        waitFor("settings.uninstall.button", 10)
        el("settings.uninstall.button").click()
        waitFor("settings.uninstall.confirm")
        XCTAssertTrue(app.staticTexts["Stop and remove the rt daemon and deck services"].exists)
    }
}
