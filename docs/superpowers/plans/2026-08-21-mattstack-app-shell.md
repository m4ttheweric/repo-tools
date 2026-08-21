# MAT-383 L3 — mattstack.app shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `rt-tray` into the mattstack.app installer shell: an xcodegen project beside a still-valid `Package.swift`, a testable `MattstackCore` module (contract models, readiness/install models, permission and service logic, tray.sock routes), the five-screen Setup window, the Settings window, Sparkle, SMAppService for N agents, the admin-prompt proxy step, the `mattstack://join` link, the new tray.sock routes, and a stub `rt` that carries the L1 contract for tests.

**Architecture:** Thin native shell over rt verbs (ruling 5). Everything that can be reasoned about without a window lives in a SwiftPM library target `MattstackCore` (`rt-tray/Sources-core/`, Foundation + Combine only) and is exercised by a CLT-runnable check harness; the AppKit/SwiftUI shell (`rt-tray/Sources/`) binds those models to windows, `NSWorkspace`, `SMAppService`, `UNUserNotificationCenter`, AuthorizationServices and Sparkle. The app never parses a store file and never invents a checklist row: it spawns the bundled `rt` by absolute path with `--json`, renders what comes back, and answers rt's callbacks on `tray.sock`.

**Tech Stack:** Swift 5 language mode on the Swift 6.3.1 toolchain (tools-version 5.9), AppKit lifecycle + SwiftUI views, SwiftPM (CLT-buildable) + xcodegen `project.yml` (Xcode-buildable), Sparkle 2.9.6 via SPM, ServiceManagement (`SMAppService`), UserNotifications, AuthorizationServices, Bun for the stub rt.

**Spec:** `docs/superpowers/specs/2026-08-20-mattstack-app-installer-design.md` (§2 rulings 5/6/7/9/10/12/13/15, V2/V3; §3; §4 all screens; §5.1/5.3; §8; §9; §11; §12) and `docs/superpowers/specs/2026-08-21-rt-setup-contract.md` (the JSON + tray.sock routes this plan renders and serves). Research: `docs/superpowers/specs/research/2026-08-20-mattstack-app/research-onboarding-permissions-ux.md`, `research-sparkle-install-launchd.md`, `research-local-inventory.md`. On conflict the spec wins, then the contract.

**Worktree for execution:** `/Users/matt/Documents/GitHub/repo-tools-l3-wt`, branch `goodwinmattheweric/mat-383-app-shell` off `origin/main`. Main checkout `/Users/matt/Documents/GitHub/repo-tools` is read-only reference. Every path below is relative to the worktree root unless absolute.

**Execution order (cross-plan review, `docs/superpowers/plans/2026-08-21-cross-plan-review.md` §3 — mandatory):** the worktree is cut off `origin/main` only after the settings lane's merge and the appspec docs branch (spec + contract) are on main. **Phase A:** T1–T11 (all inside `rt-tray/`, `Sources-core/`, `Tests/`), with T4's stub ids/shapes as corrected below; these merge before L4 T4/T5 run (L4's `build.sh`/`check-bundle.sh` rewrites consume L3's `Package.swift`, templates and `render-launchagents.sh`). **Phase B:** T12–T18 AFTER T1–T11; T13/T14/T17 carry the argv fixes (§5 #27–#29), T18 carries L4 T3's Swift string edits (§5 #30). **Merge order to main:** L4 phase A → L3 T1–T11 → L1 phase A → L4 T4/T5/T8 → L1 T5, T7–T12, T20–T30 → L3 T12–T19 → L7 → L4 T12 → L1 T31–T32 → MATT gates. Rebase onto `origin/main` before every merge.

## Machine facts (binding on task order and on what "verified" means)

- macOS 26.6.1. **Swift 6.3.1 via Command Line Tools only; Xcode 26 is NOT installed** (Matt installs it later). `xcodebuild` on this machine is the CLT stub and cannot build an app target. `xcodegen` 2.46.0 IS installed at `/opt/homebrew/bin/xcodegen` (it needs no Xcode to *generate*).
- **Neither `XCTest` nor swift-testing (`import Testing`) is importable under CLT-only** — verified 2026-08-21: `swift test` fails with `no such module 'XCTest'`. Therefore unit tests in this plan are written ONCE as a `MattstackCoreChecks` library (a 60-line harness, Task 1) run by the `mattstack-checks` executable: **`swift run mattstack-checks` is the unit-test gate implementers run under CLT today.** An XCTest target (`MattstackCoreTests`, one test that runs the same checks and reports each failure with `XCTFail`) is also declared so `swift test` / `xcodebuild test` work the moment Xcode is installed — zero duplicated assertions. Tasks marked **needs Xcode — blocked until installed** (xcodebuild archive, XCUITest runs) still have their code written; only the run is deferred.
- There is no monitor; implementers run `swift build`, `swift run mattstack-checks`, `bun Tests/stub-rt/stub.ts …` and `xcodegen generate` themselves and paste the output into their report.
- `swift build` must keep working on every commit: `Package.swift` builds the same sources the generated project builds. Sparkle comes through SPM (`from: "2.9.6"`), rpath `@executable_path/../Frameworks`; the framework is copied from `.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework` into `Contents/Frameworks` and signed inside-out, never `--deep`. The build-script halves of that belong to L4; this plan adds only the Package.swift dependency, `UpdaterController`, and the **minimum** build.sh stopgap that lets a locally built bundle launch at all (Task 10, clearly fenced).
- **Live-machine steps are ORCHESTRATOR-ONLY** (installing the built app, launching it, granting real permissions, registering real agents). They are marked as such. **MAT-383 T5/T6 lesson:** no unit check may be able to touch `pkill`, `launchctl`, `tccutil`, `open`, or `osascript`. Every process spawn in the shell goes through the `CommandRunner` seam (Task 7) or `RtRunning` (Task 3); checks use recording fakes; a source-guard check (Task 7) fails the build if a check file names any of those binaries.

## Global Constraints (binding on every task; from the spec)

- **No user or employer data ever lands on mattstack-hosted infrastructure.** The app talks to no relay; only rt verbs do.
- **rt owns mechanics, the app owns ceremony; every ceremony has a CLI equivalent.** The app never does something `rt setup` cannot. It never invents rows or steps; it renders `rt setup plan/status/apply` and calls the action's verb.
- **Honesty over magic:** every checklist row reports what was actually checked; nothing is marked ready on a guess. Permission rows show the app's own probe result and say so.
- **Settings are read and written only through the RT-47 stores via `rt settings`; state only through each app's state.db. The app has no config files of its own beyond UserDefaults for window/UI state** (plus `lastLaunchedVersion`, the login-item opt-out, last Settings pane).
- **The installer never copies a user's `~/.claude/settings.json` or hooks**; the app never edits `~/.claude.json`.
- **Pure canonical, no compat:** `rt-tray.app`, `com.rt.daemon`, `~/.rt`, brew paths are swept by rt, never honored by the app.
- **The app owns ceremony — setup and restore**; Deck does not.
- Ruling 6 (build tooling): Xcode project generated from a committed `project.yml` (xcodegen); `build.sh` wraps `xcodebuild` (L4); `check-bundle.sh` keeps asserting the bundle contract. Matt installs Xcode 26.
- Ruling 7 (distribution): the app IS the release; `~/.local/bin/rt` is a symlink into the bundle; **the app re-registers + kickstarts agents when its version changes**; `rt update` asks the app; **arm64-only**.
- Ruling 9 (services): SMAppService registers rt daemon + deck (one plist each in `Contents/Library/LaunchAgents`, one Login Items switch, FDA inherits); deck supervises board + gitq; plist PATH set explicitly to the bundle's helper dir; the portless proxy is a root LaunchDaemon owned by the privileged step (one admin prompt raised by the app).
- Ruling 10 (permissions): **Full Disk Access + Login Items required; Notifications optional. No Accessibility / Screen Recording / Automation.**
- Ruling 13 (identity, frozen): `com.mattstack.app` / `com.mattstack.app.dev`; agents `com.mattstack.daemon` / `.dev`, `com.mattstack.deck`; embedded binary `rt` (L4 renames `rt-daemon` → `rt`); product name `mattstack`; TLD `.mattstack`; `~/.mattstack`; **macOS 14 floor** (`LSMinimumSystemVersion 14.0`).
- Ruling 15 (UI): five screens + Settings with four panes. **Stock macOS 26 controls, `Form(.grouped)` rows, `.controlSize(.large)`, Return = Continue, ~560 pt fixed window, no close/minimize while setup is incomplete (Quit stays in the menu), custom `enum Step` page model with push transitions, "Step n of 5" indicator.** Status glyphs: `checkmark.circle.fill` green ready · `xmark.circle` red failed · `exclamationmark.triangle` yellow needs-you · `circle.dotted` grey not checked / optional skipped · small `ProgressView` while checking. Buttons that open System Settings end with an ellipsis. **GPL apps (Ice/AltTab/Loop) are design reference only — no code copying; Rectangle/inket (MIT) may be adapted with attribution** (the FDA probe's path list is adapted from inket/FullDiskAccess + MacPaw/PermissionsKit, MIT; say so in the file header).
- V2: default-exposed tools `rt`, `fast-browser`, `gitq`, `deck` (rt links them; the app never touches PATH).
- V3: DMG target `/Applications`, fallback `~/Applications`; **the app records its bundle path in the machine store (`mattstack.appPath`) at launch** through `rt settings set mattstack.appPath <json-string> --scope machine`.
- Dev flavor (`mattstack-dev.app`, `MSDevBuild=true`) keeps working from the same sources: Sparkle disabled, setup window runs against the real `rt` from the checkout (`~/.local/bin/rt` wrapper) or the stub (`RT_STUB_SCENARIO`, DEBUG builds only).
- Existing process panel / gear menu / daemon polling behaviour stays untouched except for the additive menu items listed in Task 18.
- Clean-code comments only: a comment states a constraint the code cannot show; no narration, no ticket numbers, no decision history in source.
- Commits: prefix `MAT-383:`; trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Do not commit `mattstack.xcodeproj` (generated) or `.build/`.
- **Cross-lane file ownership (cross-plan review §1):** rebase onto `origin/main` before every merge. `rt-tray/build.sh` and `rt-tray/check-bundle.sh` are **L4's** after Task 10 (L4 T3/T4 rewrite both; L3's Task 10 edits to them are a fenced stopgap that L4's rewrite deletes/absorbs). `rt-tray/Package.swift` (+ `Package.resolved`), the plist templates (`Info.plist`, `LaunchAgent.plist`, `LaunchAgent-deck.plist`), `rt-tray/project.yml`, `rt-tray/scripts/render-launchagents.sh`, `rt-tray/entitlements/*` and `rt-tray/Sources/**` are **L3's** (L4 T3 drops its edits to them; L4 T4/T5 consume them and wait for L3 T1/T2/T10 to merge). The root `.gitignore` line `rt-tray/*.xcodeproj/` is L3's (L4 T2 drops it). Spec/contract files under `docs/superpowers/specs/` are never committed from this branch (they merge to main first).

---

## File structure (what exists after the plan)

```
rt-tray/
  Package.swift                       modified: macOS 14, MattstackCore lib, checks lib+exe, XCTest target, Sparkle dep, rpath
  project.yml                         NEW: xcodegen — targets MattstackCore (framework), mattstack, mattstack-dev, MattstackCoreTests, mattstackUITests
  Info.plist                          modified template: LSMinimumSystemVersion 14.0, CFBundleURLTypes, SU* keys
  LaunchAgent.plist                   modified template: PATH env, KeepAlive dict for both flavors (build.sh keeps injecting)
  LaunchAgent-deck.plist              NEW template: com.mattstack.deck[.dev]
  scripts/render-launchagents.sh      NEW: templates → Contents/Library/LaunchAgents for a flavor (xcodegen prebuild; L4 build.sh may call it)
  build.sh                            modified (fenced stopgap only; L4 T4's rewrite deletes it): copy + sign Sparkle.framework, render both agent plists
  check-bundle.sh                     modified (L4 T3 owns the rewrite; absorbs these assertions): the UpdateChecker dev-silence grep now points at UpdaterController
  Sources-core/                       NEW library target MattstackCore (Foundation + Combine only)
    Contract/PlanModels.swift         Plan/PlanGroup/PlanRow/RowAction… (contract v1)
    Contract/ApplyEvents.swift        ApplyEvent, StepInfo, NeedRequest, NDJSON decoding
    Contract/OtherResults.swift       ConnectResult, TeamJoinResult, InviteResult, UninstallPlan, VersionInfo, RtUserError
    Rt/NDJSONSplitter.swift
    Rt/RtClient.swift                 RtRunning protocol, RtClient (Process), RtResult
    Rt/RtBinaryLocator.swift          bundled rt / dev wrapper / stub resolution
    Readiness/ReadinessModel.swift    plan → rows; enablement; recheck policy; timers
    Readiness/StatusGlyph.swift       RowStatus → SF Symbol + tint name
    Readiness/RowActionDispatcher.swift
    Permissions/PermissionSnapshot.swift  states + JSON per contract + row overlay mapping
    Permissions/FDAProbe.swift        pure probe over an injected open() (inket/MacPaw paths, MIT attribution)
    Permissions/SystemSettingsLinks.swift
    Services/CommandRunner.swift      seam for launchctl/tccutil/helpers (+ RecordingCommandRunner for checks)
    Services/ServicePlists.swift      scan Contents/Library/LaunchAgents, labels, kickstart args
    Services/VersionChangeDetector.swift
    Services/ServiceModels.swift      ServiceStatusEntry, ServiceRegisterResult, ServicesProviding…
    Needs/NeedBroker.swift            idempotent per-id execution of `need` events
    Routes/TrayRoutes.swift           the new tray.sock routes as a pure router
    Install/InstallRunModel.swift     apply stream → step list, logs, need handling, retry-from
    Setup/SetupFlowModel.swift        enum SetupStep + navigation
    Setup/TeamChoiceModel.swift       create/join/restore state + rt calls + failure copy
    Launch/LaunchGuard.swift          translocation/DMG guard, first-run detector, join-link parser, appPath args
    Settings/RemoteMasker.swift
    Updates/UpdatePolicy.swift
  Sources/                            existing executable target rt-tray (app shell), new files:
    Rt/RtClientFactory.swift
    Permissions/PermissionsService.swift
    Services/ServicesRegistrar.swift
    Services/PrivilegedInstaller.swift
    Updates/UpdaterController.swift   (UpdateChecker.swift DELETED)
    Setup/SetupWindowController.swift
    Setup/SetupView.swift
    Setup/Screens/WelcomeScreen.swift TeamScreen.swift ChecklistScreen.swift InstallScreen.swift DoneScreen.swift
    Setup/Components/StatusBadge.swift RowView.swift ConnectSheet.swift StepsSheet.swift LogSheet.swift
    Settings/SettingsWindowController.swift SettingsView.swift GeneralPane.swift PermissionsPane.swift TeamPane.swift UninstallPane.swift
    AppDelegate.swift TrayServer.swift main.swift TrayState.swift  (modified)
  Tests/
    MattstackCoreChecks/              NEW library: Harness.swift, AllChecks.swift, one *Checks.swift per Core module
    mattstack-checks/main.swift       NEW executable: runs the checks, exit 1 on failure  ← CLT gate
    MattstackCoreTests/CoreChecksXCTest.swift  NEW XCTest bridge (needs Xcode to run)
    stub-rt/stub.ts                   NEW Bun stub rt (scenarios from the contract)
    mattstackUITests/SetupFlowUITests.swift    NEW XCUITest (needs Xcode to run)
```

Naming rules used throughout: Core types are `public`; the app target `@testable`-free imports `MattstackCore`. Every process spawn goes through `RtRunning` (rt) or `CommandRunner` (everything else). Checks never construct `SystemCommandRunner` or a real `RtClient` pointed at anything but `/bin/sh` scripts written into a temp dir.

---

### Task 0: Worktree + branch (orchestrator or first implementer)

- [ ] **Step 1: Create the worktree off origin/main**

```bash
cd /Users/matt/Documents/GitHub/repo-tools
git fetch origin
git worktree add -b goodwinmattheweric/mat-383-app-shell /Users/matt/Documents/GitHub/repo-tools-l3-wt origin/main
cd /Users/matt/Documents/GitHub/repo-tools-l3-wt/rt-tray
swift build 2>&1 | tail -3
```
Expected: `Build complete!` (baseline builds before any change).

- [ ] **Step 2:** Dropped — spec/contract are merged to main first (cross-plan review §1 row 27); the worktree is cut after that merge, so the files are already present.

---

### Task 1: Package.swift restructure — MattstackCore, checks harness, XCTest bridge, macOS 14 floor

**Files:**
- Modify: `rt-tray/Package.swift`
- Create: `rt-tray/Sources-core/Contract/PlanModels.swift`
- Create: `rt-tray/Tests/MattstackCoreChecks/Harness.swift`, `rt-tray/Tests/MattstackCoreChecks/AllChecks.swift`, `rt-tray/Tests/MattstackCoreChecks/PlanModelsChecks.swift`
- Create: `rt-tray/Tests/mattstack-checks/main.swift`
- Create: `rt-tray/Tests/MattstackCoreTests/CoreChecksXCTest.swift`
- Modify: `.gitignore` (root) — add `rt-tray/*.xcodeproj/` and `rt-tray/Generated/`

**Interfaces:**
- Produces: module `MattstackCore`; `Plan`, `PlanGroup`, `PlanRow`, `RowAction`, `RowStatus`, `RowKind`, `RecheckPolicy`, `ActionType`, `ActionField`, `ActionAlternative`, `TeamInfo`, `TeamMode` (all `public`, `Codable`, `Equatable`); the check harness API `Check`, `CheckContext.expect/expectEqual/fail`, `runAllChecks() async -> CheckReport`; the `allChecks` registry every later task appends to.

- [ ] **Step 1: Write the harness**

`rt-tray/Tests/MattstackCoreChecks/Harness.swift`:
```swift
import Foundation

public struct CheckFailure: Sendable {
    public let check: String
    public let message: String
    public let file: String
    public let line: Int
}

public struct Check: Sendable {
    public let name: String
    public let body: @Sendable (CheckContext) async throws -> Void
    public init(_ name: String, _ body: @escaping @Sendable (CheckContext) async throws -> Void) {
        self.name = name
        self.body = body
    }
}

public final class CheckContext: @unchecked Sendable {
    public let name: String
    public private(set) var failures: [CheckFailure] = []
    private let lock = NSLock()
    init(name: String) { self.name = name }

    public func expect(_ condition: Bool, _ message: @autoclosure () -> String = "expected true",
                       file: String = #filePath, line: Int = #line) {
        guard !condition else { return }
        record(message(), file, line)
    }
    public func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: @autoclosure () -> String = "",
                                          file: String = #filePath, line: Int = #line) {
        guard actual != expected else { return }
        record("\(message()) expected \(expected) got \(actual)", file, line)
    }
    public func fail(_ message: String, file: String = #filePath, line: Int = #line) { record(message, file, line) }

    private func record(_ message: String, _ file: String, _ line: Int) {
        lock.lock(); defer { lock.unlock() }
        failures.append(CheckFailure(check: name, message: message, file: file, line: line))
    }
}

public struct CheckReport: Sendable {
    public let passed: Int
    public let failures: [CheckFailure]
    public var ok: Bool { failures.isEmpty }
}

public func runAllChecks(filter: String? = nil) async -> CheckReport {
    var passed = 0
    var failures: [CheckFailure] = []
    for check in allChecks where filter == nil || check.name.contains(filter!) {
        let ctx = CheckContext(name: check.name)
        do { try await check.body(ctx) } catch {
            ctx.fail("threw \(error)")
        }
        if ctx.failures.isEmpty { passed += 1 } else { failures.append(contentsOf: ctx.failures) }
    }
    return CheckReport(passed: passed, failures: failures)
}
```

`rt-tray/Tests/MattstackCoreChecks/AllChecks.swift`:
```swift
/// Explicit registry — no reflection. Each *Checks.swift file exposes one
/// array; append it here when you add a file.
let allChecks: [Check] = planModelsChecks
```

`rt-tray/Tests/mattstack-checks/main.swift`:
```swift
import Foundation
import MattstackCoreChecks

let filter = CommandLine.arguments.dropFirst().first
let report = await runAllChecks(filter: filter)
for f in report.failures {
    FileHandle.standardError.write(Data("FAIL \(f.check): \(f.message) (\(f.file):\(f.line))\n".utf8))
}
print("checks: \(report.passed) passed, \(report.failures.count) failed")
exit(report.ok ? 0 : 1)
```

`rt-tray/Tests/MattstackCoreTests/CoreChecksXCTest.swift` (runs only once Xcode exists; `swift build` never compiles test targets):
```swift
import XCTest
import MattstackCoreChecks

final class CoreChecksXCTest: XCTestCase {
    func testAllCoreChecksPass() async {
        let report = await runAllChecks()
        for f in report.failures {
            XCTFail("\(f.check) [\(f.file):\(f.line)]: \(f.message)")
        }
        XCTAssertGreaterThan(report.passed, 0)
    }
}
```

- [ ] **Step 2: Write the first failing check — contract plan decoding**

`rt-tray/Tests/MattstackCoreChecks/PlanModelsChecks.swift`:
```swift
import Foundation
import MattstackCore

let samplePlanJSON = """
{ "contract": 1, "at": "2026-08-21T04:00:00Z",
  "team": { "slug": "acme", "name": "Acme", "mode": "join" },
  "groups": [
    { "id": "mac", "title": "Your Mac", "rows": [
      { "id": "perm.fda", "kind": "permission", "title": "Full Disk Access",
        "why": "Reads your repositories' git state so the daemon can show branch and MR status.",
        "required": true, "optionalNote": null, "status": "needs-you", "detail": "Not granted",
        "action": { "type": "open-settings", "label": "Open Full Disk Access Settings…", "target": "fda" },
        "recheck": "on-activate" },
      { "id": "tool.clt", "kind": "tool", "title": "Apple command line tools", "why": "git and python3.",
        "required": true, "optionalNote": null, "status": "ready", "detail": "git 2.50.1", "action": null, "recheck": "on-change" } ] },
    { "id": "accounts", "title": "Accounts", "rows": [
      { "id": "account.gitlab", "kind": "account", "title": "GitLab", "why": "MRs live on gitlab.example.com.",
        "required": true, "optionalNote": null, "status": "missing", "detail": null,
        "action": { "type": "connect", "label": "Connect", "integration": "gitlab",
                    "fields": [ { "name": "token", "label": "Personal access token", "secret": true, "hint": "scopes: read_api, read_user" } ],
                    "alternatives": [ { "id": "use-gh", "label": "Use gh login" } ] },
        "recheck": "on-change" },
      { "id": "tool.chrome", "kind": "tool", "title": "Google Chrome", "why": "Evidence capture.",
        "required": false, "optionalNote": "Works without this.", "status": "skipped", "detail": null,
        "action": { "type": "future-thing", "label": "?" }, "recheck": "manual" } ] } ],
  "canInstall": false, "requiredMissing": ["perm.fda", "account.gitlab"] }
"""

let planModelsChecks: [Check] = [
    Check("Plan decodes the contract sample") { c in
        let plan = try JSONDecoder().decode(Plan.self, from: Data(samplePlanJSON.utf8))
        c.expectEqual(plan.contract, 1)
        c.expectEqual(plan.team.mode, .join)
        c.expectEqual(plan.groups.count, 2)
        c.expectEqual(plan.groups[0].rows[0].status, .needsYou)
        c.expectEqual(plan.groups[0].rows[0].action?.type, .openSettings)
        c.expectEqual(plan.groups[0].rows[0].action?.target, "fda")
        c.expectEqual(plan.groups[0].rows[0].recheck, .onActivate)
        c.expectEqual(plan.groups[1].rows[0].action?.fields?.first?.secret, true)
        c.expectEqual(plan.groups[1].rows[0].action?.alternatives?.first?.id, "use-gh")
        c.expectEqual(plan.requiredMissing, ["perm.fda", "account.gitlab"])
        c.expectEqual(plan.canInstall, false)
    },
    Check("unknown action type and status degrade instead of failing the whole plan") { c in
        let plan = try JSONDecoder().decode(Plan.self, from: Data(samplePlanJSON.utf8))
        let chrome = plan.groups[1].rows[1]
        c.expectEqual(chrome.action?.type, .unknown)
        var lenient = samplePlanJSON
        lenient = lenient.replacingOccurrences(of: "\"status\": \"skipped\"", with: "\"status\": \"brand-new\"")
        let plan2 = try JSONDecoder().decode(Plan.self, from: Data(lenient.utf8))
        c.expectEqual(plan2.groups[1].rows[1].status, .error)
    },
    Check("Plan round-trips through the encoder") { c in
        let plan = try JSONDecoder().decode(Plan.self, from: Data(samplePlanJSON.utf8))
        let data = try JSONEncoder().encode(plan)
        let again = try JSONDecoder().decode(Plan.self, from: data)
        c.expectEqual(again, plan)
    },
]
```

- [ ] **Step 3: Rewrite Package.swift**

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "rt-tray",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .target(
            name: "MattstackCore",
            path: "Sources-core"
        ),
        .executableTarget(
            name: "rt-tray",
            dependencies: ["MattstackCore"],
            path: "Sources",
            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug)),
            ],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("UserNotifications"),
                .linkedFramework("ServiceManagement"),
            ]
        ),
        .executableTarget(
            name: "rt-daemon-shim",
            path: "Sources-daemon-shim"
        ),
        .target(
            name: "MattstackCoreChecks",
            dependencies: ["MattstackCore"],
            path: "Tests/MattstackCoreChecks"
        ),
        .executableTarget(
            name: "mattstack-checks",
            dependencies: ["MattstackCoreChecks"],
            path: "Tests/mattstack-checks"
        ),
        .testTarget(
            name: "MattstackCoreTests",
            dependencies: ["MattstackCoreChecks"],
            path: "Tests/MattstackCoreTests"
        ),
    ]
)
```
(Sparkle and the rpath linker flags arrive in Task 10, so Task 1's build needs no network.)

- [ ] **Step 4: Run the checks to verify they fail to compile (no `Plan` yet)**

Run: `cd rt-tray && swift run mattstack-checks 2>&1 | tail -5`
Expected: `error: cannot find type 'Plan' in scope`.

- [ ] **Step 5: Write the contract models**

`rt-tray/Sources-core/Contract/PlanModels.swift`:
```swift
import Foundation

public enum TeamMode: String, Codable, Equatable, Sendable { case join, create, restore, none }

public struct TeamInfo: Codable, Equatable, Sendable {
    public var slug: String?
    public var name: String?
    public var mode: TeamMode
    public init(slug: String? = nil, name: String? = nil, mode: TeamMode) {
        self.slug = slug; self.name = name; self.mode = mode
    }
}

public enum RowKind: String, Codable, Equatable, Sendable { case permission, tool, account, access, info }

/// Unknown values decode as `.error` so one new status from a newer rt
/// cannot blank the whole checklist.
public enum RowStatus: String, Codable, Equatable, Sendable {
    case ready, missing, invalid, checking, skipped, error
    case needsYou = "needs-you"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RowStatus(rawValue: raw) ?? .error
    }
}

public enum RecheckPolicy: String, Codable, Equatable, Sendable {
    case onActivate = "on-activate"
    case onChange = "on-change"
    case manual
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RecheckPolicy(rawValue: raw) ?? .manual
    }
}

public enum ActionType: String, Codable, Equatable, Sendable {
    case openSettings = "open-settings"
    case requestPermission = "request-permission"
    case connect, oauth, install, steps, run
    case ownerOnce = "owner-once"
    case linkBundled = "link-bundled"
    case openURL = "open-url"
    case unknown
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ActionType(rawValue: raw) ?? .unknown
    }
}

public struct ActionField: Codable, Equatable, Sendable {
    public var name: String
    public var label: String
    public var secret: Bool
    public var hint: String?
    public init(name: String, label: String, secret: Bool, hint: String? = nil) {
        self.name = name; self.label = label; self.secret = secret; self.hint = hint
    }
}

public struct ActionAlternative: Codable, Equatable, Sendable {
    public var id: String
    public var label: String
    public init(id: String, label: String) { self.id = id; self.label = label }
}

/// One shape for every contract action; which optionals are present is
/// discriminated by `type`. Kept flat so rt can add a field without a
/// decoder change here.
public struct RowAction: Codable, Equatable, Sendable {
    public var type: ActionType
    public var label: String
    public var target: String?
    public var which: String?
    public var integration: String?
    public var fields: [ActionField]?
    public var alternatives: [ActionAlternative]?
    public var verb: [String]?
    public var tool: String?
    public var via: String?
    public var steps: [String]?
    public var url: String?
    public init(type: ActionType, label: String, target: String? = nil, which: String? = nil,
                integration: String? = nil, fields: [ActionField]? = nil,
                alternatives: [ActionAlternative]? = nil, verb: [String]? = nil, tool: String? = nil,
                via: String? = nil, steps: [String]? = nil, url: String? = nil) {
        self.type = type; self.label = label; self.target = target; self.which = which
        self.integration = integration; self.fields = fields; self.alternatives = alternatives
        self.verb = verb; self.tool = tool; self.via = via; self.steps = steps; self.url = url
    }
}

public struct PlanRow: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var kind: RowKind
    public var title: String
    public var why: String
    public var required: Bool
    public var optionalNote: String?
    public var status: RowStatus
    public var detail: String?
    public var action: RowAction?
    public var recheck: RecheckPolicy
    public init(id: String, kind: RowKind, title: String, why: String, required: Bool,
                optionalNote: String? = nil, status: RowStatus, detail: String? = nil,
                action: RowAction? = nil, recheck: RecheckPolicy) {
        self.id = id; self.kind = kind; self.title = title; self.why = why; self.required = required
        self.optionalNote = optionalNote; self.status = status; self.detail = detail
        self.action = action; self.recheck = recheck
    }
}

public struct PlanGroup: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var rows: [PlanRow]
    public init(id: String, title: String, rows: [PlanRow]) { self.id = id; self.title = title; self.rows = rows }
}

public struct Plan: Codable, Equatable, Sendable {
    public var contract: Int
    public var at: String
    public var team: TeamInfo
    public var groups: [PlanGroup]
    public var canInstall: Bool
    public var requiredMissing: [String]
    public init(contract: Int = 1, at: String, team: TeamInfo, groups: [PlanGroup],
                canInstall: Bool, requiredMissing: [String]) {
        self.contract = contract; self.at = at; self.team = team; self.groups = groups
        self.canInstall = canInstall; self.requiredMissing = requiredMissing
    }
}
```

- [ ] **Step 6: Run the checks**

Run: `cd rt-tray && swift run mattstack-checks 2>&1 | tail -3`
Expected: `checks: 3 passed, 0 failed`, exit 0. Also run `swift build 2>&1 | tail -1` → `Build complete!` (app target still compiles with the dependency added).

- [ ] **Step 7: .gitignore + commit**

Append to root `.gitignore`:
```
rt-tray/*.xcodeproj/
rt-tray/Generated/
rt-tray/Tests/stub-rt/.state/
```
```bash
git add .gitignore rt-tray/Package.swift rt-tray/Sources-core rt-tray/Tests
git commit -m "MAT-383: MattstackCore library, CLT-runnable check harness, contract plan models

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: xcodegen `project.yml`, Info.plist keys, LaunchAgent templates, render script

**Files:**
- Create: `rt-tray/project.yml`
- Modify: `rt-tray/Info.plist` (template used by build.sh; same keys as project.yml's `info.properties`)
- Modify: `rt-tray/LaunchAgent.plist`
- Create: `rt-tray/LaunchAgent-deck.plist`
- Create: `rt-tray/scripts/render-launchagents.sh`
- Create: `rt-tray/entitlements/mattstack.entitlements`

**Interfaces:**
- Produces: two app targets `mattstack` / `mattstack-dev` with Info.plist keys `MSDaemonLabel`, `MSDevBuild`, `CFBundleURLTypes` (`mattstack`), `LSMinimumSystemVersion 14.0`, `SUFeedURL`, `SUPublicEDKey`, `SUEnableAutomaticChecks`, `SUAutomaticallyUpdate`, `SUVerifyUpdateBeforeExtraction`, `SUScheduledCheckInterval`, `NSAppTransportSecurity.NSAllowsLocalNetworking`; LaunchAgent files `com.mattstack.daemon[.dev].plist` + `com.mattstack.deck[.dev].plist` under `Contents/Library/LaunchAgents` (ServicesRegistrar enumerates that directory, Task 7).

- [ ] **Step 1: Write the render script (the one place that knows a flavor's labels for the agents)**

`rt-tray/scripts/render-launchagents.sh`:
```bash
#!/bin/bash
# Render the LaunchAgent templates for one flavor into a directory.
# Usage: render-launchagents.sh prod|dev <out-dir>
set -euo pipefail
FLAVOR="$1"; OUT="$2"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
case "$FLAVOR" in
    prod) BUNDLE_ID="com.mattstack.app";     DAEMON_LABEL="com.mattstack.daemon";     DECK_LABEL="com.mattstack.deck" ;;
    dev)  BUNDLE_ID="com.mattstack.app.dev"; DAEMON_LABEL="com.mattstack.daemon.dev"; DECK_LABEL="com.mattstack.deck.dev" ;;
    *) echo "flavor must be prod|dev" >&2; exit 2 ;;
esac
mkdir -p "$OUT"
render() { # template label out
    sed -e "s/@@DAEMON_LABEL@@/$DAEMON_LABEL/g" -e "s/@@DECK_LABEL@@/$DECK_LABEL/g" \
        -e "s/@@BUNDLE_ID@@/$BUNDLE_ID/g" "$1" > "$2"
    /usr/libexec/PlistBuddy -c "Add :KeepAlive dict" "$2"
    /usr/libexec/PlistBuddy -c "Add :KeepAlive:SuccessfulExit bool false" "$2"
    plutil -lint "$2" >/dev/null
}
render "$HERE/LaunchAgent.plist"      "$OUT/$DAEMON_LABEL.plist"
render "$HERE/LaunchAgent-deck.plist" "$OUT/$DECK_LABEL.plist"
echo "rendered $DAEMON_LABEL.plist $DECK_LABEL.plist → $OUT"
```
`chmod +x rt-tray/scripts/render-launchagents.sh`. (KeepAlive `{SuccessfulExit:false}` for both flavors per spec §8; build.sh's prod `KeepAlive true` branch is L4's to retire — leave build.sh alone here.)

- [ ] **Step 2: Update the daemon template and add the deck template**

`rt-tray/LaunchAgent.plist` — (a) rename the program (L4 renames the embedded binary `rt-daemon` → `rt`): `BundleProgram` → `Contents/MacOS/rt`, `ProgramArguments` → `[Contents/MacOS/rt, --daemon]`, and the Label comment → "Label: com.mattstack.daemon (prod) / com.mattstack.daemon.dev (dev)"; (b) replace the KeepAlive comment with "KeepAlive is injected by `scripts/render-launchagents.sh` as `{SuccessfulExit:false}` for both flavors"; (c) add, after `ThrottleInterval`, an explicit PATH (spec §8: "explicit EnvironmentVariables.PATH … nothing is captured from the user's shell"); keep everything else as is:
```xml
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
```
**Ruling R2 (cross-plan review):** the plist PATH is this STATIC system list — never a hardcoded `/Applications/…` path and never `~/.local/bin` (launchd does not expand variables inside `EnvironmentVariables`, and SMAppService reads the plist verbatim from the bundle, so neither the bundle's absolute `Contents/Helpers` nor `$HOME` can be written here at build time). rt and deck prepend `<bundleRoot>/Contents/Helpers` (derived at runtime from their own `execPath`) and `$HOME/.local/bin` (HOME from the environment) to their `PATH` at process start; L4's `check-bundle.sh` asserts the static value.

`rt-tray/LaunchAgent-deck.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>@@DECK_LABEL@@</string>
    <key>BundleProgram</key>
    <string>Contents/Helpers/deck</string>
    <key>ProgramArguments</key>
    <array>
        <string>Contents/Helpers/deck</string>
        <string>serve</string>
    </array>
    <key>AssociatedBundleIdentifiers</key>
    <array>
        <string>@@BUNDLE_ID@@</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ExitTimeOut</key>
    <integer>30</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
```
(Dev flavor's deck binary location — `~/.mattstack/deck/bin/deck` per DECK-13 — is an L4/L5 bundling decision; the template names the bundled path, and an absent helper simply registers as `.notFound`, which the Background services row reports honestly.)

- [ ] **Step 3: Update the Info.plist template**

In `rt-tray/Info.plist` change `LSMinimumSystemVersion` to `14.0` and add before `</dict>`:
```xml
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>@@BUNDLE_ID@@.join</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>mattstack</string>
            </array>
        </dict>
    </array>
    <key>SUFeedURL</key>
    <string>https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml</string>
    <key>SUPublicEDKey</key>
    <string>REPLACE_WITH_RELEASE_PUBLIC_ED_KEY</string>
    <key>SUEnableAutomaticChecks</key>
    <true/>
    <key>SUAutomaticallyUpdate</key>
    <true/>
    <key>SUVerifyUpdateBeforeExtraction</key>
    <true/>
    <key>SUScheduledCheckInterval</key>
    <integer>21600</integer>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
```
(`NSAllowsLocalNetworking` lets the clean-room VM (L7) serve a loopback appcast via `MATTSTACK_APPCAST_URL` — Task 10. `SUPublicEDKey` is a placeholder by design — L4's release job owns the real key; `UpdatePolicy` in Task 10 refuses to start Sparkle while the placeholder is present, so a local build never phones a feed it cannot verify. The appcast is a GitHub Release asset (ruling R1), hence the `releases/latest/download` URL and the 21600 s interval — both are L4's canon and `check-bundle.sh` asserts them. `CFBundleURLName` stays `@@BUNDLE_ID@@.join` (L4 drops its `.url` spelling). **L4's `build.sh` overwrites the `SU*` values with PlistBuddy `Set` (create-if-missing; dev flavor `SUEnableAutomaticChecks false`) — it never `Add`s a key this template already declares.**)

- [ ] **Step 4: Entitlements file** `rt-tray/entitlements/mattstack.entitlements`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <false/>
</dict>
</plist>
```

- [ ] **Step 5: Write project.yml**

`rt-tray/project.yml`:
```yaml
name: mattstack
options:
  bundleIdPrefix: com.mattstack
  deploymentTarget:
    macOS: "14.0"
  createIntermediateGroups: true
  generateEmptyDirectories: true
  xcodeVersion: "26.0"
settings:
  base:
    SWIFT_VERSION: "5.0"
    MACOSX_DEPLOYMENT_TARGET: "14.0"
    ARCHS: arm64
    ONLY_ACTIVE_ARCH: YES
    ENABLE_HARDENED_RUNTIME: YES
    CODE_SIGN_STYLE: Manual
    DEVELOPMENT_TEAM: 5BF66B3X4V
    MARKETING_VERSION: "2.8.0"
    CURRENT_PROJECT_VERSION: 1
    LD_RUNPATH_SEARCH_PATHS: "@executable_path/../Frameworks"
  configs:
    Debug:
      SWIFT_ACTIVE_COMPILATION_CONDITIONS: DEBUG
packages:
  Sparkle:
    url: https://github.com/sparkle-project/Sparkle
    from: "2.9.6"

targetTemplates:
  MattstackApp:
    type: application
    platform: macOS
    sources:
      - path: Sources
        excludes: ["**/.DS_Store"]
    dependencies:
      - target: MattstackCore
        embed: true
      - package: Sparkle
    preBuildScripts:
      - name: Render LaunchAgents
        script: |
          "${SRCROOT}/scripts/render-launchagents.sh" "${MS_FLAVOR}" "${SRCROOT}/Generated/LaunchAgents-${MS_FLAVOR}"
        outputFiles:
          - "${SRCROOT}/Generated/LaunchAgents-${MS_FLAVOR}/${MS_DAEMON_LABEL}.plist"
          - "${SRCROOT}/Generated/LaunchAgents-${MS_FLAVOR}/${MS_DECK_LABEL}.plist"
    postCompileScripts:
      - name: Copy LaunchAgents into bundle
        script: |
          DEST="${BUILT_PRODUCTS_DIR}/${CONTENTS_FOLDER_PATH}/Library/LaunchAgents"
          mkdir -p "$DEST"
          cp "${SRCROOT}/Generated/LaunchAgents-${MS_FLAVOR}/"*.plist "$DEST/"
    settings:
      base:
        CODE_SIGN_ENTITLEMENTS: entitlements/mattstack.entitlements
        INFOPLIST_KEY_LSUIElement: YES
    info:
      properties:
        CFBundleIconFile: AppIcon
        CFBundlePackageType: APPL
        LSUIElement: true
        LSMinimumSystemVersion: "14.0"
        NSUserNotificationAlertStyle: alert
        CFBundleURLTypes:
          - CFBundleURLName: "$(PRODUCT_BUNDLE_IDENTIFIER).join"
            CFBundleURLSchemes: [mattstack]
        SUFeedURL: https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml
        SUPublicEDKey: REPLACE_WITH_RELEASE_PUBLIC_ED_KEY
        SUEnableAutomaticChecks: true
        SUAutomaticallyUpdate: true
        SUVerifyUpdateBeforeExtraction: true
        SUScheduledCheckInterval: 21600
        NSAppTransportSecurity:
          NSAllowsLocalNetworking: true

targets:
  MattstackCore:
    type: framework
    platform: macOS
    sources: [Sources-core]
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.mattstack.core
        SKIP_INSTALL: YES

  mattstack:
    templates: [MattstackApp]
    settings:
      base:
        PRODUCT_NAME: mattstack
        PRODUCT_BUNDLE_IDENTIFIER: com.mattstack.app
        MS_FLAVOR: prod
        MS_DAEMON_LABEL: com.mattstack.daemon
        MS_DECK_LABEL: com.mattstack.deck
    info:
      path: Generated/mattstack-Info.plist
      properties:
        CFBundleName: mattstack
        CFBundleDisplayName: mattstack
        CFBundleExecutable: mattstack
        MSDaemonLabel: com.mattstack.daemon
        MSDevBuild: false

  mattstack-dev:
    templates: [MattstackApp]
    settings:
      base:
        PRODUCT_NAME: mattstack-dev
        PRODUCT_BUNDLE_IDENTIFIER: com.mattstack.app.dev
        MS_FLAVOR: dev
        MS_DAEMON_LABEL: com.mattstack.daemon.dev
        MS_DECK_LABEL: com.mattstack.deck.dev
    info:
      path: Generated/mattstack-dev-Info.plist
      properties:
        CFBundleName: mattstack-dev
        CFBundleDisplayName: mattstack-dev
        CFBundleExecutable: mattstack-dev
        MSDaemonLabel: com.mattstack.daemon.dev
        MSDevBuild: true

  MattstackCoreChecks:
    type: framework
    platform: macOS
    sources: [Tests/MattstackCoreChecks]
    dependencies:
      - target: MattstackCore
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.mattstack.core.checks

  MattstackCoreTests:
    type: bundle.unit-test
    platform: macOS
    sources: [Tests/MattstackCoreTests]
    dependencies:
      - target: MattstackCoreChecks
      - target: MattstackCore

  mattstackUITests:
    type: bundle.ui-testing
    platform: macOS
    sources: [Tests/mattstackUITests]
    dependencies:
      - target: mattstack
    settings:
      base:
        TEST_TARGET_NAME: mattstack

schemes:
  mattstack:
    build:
      targets:
        mattstack: all
    run:
      config: Debug
    test:
      config: Debug
      targets: [MattstackCoreTests, mattstackUITests]
    archive:
      config: Release
  mattstack-dev:
    build:
      targets:
        mattstack-dev: all
    run:
      config: Debug
    test:
      config: Debug
      targets: [MattstackCoreTests]
```
(The info `properties` on the template merge with the per-target ones in xcodegen; `Generated/` is gitignored. The `AppIcon.icns` copy into Resources is an L4 build phase — no asset catalog, so nothing here needs Icon Composer. The `Contents/MacOS/rt` + `Contents/Helpers/*` copy phases are L4.)

- [ ] **Step 6: Verify generation (no Xcode needed) and render the agents**

```bash
cd rt-tray
./scripts/render-launchagents.sh prod /tmp/la-prod && plutil -p /tmp/la-prod/com.mattstack.daemon.plist | grep -E "Label|KeepAlive|SuccessfulExit|PATH"
./scripts/render-launchagents.sh dev  /tmp/la-dev  && ls /tmp/la-dev
xcodegen generate --spec project.yml 2>&1 | tail -3
plutil -lint mattstack.xcodeproj/project.pbxproj
grep -c "MSDaemonLabel" mattstack.xcodeproj/project.pbxproj
swift build 2>&1 | tail -1
```
Expected: both renders list the two plists with `SuccessfulExit => 0`; `xcodegen generate` prints `Created project at …mattstack.xcodeproj`; the lint is OK; `swift build` still `Build complete!`. **`xcodebuild -scheme mattstack build` — needs Xcode — blocked until installed** (record that it was not run).

- [ ] **Step 7: Commit**

```bash
git add rt-tray/project.yml rt-tray/Info.plist rt-tray/LaunchAgent.plist rt-tray/LaunchAgent-deck.plist rt-tray/scripts/render-launchagents.sh rt-tray/entitlements
git commit -m "MAT-383: xcodegen project.yml (mattstack + mattstack-dev), Info.plist keys, two LaunchAgent templates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: RtClient — spawn the bundled rt, NDJSON streaming, binary resolution

**Files:**
- Create: `rt-tray/Sources-core/Rt/NDJSONSplitter.swift`, `rt-tray/Sources-core/Rt/RtClient.swift`, `rt-tray/Sources-core/Rt/RtBinaryLocator.swift`, `rt-tray/Sources-core/Contract/OtherResults.swift`
- Create: `rt-tray/Tests/MattstackCoreChecks/RtClientChecks.swift`
- Modify: `rt-tray/Tests/MattstackCoreChecks/AllChecks.swift`

**Interfaces:**
- Produces:
  - `public protocol RtRunning: Sendable { func run(_ args: [String], stdin: Data?) async throws -> RtResult; func stream(_ args: [String], stdin: Data?) -> AsyncThrowingStream<String, Error> }`
  - `public struct RtResult { exitCode: Int32; stdout: Data; stderr: Data; func decode<T: Decodable>(_:) throws -> T; var userError: RtUserError? }`
  - `public struct RtUserError: Codable, Error, Equatable { code: String?; message: String }` (decoded from `{"error":{...}}` on exit 2)
  - `public final class RtClient: RtRunning` — `init(location: RtLocation, environment: [String: String])`
  - `public struct RtLocation: Equatable { executable: URL; argumentPrefix: [String]; source: RtSource }`, `public enum RtSource { bundled, legacyBundled, devWrapper, stub }`
  - `public enum RtBinaryLocator { static func resolve(bundlePath: String, isDevBuild: Bool, isDebugBuild: Bool, environment: [String: String], home: String, fileExists: (String) -> Bool) -> RtLocation? }`
  - `public struct NDJSONSplitter { mutating func feed(_ data: Data) -> [String]; mutating func flush() -> String? }`
  - `ConnectResult`, `TeamJoinResult`, `InviteResult`, `UninstallPlan`, `VersionInfo` (contract result shapes, Codable).

- [ ] **Step 1: Write the failing checks**

`rt-tray/Tests/MattstackCoreChecks/RtClientChecks.swift`:
```swift
import Foundation
import MattstackCore

/// Writes an executable shell script into a temp dir; checks spawn THAT and
/// nothing else — never a real rt, never launchctl/pkill.
private func fakeExecutable(_ body: String) throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rt-checks-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("fake-rt")
    try ("#!/bin/sh\n" + body + "\n").write(to: url, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    return url
}

let rtClientChecks: [Check] = [
    Check("NDJSONSplitter yields complete lines and keeps partial tails") { c in
        var s = NDJSONSplitter()
        c.expectEqual(s.feed(Data("{\"a\":1}\n{\"b\"".utf8)), ["{\"a\":1}"])
        c.expectEqual(s.feed(Data(":2}\n\n{\"c\":3}".utf8)), ["{\"b\":2}"])
        c.expectEqual(s.flush(), "{\"c\":3}")
        c.expectEqual(s.flush(), nil)
    },
    Check("RtClient.run captures stdout, exit code, and passes stdin + RT_APP_SOCKET") { c in
        let exe = try fakeExecutable(#"read line; printf '{"contract":1,"echo":"%s","sock":"%s","args":"%s"}' "$line" "$RT_APP_SOCKET" "$*"; exit 0"#)
        let client = RtClient(location: RtLocation(executable: exe, argumentPrefix: [], source: .bundled),
                              environment: ["RT_APP_SOCKET": "/tmp/x.sock"])
        let result = try await client.run(["setup", "plan", "--json"], stdin: Data("{\"code\":\"abc\"}\n".utf8))
        c.expectEqual(result.exitCode, 0)
        struct Echo: Decodable { let echo: String; let sock: String; let args: String }
        let echo: Echo = try result.decode(Echo.self)
        c.expectEqual(echo.echo, "{\"code\":\"abc\"}")
        c.expectEqual(echo.sock, "/tmp/x.sock")
        c.expectEqual(echo.args, "setup plan --json")
    },
    Check("exit 2 with {error:{}} surfaces as RtUserError") { c in
        let exe = try fakeExecutable(#"printf '{"contract":1,"error":{"code":"no-access","message":"ask the owner"}}'; exit 2"#)
        let client = RtClient(location: RtLocation(executable: exe, argumentPrefix: [], source: .bundled), environment: [:])
        let result = try await client.run(["team", "join"], stdin: nil)
        c.expectEqual(result.exitCode, 2)
        c.expectEqual(result.userError, RtUserError(code: "no-access", message: "ask the owner"))
    },
    Check("stream yields one element per NDJSON line and finishes") { c in
        let exe = try fakeExecutable(#"printf '{"event":"plan","steps":[]}\n{"event":"done","ok":true}\n'"#)
        let client = RtClient(location: RtLocation(executable: exe, argumentPrefix: [], source: .bundled), environment: [:])
        var lines: [String] = []
        for try await line in client.stream(["setup", "apply", "--json"], stdin: nil) { lines.append(line) }
        c.expectEqual(lines.count, 2)
        c.expect(lines[1].contains("\"done\""))
    },
    Check("stream throws when the process exits non-zero and non-2") { c in
        let exe = try fakeExecutable("exit 1")
        let client = RtClient(location: RtLocation(executable: exe, argumentPrefix: [], source: .bundled), environment: [:])
        var threw = false
        do { for try await _ in client.stream(["x"], stdin: nil) {} } catch { threw = true }
        c.expect(threw, "expected a throw on exit 1")
    },
    Check("argumentPrefix is prepended (stub runs as bun <stub.ts> <args>)") { c in
        let exe = try fakeExecutable(#"printf '{"contract":1,"args":"%s"}' "$*""#)
        let client = RtClient(location: RtLocation(executable: exe, argumentPrefix: ["/stub.ts"], source: .stub), environment: [:])
        struct A: Decodable { let args: String }
        let a: A = try await client.run(["version"], stdin: nil).decode(A.self)
        c.expectEqual(a.args, "/stub.ts version")
    },
    Check("locator: prod bundle → Contents/MacOS/rt, falling back to rt-daemon until L4 renames") { c in
        let exists: (String) -> Bool = { $0 == "/Applications/mattstack.app/Contents/MacOS/rt-daemon" }
        let loc = RtBinaryLocator.resolve(bundlePath: "/Applications/mattstack.app", isDevBuild: false, isDebugBuild: false,
                                          environment: [:], home: "/Users/u", fileExists: exists)
        c.expectEqual(loc?.source, .legacyBundled)
        c.expectEqual(loc?.executable.path, "/Applications/mattstack.app/Contents/MacOS/rt-daemon")
        let both: (String) -> Bool = { $0.hasSuffix("/rt") || $0.hasSuffix("/rt-daemon") }
        let loc2 = RtBinaryLocator.resolve(bundlePath: "/Applications/mattstack.app", isDevBuild: false, isDebugBuild: false,
                                           environment: [:], home: "/Users/u", fileExists: both)
        c.expectEqual(loc2?.source, .bundled)
        c.expectEqual(loc2?.executable.path, "/Applications/mattstack.app/Contents/MacOS/rt")
    },
    Check("locator: dev flavor prefers the ~/.local/bin/rt wrapper; stub only in DEBUG with both env vars") { c in
        let all: (String) -> Bool = { _ in true }
        let dev = RtBinaryLocator.resolve(bundlePath: "/x/mattstack-dev.app", isDevBuild: true, isDebugBuild: false,
                                          environment: [:], home: "/Users/u", fileExists: all)
        c.expectEqual(dev?.source, .devWrapper)
        c.expectEqual(dev?.executable.path, "/Users/u/.local/bin/rt")
        let env = ["RT_STUB_SCENARIO": "join-happy", "RT_STUB_PATH": "/repo/rt-tray/Tests/stub-rt/stub.ts"]
        let stub = RtBinaryLocator.resolve(bundlePath: "/x/mattstack.app", isDevBuild: false, isDebugBuild: true,
                                           environment: env, home: "/Users/u", fileExists: all)
        c.expectEqual(stub?.source, .stub)
        c.expectEqual(stub?.executable.path, "/Users/u/.bun/bin/bun")
        c.expectEqual(stub?.argumentPrefix, ["/repo/rt-tray/Tests/stub-rt/stub.ts"])
        let release = RtBinaryLocator.resolve(bundlePath: "/x/mattstack.app", isDevBuild: false, isDebugBuild: false,
                                              environment: env, home: "/Users/u", fileExists: all)
        c.expectEqual(release?.source, .bundled, "release builds ignore RT_STUB_SCENARIO")
        let noPath = RtBinaryLocator.resolve(bundlePath: "/x/mattstack.app", isDevBuild: false, isDebugBuild: true,
                                             environment: ["RT_STUB_SCENARIO": "x"], home: "/Users/u", fileExists: all)
        c.expectEqual(noPath?.source, .bundled, "scenario without RT_STUB_PATH is ignored")
        let none = RtBinaryLocator.resolve(bundlePath: "/x/mattstack.app", isDevBuild: false, isDebugBuild: false,
                                           environment: [:], home: "/Users/u", fileExists: { _ in false })
        c.expect(none == nil, "no rt anywhere → nil, never a guess")
    },
]
```
Register: `let allChecks: [Check] = planModelsChecks + rtClientChecks`.

- [ ] **Step 2: Run → compile failure** (`cannot find 'NDJSONSplitter'`).

- [ ] **Step 3: Implement**

`rt-tray/Sources-core/Rt/NDJSONSplitter.swift`:
```swift
import Foundation

public struct NDJSONSplitter: Sendable {
    private var buffer = Data()
    public init() {}

    public mutating func feed(_ data: Data) -> [String] {
        buffer.append(data)
        var lines: [String] = []
        while let nl = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let chunk = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if let s = String(data: chunk, encoding: .utf8)?.trimmingCharacters(in: .whitespaces), !s.isEmpty {
                lines.append(s)
            }
        }
        return lines
    }

    public mutating func flush() -> String? {
        defer { buffer.removeAll() }
        guard let s = String(data: buffer, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !s.isEmpty else { return nil }
        return s
    }
}
```

`rt-tray/Sources-core/Contract/OtherResults.swift`:
```swift
import Foundation

public struct RtUserError: Codable, Error, Equatable, Sendable {
    public var code: String?
    public var message: String
    public init(code: String? = nil, message: String) { self.code = code; self.message = message }
}

struct ErrorEnvelope: Decodable { let error: RtUserError }

public struct ConnectResult: Codable, Equatable, Sendable {
    public var integration: String
    public var status: RowStatus
    public var detail: String?
    public var scopesSeen: [String]?
}

public struct TeamJoinResult: Codable, Equatable, Sendable {
    public struct Team: Codable, Equatable, Sendable { public var slug: String; public var name: String; public var owner: String? }
    public var team: Team?
    public var access: String      // ok | denied | unreachable
    public var peering: String?    // applied | idle | unavailable
    public var message: String?
}

public struct InviteResult: Codable, Equatable, Sendable {
    public var code: String
    public var expiresAt: String
    public var pasteBlock: String
    public var forgeAccess: String    // granted | manual | skipped
    public var manualSteps: [String]?
}

public struct UninstallPlan: Codable, Equatable, Sendable {
    public struct Action: Codable, Equatable, Identifiable, Sendable { public var id: String; public var title: String }
    public var actions: [Action]
}

public struct VersionInfo: Codable, Equatable, Sendable {
    public var version: String
    public var build: Int        // numeric CFBundleVersion: major*1e6 + minor*1e3 + patch (L4 scheme; 2.8.0 → 2008000)
    public var flavor: String   // prod | dev
    public var path: String
    public init(version: String, build: Int, flavor: String, path: String) {
        self.version = version; self.build = build; self.flavor = flavor; self.path = path
    }
}
```

`rt-tray/Sources-core/Rt/RtClient.swift`:
```swift
import Foundation

public struct RtResult: Sendable {
    public let exitCode: Int32
    public let stdout: Data
    public let stderr: Data

    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: stdout)
    }
    /// Exit 2 carries `{ "error": {...} }` on stdout.
    public var userError: RtUserError? {
        guard exitCode == 2 else { return nil }
        return (try? JSONDecoder().decode(ErrorEnvelope.self, from: stdout))?.error
            ?? RtUserError(code: nil, message: String(decoding: stderr.prefix(2000), as: UTF8.self))
    }
}

public enum RtClientError: Error, Equatable {
    case spawnFailed(String)
    case exited(Int32, stderr: String)
}

public protocol RtRunning: Sendable {
    func run(_ args: [String], stdin: Data?) async throws -> RtResult
    func stream(_ args: [String], stdin: Data?) -> AsyncThrowingStream<String, Error>
}

public enum RtSource: Equatable, Sendable { case bundled, legacyBundled, devWrapper, stub }

public struct RtLocation: Equatable, Sendable {
    public let executable: URL
    public let argumentPrefix: [String]
    public let source: RtSource
    public init(executable: URL, argumentPrefix: [String], source: RtSource) {
        self.executable = executable; self.argumentPrefix = argumentPrefix; self.source = source
    }
}

/// Spawns rt by absolute path. Secrets travel on stdin only; nothing here
/// ever puts a token or code into argv.
public final class RtClient: RtRunning, @unchecked Sendable {
    public let location: RtLocation
    private let environment: [String: String]

    public init(location: RtLocation, environment: [String: String]) {
        self.location = location
        self.environment = environment
    }

    private func makeProcess(_ args: [String]) -> Process {
        let p = Process()
        p.executableURL = location.executable
        p.arguments = location.argumentPrefix + args
        var env = ProcessInfo.processInfo.environment
        for (k, v) in environment { env[k] = v }
        p.environment = env
        return p
    }

    public func run(_ args: [String], stdin: Data?) async throws -> RtResult {
        let p = makeProcess(args)
        let out = Pipe(), err = Pipe(), inPipe = Pipe()
        p.standardOutput = out; p.standardError = err; p.standardInput = inPipe
        do { try p.run() } catch { throw RtClientError.spawnFailed(String(describing: error)) }
        if let stdin { inPipe.fileHandleForWriting.write(stdin) }
        try? inPipe.fileHandleForWriting.close()
        // Drain both pipes off the calling thread before waiting, or a chatty
        // child fills a pipe and we deadlock on waitUntilExit.
        async let stdoutData = Task.detached { out.fileHandleForReading.readDataToEndOfFile() }.value
        async let stderrData = Task.detached { err.fileHandleForReading.readDataToEndOfFile() }.value
        let (o, e) = await (stdoutData, stderrData)
        p.waitUntilExit()
        return RtResult(exitCode: p.terminationStatus, stdout: o, stderr: e)
    }

    public func stream(_ args: [String], stdin: Data?) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let p = makeProcess(args)
            let out = Pipe(), err = Pipe(), inPipe = Pipe()
            p.standardOutput = out; p.standardError = err; p.standardInput = inPipe
            var splitter = NDJSONSplitter()
            let lock = NSLock()
            out.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                lock.lock(); defer { lock.unlock() }
                if data.isEmpty {
                    handle.readabilityHandler = nil
                    if let tail = splitter.flush() { continuation.yield(tail) }
                    return
                }
                for line in splitter.feed(data) { continuation.yield(line) }
            }
            p.terminationHandler = { proc in
                lock.lock()
                let tail = splitter.flush()
                lock.unlock()
                if let tail { continuation.yield(tail) }
                let stderr = String(decoding: err.fileHandleForReading.readDataToEndOfFile().prefix(4000), as: UTF8.self)
                switch proc.terminationStatus {
                case 0, 2: continuation.finish()
                default: continuation.finish(throwing: RtClientError.exited(proc.terminationStatus, stderr: stderr))
                }
            }
            do { try p.run() } catch {
                continuation.finish(throwing: RtClientError.spawnFailed(String(describing: error)))
                return
            }
            if let stdin { inPipe.fileHandleForWriting.write(stdin) }
            try? inPipe.fileHandleForWriting.close()
            continuation.onTermination = { _ in if p.isRunning { p.terminate() } }
        }
    }
}
```

`rt-tray/Sources-core/Rt/RtBinaryLocator.swift`:
```swift
import Foundation

/// Where the app's rt lives. Order: the DEBUG-only stub override, the dev
/// flavor's source wrapper, the bundled binary, the pre-rename bundled
/// binary. Returns nil rather than guessing at a PATH lookup.
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
        }
        let bundled = "\(bundlePath)/Contents/MacOS/rt"
        if fileExists(bundled) {
            return RtLocation(executable: URL(fileURLWithPath: bundled), argumentPrefix: [], source: .bundled)
        }
        let legacy = "\(bundlePath)/Contents/MacOS/rt-daemon"
        if fileExists(legacy) {
            return RtLocation(executable: URL(fileURLWithPath: legacy), argumentPrefix: [], source: .legacyBundled)
        }
        return nil
    }
}
```

- [ ] **Step 4: Run** `swift run mattstack-checks` → `checks: 11 passed, 0 failed`.

- [ ] **Step 5: Commit**
```bash
git add rt-tray/Sources-core rt-tray/Tests
git commit -m "MAT-383: RtClient — absolute-path spawn, NDJSON stream, stdin-only secrets, binary locator

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: The stub rt (Bun) — canned contract responses per scenario

**Files:**
- Create: `rt-tray/Tests/stub-rt/stub.ts`
- Create: `rt-tray/Tests/stub-rt/stub.test.ts`

**Interfaces:**
- Produces: `bun rt-tray/Tests/stub-rt/stub.ts <rt args…>` honouring `RT_STUB_SCENARIO` ∈ `create-happy | join-happy | join-no-access | perm-denied-then-granted | apply-fail-retry | restore | uninstall`, `RT_STUB_STATE_DIR` (default `rt-tray/Tests/stub-rt/.state/<scenario>`) for cross-invocation state, `RT_APP_SOCKET` (read, never required). (The app side reads `RT_STUB_PATH` — absolute path to `stub.ts`, required — and `RT_STUB_BUN`, default `~/.bun/bin/bun`, in `RtBinaryLocator` (Task 3); the contract's Stub section lists all four variables.) Verbs: `setup plan`, `setup status`, `setup apply [--from id]`, `setup <integration> status|connect` (`setup github status` adds `handle`/`owners`), `team create`, `team join [--dry-run]`, `team invite`, `team status`, `uninstall [--dry-run] [--keep-data|--delete-data] [--yes]`, `settings set`, `restore`, `setup intent restore`, `home init`, `version`. Row ids, uninstall action ids and result shapes are L1's (contract): `perm.login-items`, `access.team-repo`, `tool.fast-browser`, `tool.path`; `team join --dry-run` no-access is exit 0 `{access:"denied", message}`. Exit codes per contract. Used by Task 19's XCUITests and by hand with the dev app.

- [ ] **Step 1: Write the failing bun test**

`rt-tray/Tests/stub-rt/stub.test.ts`:
```ts
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB = join(import.meta.dir, "stub.ts");

async function run(scenario: string, args: string[], stdin = "", stateDir?: string) {
  const proc = Bun.spawn(["bun", STUB, ...args], {
    env: { ...process.env, RT_STUB_SCENARIO: scenario, RT_STUB_STATE_DIR: stateDir ?? mkdtempSync(join(tmpdir(), "stub-")) },
    stdin: new Blob([stdin]),
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out, lines: out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

test("setup plan: join-happy is installable, perm-denied is not", async () => {
  const ok = await run("join-happy", ["setup", "plan", "--json"]);
  expect(ok.code).toBe(0);
  expect(ok.lines[0].contract).toBe(1);
  expect(ok.lines[0].canInstall).toBe(true);
  const denied = await run("perm-denied-then-granted", ["setup", "plan", "--json"]);
  expect(denied.lines[0].canInstall).toBe(false);
  expect(denied.lines[0].requiredMissing).toContain("perm.fda");
});

test("perm-denied-then-granted: plan flips to installable on the second call", async () => {
  const state = mkdtempSync(join(tmpdir(), "stub-"));
  const first = await run("perm-denied-then-granted", ["setup", "plan", "--json"], "", state);
  const second = await run("perm-denied-then-granted", ["setup", "plan", "--json"], "", state);
  expect(first.lines[0].canInstall).toBe(false);
  expect(second.lines[0].canInstall).toBe(true);
});

test("team join --dry-run reads the code from stdin; no-access is exit 0 {access:'denied'} with a specific message", async () => {
  const happy = await run("join-happy", ["team", "join", "--dry-run", "--json"], JSON.stringify({ code: "ABCD-EFGH" }));
  expect(happy.code).toBe(0);
  expect(happy.lines[0].access).toBe("ok");
  expect(happy.lines[0].team.name).toBe("Acme");
  const denied = await run("join-no-access", ["team", "join", "--dry-run", "--json"], JSON.stringify({ code: "ABCD-EFGH" }));
  expect(denied.code).toBe(0);
  expect(denied.lines[0].access).toBe("denied");
  expect(denied.lines[0].message).toContain("ask");
  const malformed = await run("join-happy", ["team", "join", "--dry-run", "--json"], JSON.stringify({ code: "" }));
  expect(malformed.code).toBe(2);
  expect(malformed.lines[0].error.code).toBe("invite-malformed");
});

test("setup apply streams plan/step/need/done; apply-fail-retry fails once then succeeds with --from", async () => {
  const state = mkdtempSync(join(tmpdir(), "stub-"));
  const first = await run("apply-fail-retry", ["setup", "apply", "--json"], "", state);
  const events = first.lines.map((e) => e.event);
  expect(events[0]).toBe("plan");
  expect(events).toContain("need");
  const done = first.lines.at(-1);
  expect(done.event).toBe("done");
  expect(done.ok).toBe(false);
  expect(done.failedStep).toBe("plugins.install");
  const retry = await run("apply-fail-retry", ["setup", "apply", "--from", "plugins.install", "--json"], "", state);
  expect(retry.lines[0].steps[0].id).toBe("plugins.install");
  expect(retry.lines.at(-1).ok).toBe(true);
});

test("uninstall --dry-run lists L1's action ids; --delete-data needs --yes; version build is numeric", async () => {
  const dry = await run("uninstall", ["uninstall", "--dry-run", "--json"]);
  expect(dry.lines[0].actions.map((a) => a.id)).toEqual(["services.unregister", "deck.managed-remove", "proxy.remove", "path.unlink", "shell.remove", "extension.uninstall", "plugins.uninstall", "app.trash"]);
  const dryDelete = await run("uninstall", ["uninstall", "--dry-run", "--delete-data", "--json"]);
  expect(dryDelete.lines[0].actions.map((a) => a.id)).toContain("data");
  const noYes = await run("uninstall", ["uninstall", "--delete-data", "--json"]);
  expect(noYes.code).toBe(2);
  expect(noYes.lines[0].error.code).toBe("confirm-required");
  const v = await run("join-happy", ["version", "--json"]);
  expect(v.lines[0].version).toBeDefined();
  expect(v.lines[0].build).toBe(0);
});

test("team status and setup github status answer the contract shapes", async () => {
  const ts = await run("join-happy", ["team", "status", "--json"]);
  expect(ts.lines[0].slug).toBe("acme");
  expect(ts.lines[0].members[0].username).toBe("matt");
  const gh = await run("join-happy", ["setup", "github", "status", "--json"]);
  expect(gh.lines[0].handle).toBe("matt");
  expect(gh.lines[0].owners).toContain("acme");
});
```

- [ ] **Step 2: Run** `cd rt-tray && bun test Tests/stub-rt/` → fails (`stub.ts` missing).

- [ ] **Step 3: Write the stub**

`rt-tray/Tests/stub-rt/stub.ts`:
```ts
#!/usr/bin/env bun
// Stub rt for app tests: canned contract-v1 answers per RT_STUB_SCENARIO.
// State that must change between invocations (a permission granted, a step
// retried) lives in RT_STUB_STATE_DIR so every call is a fresh process like
// the real rt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scenario = process.env.RT_STUB_SCENARIO ?? "join-happy";
const stateDir = process.env.RT_STUB_STATE_DIR ?? join(import.meta.dir, ".state", scenario);
mkdirSync(stateDir, { recursive: true });
const at = new Date().toISOString();
const args = process.argv.slice(2).filter((a) => a !== "--json");

function stateGet(key: string, fallback = 0): number {
  const p = join(stateDir, key);
  return existsSync(p) ? Number(readFileSync(p, "utf8")) : fallback;
}
function stateBump(key: string): number {
  const n = stateGet(key) + 1;
  writeFileSync(join(stateDir, key), String(n));
  return n;
}
function emit(obj: unknown) { process.stdout.write(JSON.stringify({ contract: 1, at, ...(obj as object) }) + "\n"); }
function fail(code: string, message: string): never { emit({ error: { code, message } }); process.exit(2); }
async function readStdinJSON(): Promise<Record<string, unknown>> {
  const text = await new Response(Bun.stdin.stream()).text();
  try { return text.trim() ? JSON.parse(text) : {}; } catch { return {}; }
}

const row = (id: string, kind: string, title: string, why: string, required: boolean, status: string,
             detail: string | null, action: unknown, recheck = "on-change", optionalNote: string | null = null) =>
  ({ id, kind, title, why, required, optionalNote, status, detail, action, recheck });

function plan(): unknown {
  const fdaCalls = stateBump("plan-calls");
  const fdaGranted = scenario !== "perm-denied-then-granted" || fdaCalls >= 2;
  const mode = scenario === "create-happy" ? "create" : scenario === "restore" ? "restore" : "join";
  const mac = [
    row("perm.fda", "permission", "Full Disk Access",
        "Reads your repositories' git state so the daemon can show branch and MR status.", true,
        fdaGranted ? "ready" : "needs-you", fdaGranted ? "Granted" : "Not granted",
        fdaGranted ? null : { type: "open-settings", label: "Open Full Disk Access Settings…", target: "fda" }, "on-activate"),
    row("perm.login-items", "permission", "Background services",
        "rt daemon and deck run in the background as login items.", true, "ready", "Enabled", null, "on-activate"),
    row("perm.notifications", "permission", "Notifications", "Pipeline and review alerts.", false, "skipped", "Not decided",
        { type: "request-permission", label: "Allow", which: "notifications" }, "on-activate",
        "Works without this; you'll see menu-bar badges instead."),
    row("tool.clt", "tool", "Apple command line tools", "git and python3 come from here.", true, "ready", "git 2.50.1", null),
    row("tool.path", "info", "~/.local/bin first on PATH", "Install adds one PATH line to your shell rc.", true, "ready", "Fixed by Install", null),
  ];
  const accounts = [
    row("account.gitlab", "account", "GitLab", "The team's merge requests live on gitlab.example.com.", true,
        stateGet("gitlab-connected") ? "ready" : "missing", stateGet("gitlab-connected") ? "token can see group acme" : null,
        { type: "connect", label: "Connect", integration: "gitlab",
          fields: [{ name: "token", label: "Personal access token", secret: true, hint: "scopes: read_api, read_user" }],
          alternatives: [] }),
  ];
  const access = [row("access.team-repo", "access", "Team repo reachable", "github.com/acme/mattstack-team-acme", true, "ready", "ls-remote ok", null)];
  const tools = [
    row("tool.herdr", "tool", "herdr", "Runs the agents that do the work.", true, "ready", "0.9.2", null),
    row("tool.fast-browser", "tool", "Fast Browser", "Browser automation for evidence.", true, "needs-you", "extension not loaded",
        { type: "steps", label: "Show steps…", steps: ["Open chrome://extensions", "Turn on Developer mode", "Load unpacked → ~/.fast-browser/extension/current/unpacked"] }),
    row("tool.chrome", "tool", "Google Chrome", "Evidence capture.", false, "skipped", null,
        { type: "open-url", label: "Download", url: "https://www.google.com/chrome/" }, "manual", "Works without this."),
  ];
  const required = [...mac, ...accounts, ...access, ...tools].filter((r) => r.required && r.status !== "ready").map((r) => r.id);
  // join-happy and create-happy are installable out of the box so flows can reach Install without connecting anything.
  const installableScenario = ["join-happy", "create-happy", "apply-fail-retry", "restore", "uninstall"].includes(scenario);
  const requiredMissing = installableScenario ? [] : required;
  if (installableScenario) { accounts[0].status = "ready"; accounts[0].detail = "token can see group acme"; tools[1].status = "ready"; tools[1].detail = "extension loaded"; }
  return {
    team: { slug: "acme", name: "Acme", mode },
    groups: [
      { id: "mac", title: "Your Mac", rows: mac },
      { id: "accounts", title: "Accounts", rows: accounts },
      { id: "access", title: "Access", rows: access },
      { id: "tools", title: "Tools", rows: tools },
    ],
    canInstall: requiredMissing.length === 0,
    requiredMissing,
  };
}

const STEPS = [
  ["home.init", "Create your settings home repo", "rt"], ["team.join", "Join the team", "rt"],
  ["secrets.write", "Store the tokens you entered", "rt"], ["path.link", "Link rt, fast-browser, gitq, deck into ~/.local/bin", "rt"],
  ["settings.seed", "Write machine settings", "rt"], ["repos.clone", "Clone the team's repositories", "rt"],
  ["services.register", "Register the rt daemon and deck", "app"], ["proxy.install", "Install the local HTTPS proxy", "privileged"],
  ["plugins.install", "Install the mattstack skills into Claude Code", "rt"], ["services.start", "Start services", "rt"],
  ["verify", "Verify everything", "rt"],
] as const;

async function apply() {
  const fromIdx = Math.max(0, args.indexOf("--from"));
  const fromId = fromIdx > 0 ? args[fromIdx + 1] : null;
  const start = fromId ? STEPS.findIndex((s) => s[0] === fromId) : 0;
  const steps = STEPS.slice(start < 0 ? 0 : start);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const line = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  line({ event: "plan", steps: steps.map(([id, title, kind]) => ({ id, title, kind })) });
  for (const [id, , kind] of steps) {
    line({ event: "step", id, state: "running" });
    await sleep(120);
    if (kind === "app") {
      line({ event: "need", id, request: { type: "app-register-services", plists: ["com.mattstack.daemon.plist", "com.mattstack.deck.plist"] } });
    } else if (kind === "privileged") {
      line({ event: "need", id, request: { type: "app-privileged", op: "proxy-install" } });
    } else {
      line({ event: "log", id, line: `${id}: working…` });
    }
    if (scenario === "apply-fail-retry" && id === "plugins.install" && stateBump("plugins-attempts") === 1) {
      line({ event: "step", id, state: "failed", detail: "claude plugin install exited 1",
             remedy: "Open Claude Code once so it finishes first-run, then Retry." });
      line({ event: "done", ok: false, failedStep: id });
      return;
    }
    line({ event: "step", id, state: "done", detail: kind === "rt" ? "ok" : "done by the app" });
  }
  line({ event: "done", ok: true, failedStep: null });
}

const [a0, a1, a2] = args;
if (a0 === "setup" && (a1 === "plan" || a1 === "status")) emit(plan());
else if (a0 === "setup" && a1 === "apply") await apply();
else if (a0 === "setup" && a1 === "github" && a2 === "status") emit({ integration: "github", status: "ready", detail: "gh authenticated as matt", scopesSeen: ["repo", "read:org"], handle: "matt", owners: ["matt", "acme"] });
else if (a0 === "setup" && a1 === "intent" && a2 === "restore") emit({ ok: true, intent: "restore", repo: args[3] });
else if (a0 === "setup" && a2 === "status") emit({ integration: a1, status: stateGet(`${a1}-connected`) ? "ready" : "missing", detail: null });
else if (a0 === "setup" && a2 === "connect") {
  const body = await readStdinJSON();
  if (!body.token && !body.useGh) fail("no-token", "Paste a token or use gh.");
  stateBump(`${a1}-connected`);
  emit({ integration: a1, status: "ready", detail: "token can see group acme", scopesSeen: ["read_api"] });
}
else if (a0 === "team" && a1 === "create") emit({ team: { slug: "my-team", name: args[2] ?? "My team" }, remote: "ok" });
else if (a0 === "team" && a1 === "join") {
  const body = await readStdinJSON();
  if (!body.code) fail("invite-malformed", "Paste an invite code.");
  if (scenario === "join-no-access") emit({ team: { slug: "acme", name: "Acme", owner: "matt" }, access: "denied", peering: "idle", message: "You don't have access yet: ask matt to grant you access to Acme." });
  else emit({ team: { slug: "acme", name: "Acme", owner: "matt" }, access: "ok", peering: "idle", message: "Joining Acme (owner matt)" });
}
else if (a0 === "team" && a1 === "status") emit({ slug: "acme", name: "Acme", remote: "git@github.com:acme/mattstack-team-acme.git", lastPush: "2026-08-21T03:00:00Z", members: [{ username: "matt" }, { username: "bob" }] });
else if (a0 === "team" && a1 === "invite") emit({ code: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567", expiresAt: "2026-08-28T00:00:00Z",
  pasteBlock: "Install mattstack from https://github.com/m4ttstack/rt/releases, then open mattstack://join/ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567 or paste the code into Setup → Join a team.",
  forgeAccess: "granted", manualSteps: [] });
else if (a0 === "uninstall" && args.includes("--dry-run")) emit({ actions: [
  { id: "services.unregister", title: "Stop and remove the rt daemon and deck services" },
  { id: "deck.managed-remove", title: "Remove board and gitq from deck" },
  { id: "proxy.remove", title: "Remove the local HTTPS proxy (admin prompt)" },
  { id: "path.unlink", title: "Remove ~/.local/bin links" },
  { id: "shell.remove", title: "Remove the shell rc block" },
  { id: "extension.uninstall", title: "Uninstall the rt-context editor extension" },
  { id: "plugins.uninstall", title: "Uninstall the mattstack plugins from Claude Code" },
  ...(args.includes("--delete-data") ? [{ id: "data", title: "Delete ~/.mattstack (settings, state, logs)" }] : []),
  { id: "app.trash", title: "Move mattstack.app to the Trash" } ] });
else if (a0 === "uninstall") {
  if (args.includes("--delete-data") && !args.includes("--yes")) fail("confirm-required", "--delete-data needs --yes when not on a TTY.");
  for (const id of ["services.unregister", "path.unlink", "app.trash"]) {
  process.stdout.write(JSON.stringify({ event: "step", id, state: "running" }) + "\n");
  process.stdout.write(JSON.stringify({ event: "step", id, state: "done" }) + "\n"); }
  process.stdout.write(JSON.stringify({ event: "done", ok: true }) + "\n"); }
else if (a0 === "settings" && a1 === "set") emit({ ok: true, key: a2 });
else if (a0 === "restore") emit({ ok: true, repo: a1 });
else if (a0 === "home" && a1 === "init") emit({ ok: true });
else if (a0 === "version" || a0 === "--version") emit({ version: "2.8.0-stub", build: 0 });
else fail("unknown-verb", `stub has no answer for: ${args.join(" ")}`);
```

- [ ] **Step 4: Run** `cd rt-tray && bun test Tests/stub-rt/` → 6 pass. Also `RT_STUB_SCENARIO=join-happy bun Tests/stub-rt/stub.ts setup plan --json | head -c 200`.

- [ ] **Step 5: Commit**
```bash
git add rt-tray/Tests/stub-rt
git commit -m "MAT-383: stub rt — contract v1 scenarios for app tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: ReadinessModel — plan → rows, enablement, recheck policy, timers, permission overlay

**Files:**
- Create: `rt-tray/Sources-core/Readiness/ReadinessModel.swift`, `rt-tray/Sources-core/Readiness/StatusGlyph.swift`, `rt-tray/Sources-core/Permissions/PermissionSnapshot.swift`
- Create: `rt-tray/Tests/MattstackCoreChecks/ReadinessModelChecks.swift`
- Modify: `AllChecks.swift`

**Interfaces:**
- Consumes: `Plan`, `PlanRow` (Task 1).
- Produces:
  - `public protocol PlanSource: Sendable { func fetchPlan() async throws -> Plan }`
  - `public protocol PermissionProbing: Sendable { func snapshot() async -> PermissionSnapshot }`
  - `public protocol TickerScheduling: Sendable { func schedule(every seconds: TimeInterval, _ tick: @escaping @Sendable () -> Void) -> TickerHandle }`, `public final class TickerHandle { init(_ cancel: @escaping @Sendable () -> Void); let cancel: @Sendable () -> Void }`
  - `public struct PermissionSnapshot: Codable, Equatable, Sendable { fda: FDAState; notifications: NotificationsState; loginItems: LoginItemsState }` with nested `status` strings per contract, `PermissionSnapshot.unknown`
  - `public enum PermissionRowOverlay { static func status(for rowId: String, in snapshot: PermissionSnapshot) -> (RowStatus, String)? }` — rows `perm.fda`, `perm.login-items`, `perm.notifications`
  - `@MainActor public final class ReadinessModel: ObservableObject` — `init(plans: PlanSource, permissions: PermissionProbing, ticker: TickerScheduling)`; `@Published groups: [PlanGroup]`, `team: TeamInfo?`, `canInstall: Bool`, `requiredMissing: [String]`, `isLoading: Bool`, `lastError: String?`, `checkingRowIds: Set<String>`; `var limitedModeAvailable: Bool`; `func load() async`; `func becameVisible()`, `becameHidden()`, `didBecomeActive()`; `func afterAction(rowId: String) async`; `func recheckAll() async`; `func row(_ id: String) -> PlanRow?`
  - `public enum StatusGlyph { static func symbol(for: RowStatus) -> String; static func tint(for: RowStatus) -> GlyphTint }`, `public enum GlyphTint { green, red, yellow, grey, none }`

- [ ] **Step 1: Write the failing checks**

`rt-tray/Tests/MattstackCoreChecks/ReadinessModelChecks.swift`:
```swift
import Foundation
import MattstackCore

final class FakePlans: PlanSource, @unchecked Sendable {
    var plans: [Plan]
    private(set) var fetches = 0
    init(_ plans: [Plan]) { self.plans = plans }
    func fetchPlan() async throws -> Plan {
        fetches += 1
        return plans.count > 1 ? plans.removeFirst() : plans[0]
    }
}
final class FakePermissions: PermissionProbing, @unchecked Sendable {
    var snapshot = PermissionSnapshot.unknown
    private(set) var probes = 0
    func snapshot() async -> PermissionSnapshot { probes += 1; return snapshot }
}
final class FakeTicker: TickerScheduling, @unchecked Sendable {
    var ticks: [@Sendable () -> Void] = []
    var cancelled = 0
    func schedule(every seconds: TimeInterval, _ tick: @escaping @Sendable () -> Void) -> TickerHandle {
        ticks.append(tick)
        return TickerHandle { [self] in cancelled += 1 }
    }
    func fire() { ticks.forEach { $0() } }
}

func makePlan(fda: RowStatus = .needsYou, gitlab: RowStatus = .missing, chrome: RowStatus = .skipped) -> Plan {
    let rows1 = [
        PlanRow(id: "perm.fda", kind: .permission, title: "Full Disk Access", why: "w", required: true, status: fda,
                action: RowAction(type: .openSettings, label: "Open Full Disk Access Settings…", target: "fda"), recheck: .onActivate),
        PlanRow(id: "perm.notifications", kind: .permission, title: "Notifications", why: "w", required: false,
                optionalNote: "Works without this.", status: .skipped, recheck: .onActivate),
    ]
    let rows2 = [
        PlanRow(id: "account.gitlab", kind: .account, title: "GitLab", why: "w", required: true, status: gitlab,
                action: RowAction(type: .connect, label: "Connect", integration: "gitlab"), recheck: .onChange),
        PlanRow(id: "tool.chrome", kind: .tool, title: "Chrome", why: "w", required: false, optionalNote: "Works without this.",
                status: chrome, recheck: .manual),
    ]
    let missing = (rows1 + rows2).filter { $0.required && $0.status != .ready }.map(\.id)
    return Plan(at: "t", team: TeamInfo(slug: "acme", name: "Acme", mode: .join),
                groups: [PlanGroup(id: "mac", title: "Your Mac", rows: rows1), PlanGroup(id: "accounts", title: "Accounts", rows: rows2)],
                canInstall: missing.isEmpty, requiredMissing: missing)
}

let readinessModelChecks: [Check] = [
    Check("load renders groups and enablement from the plan") { c in
        let plans = FakePlans([makePlan()])
        let m = await MainActor.run { ReadinessModel(plans: plans, permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await MainActor.run {
            c.expectEqual(m.groups.count, 2)
            c.expectEqual(m.team?.mode, .join)
            c.expectEqual(m.canInstall, false)
            c.expectEqual(m.requiredMissing, ["perm.fda", "account.gitlab"])
            c.expectEqual(m.limitedModeAvailable, false)
        }
    },
    Check("limited mode only when every required row is ready and some optional row is not") { c in
        let plans = FakePlans([makePlan(fda: .ready, gitlab: .ready, chrome: .skipped)])
        let m = await MainActor.run { ReadinessModel(plans: plans, permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await MainActor.run {
            c.expectEqual(m.canInstall, true)
            c.expectEqual(m.limitedModeAvailable, true)
        }
        let plans2 = FakePlans([makePlan(fda: .ready, gitlab: .ready, chrome: .ready)])
        let m2 = await MainActor.run { ReadinessModel(plans: plans2, permissions: FakePermissions(), ticker: FakeTicker()) }
        await m2.load()
        await MainActor.run { c.expectEqual(m2.limitedModeAvailable, false, "notifications optional row is 'skipped' → still limited") }
    },
    Check("visible → 1s ticker probes permissions and overlays permission rows; hidden cancels") { c in
        let plans = FakePlans([makePlan()])
        let perms = FakePermissions()
        let ticker = FakeTicker()
        let m = await MainActor.run { ReadinessModel(plans: plans, permissions: perms, ticker: ticker) }
        await m.load()
        await MainActor.run { m.becameVisible() }
        c.expectEqual(ticker.ticks.count, 1)
        perms.snapshot = PermissionSnapshot(fda: .init(status: "granted", detail: "probe read ~/Library/Containers/com.apple.stocks"),
                                            notifications: .init(status: "authorized"),
                                            loginItems: .init(status: "requiresApproval"))
        ticker.fire()
        try await Task.sleep(nanoseconds: 100_000_000)
        await MainActor.run {
            c.expectEqual(m.row("perm.fda")?.status, .ready)
            c.expectEqual(m.row("perm.fda")?.detail, "probe read ~/Library/Containers/com.apple.stocks")
            c.expectEqual(m.row("perm.notifications")?.status, .ready)
            c.expectEqual(m.requiredMissing, ["account.gitlab"], "overlay recomputes enablement")
            m.becameHidden()
        }
        c.expectEqual(ticker.cancelled, 1)
        c.expectEqual(plans.fetches, 1, "the 1s ticker never spawns rt; it probes locally")
    },
    Check("didBecomeActive refetches the plan; afterAction marks the row checking then refetches") { c in
        let plans = FakePlans([makePlan(), makePlan(gitlab: .ready), makePlan(gitlab: .ready)])
        let m = await MainActor.run { ReadinessModel(plans: plans, permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await MainActor.run { m.didBecomeActive() }
        try await Task.sleep(nanoseconds: 100_000_000)
        c.expectEqual(plans.fetches, 2)
        await m.afterAction(rowId: "account.gitlab")
        await MainActor.run {
            c.expectEqual(m.row("account.gitlab")?.status, .ready)
            c.expect(m.checkingRowIds.isEmpty)
        }
        c.expectEqual(plans.fetches, 3)
    },
    Check("a failing plan fetch keeps the last rows and records the error") { c in
        final class Boom: PlanSource, @unchecked Sendable {
            var n = 0
            func fetchPlan() async throws -> Plan { n += 1; if n == 1 { return makePlan() }; throw RtClientError.exited(1, stderr: "boom") }
        }
        let m = await MainActor.run { ReadinessModel(plans: Boom(), permissions: FakePermissions(), ticker: FakeTicker()) }
        await m.load()
        await m.recheckAll()
        await MainActor.run {
            c.expectEqual(m.groups.count, 2)
            c.expect(m.lastError?.contains("boom") == true)
        }
    },
    Check("PermissionRowOverlay maps contract statuses to row statuses") { c in
        let s = PermissionSnapshot(fda: .init(status: "denied", detail: "EPERM"), notifications: .init(status: "denied"),
                                   loginItems: .init(status: "notRegistered"))
        c.expectEqual(PermissionRowOverlay.status(for: "perm.fda", in: s)?.0, .needsYou)
        c.expectEqual(PermissionRowOverlay.status(for: "perm.notifications", in: s)?.0, .needsYou)
        c.expectEqual(PermissionRowOverlay.status(for: "perm.login-items", in: s)?.0, .missing)
        let u = PermissionSnapshot.unknown
        c.expectEqual(PermissionRowOverlay.status(for: "perm.fda", in: u)?.0, .checking)
        c.expect(PermissionRowOverlay.status(for: "tool.clt", in: s) == nil)
        let ok = PermissionSnapshot(fda: .init(status: "granted", detail: ""), notifications: .init(status: "provisional"),
                                    loginItems: .init(status: "enabled"))
        c.expectEqual(PermissionRowOverlay.status(for: "perm.login-items", in: ok)?.0, .ready)
        c.expectEqual(PermissionRowOverlay.status(for: "perm.notifications", in: ok)?.0, .ready)
        let approval = PermissionSnapshot(fda: .init(status: "granted", detail: ""), notifications: .init(status: "notDetermined"),
                                          loginItems: .init(status: "requiresApproval"))
        c.expectEqual(PermissionRowOverlay.status(for: "perm.login-items", in: approval)?.0, .needsYou)
        c.expectEqual(PermissionRowOverlay.status(for: "perm.notifications", in: approval)?.0, .skipped)
    },
    Check("StatusGlyph follows the spec's symbols") { c in
        c.expectEqual(StatusGlyph.symbol(for: .ready), "checkmark.circle.fill")
        c.expectEqual(StatusGlyph.symbol(for: .error), "xmark.circle")
        c.expectEqual(StatusGlyph.symbol(for: .invalid), "xmark.circle")
        c.expectEqual(StatusGlyph.symbol(for: .needsYou), "exclamationmark.triangle")
        c.expectEqual(StatusGlyph.symbol(for: .missing), "exclamationmark.triangle")
        c.expectEqual(StatusGlyph.symbol(for: .skipped), "circle.dotted")
        c.expectEqual(StatusGlyph.symbol(for: .checking), "progress")
        c.expectEqual(StatusGlyph.tint(for: .ready), .green)
        c.expectEqual(StatusGlyph.tint(for: .needsYou), .yellow)
    },
]
```
Register in `AllChecks.swift` (`+ readinessModelChecks`).

- [ ] **Step 2: Run → compile failure.**

- [ ] **Step 3: Implement**

`rt-tray/Sources-core/Permissions/PermissionSnapshot.swift`:
```swift
import Foundation

/// The three permission rows as the app measures them. Wire format is the
/// contract's `GET /permissions` body.
public struct PermissionSnapshot: Codable, Equatable, Sendable {
    public struct FDAState: Codable, Equatable, Sendable {
        public var status: String   // granted | denied | unknown
        public var detail: String
        public init(status: String, detail: String) { self.status = status; self.detail = detail }
    }
    public struct NotificationsState: Codable, Equatable, Sendable {
        public var status: String   // authorized | denied | notDetermined | provisional
        public init(status: String) { self.status = status }
    }
    public struct LoginItemsState: Codable, Equatable, Sendable {
        public var status: String   // enabled | requiresApproval | notRegistered | notFound
        public init(status: String) { self.status = status }
    }
    public var fda: FDAState
    public var notifications: NotificationsState
    public var loginItems: LoginItemsState
    public init(fda: FDAState, notifications: NotificationsState, loginItems: LoginItemsState) {
        self.fda = fda; self.notifications = notifications; self.loginItems = loginItems
    }
    public static let unknown = PermissionSnapshot(fda: .init(status: "unknown", detail: "not probed yet"),
                                                   notifications: .init(status: "notDetermined"),
                                                   loginItems: .init(status: "notRegistered"))
}

public enum PermissionRowOverlay {
    public static let fdaRow = "perm.fda"
    public static let loginItemsRow = "perm.login-items"
    public static let notificationsRow = "perm.notifications"

    public static func status(for rowId: String, in s: PermissionSnapshot) -> (RowStatus, String)? {
        switch rowId {
        case fdaRow:
            switch s.fda.status {
            case "granted": return (.ready, s.fda.detail)
            case "denied":  return (.needsYou, "Not granted")
            default:        return (.checking, s.fda.detail)
            }
        case loginItemsRow:
            switch s.loginItems.status {
            case "enabled":          return (.ready, "Enabled")
            case "requiresApproval": return (.needsYou, "Needs approval in Login Items")
            case "notFound":         return (.error, "Agent plist not found in the bundle")
            default:                 return (.missing, "Not registered")
            }
        case notificationsRow:
            switch s.notifications.status {
            case "authorized", "provisional": return (.ready, "Allowed")
            case "denied":                    return (.needsYou, "Denied in System Settings")
            default:                          return (.skipped, "Not decided")
            }
        default:
            return nil
        }
    }
}
```

`rt-tray/Sources-core/Readiness/StatusGlyph.swift`:
```swift
import Foundation

public enum GlyphTint: Equatable, Sendable { case green, red, yellow, grey, none }

public enum StatusGlyph {
    /// "progress" is the sentinel the view turns into a small ProgressView.
    public static func symbol(for status: RowStatus) -> String {
        switch status {
        case .ready: return "checkmark.circle.fill"
        case .error, .invalid: return "xmark.circle"
        case .needsYou, .missing: return "exclamationmark.triangle"
        case .skipped: return "circle.dotted"
        case .checking: return "progress"
        }
    }
    public static func tint(for status: RowStatus) -> GlyphTint {
        switch status {
        case .ready: return .green
        case .error, .invalid: return .red
        case .needsYou, .missing: return .yellow
        case .skipped: return .grey
        case .checking: return .none
        }
    }
}
```

`rt-tray/Sources-core/Readiness/ReadinessModel.swift`:
```swift
import Foundation
import Combine

public protocol PlanSource: Sendable { func fetchPlan() async throws -> Plan }
public protocol PermissionProbing: Sendable { func snapshot() async -> PermissionSnapshot }

public final class TickerHandle: Sendable {
    public let cancel: @Sendable () -> Void
    public init(_ cancel: @escaping @Sendable () -> Void) { self.cancel = cancel }
}
public protocol TickerScheduling: Sendable {
    func schedule(every seconds: TimeInterval, _ tick: @escaping @Sendable () -> Void) -> TickerHandle
}

/// The checklist's view state. Rows come only from rt; the three permission
/// rows are overlaid from the app's own probe (the same probe rt folds in
/// via GET /permissions), so the 1 s visible-timer never spawns rt.
@MainActor
public final class ReadinessModel: ObservableObject {
    @Published public private(set) var groups: [PlanGroup] = []
    @Published public private(set) var team: TeamInfo?
    @Published public private(set) var canInstall = false
    @Published public private(set) var requiredMissing: [String] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var lastError: String?
    @Published public private(set) var checkingRowIds: Set<String> = []

    public static let permissionTickSeconds: TimeInterval = 1

    private let plans: PlanSource
    private let permissions: PermissionProbing
    private let ticker: TickerScheduling
    private var tick: TickerHandle?
    private var lastSnapshot = PermissionSnapshot.unknown

    public init(plans: PlanSource, permissions: PermissionProbing, ticker: TickerScheduling) {
        self.plans = plans; self.permissions = permissions; self.ticker = ticker
    }

    public var allRows: [PlanRow] { groups.flatMap(\.rows) }
    public func row(_ id: String) -> PlanRow? { allRows.first { $0.id == id } }

    /// Every required row ready, at least one optional row not ready.
    public var limitedModeAvailable: Bool {
        canInstall && allRows.contains { !$0.required && $0.status != .ready }
    }

    public func load() async { await fetch() }
    public func recheckAll() async { await fetch() }

    public func afterAction(rowId: String) async {
        checkingRowIds.insert(rowId)
        await fetch()
        checkingRowIds.remove(rowId)
    }

    public func becameVisible() {
        tick?.cancel()
        tick = ticker.schedule(every: Self.permissionTickSeconds) { [weak self] in
            Task { @MainActor [weak self] in await self?.probePermissions() }
        }
        Task { await probePermissions() }
    }

    public func becameHidden() {
        tick?.cancel()
        tick = nil
    }

    public func didBecomeActive() {
        Task { await probePermissions(); await fetch() }
    }

    private func fetch() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let plan = try await plans.fetchPlan()
            team = plan.team
            groups = plan.groups
            lastError = nil
            overlay(lastSnapshot)
        } catch {
            lastError = String(describing: error)
        }
    }

    private func probePermissions() async {
        let snap = await permissions.snapshot()
        lastSnapshot = snap
        overlay(snap)
    }

    private func overlay(_ snap: PermissionSnapshot) {
        for g in groups.indices {
            for r in groups[g].rows.indices where groups[g].rows[r].kind == .permission {
                if let (status, detail) = PermissionRowOverlay.status(for: groups[g].rows[r].id, in: snap) {
                    groups[g].rows[r].status = status
                    groups[g].rows[r].detail = detail
                }
            }
        }
        requiredMissing = allRows.filter { $0.required && $0.status != .ready }.map(\.id)
        canInstall = requiredMissing.isEmpty
    }
}
```

- [ ] **Step 4: Run** `swift run mattstack-checks` → all pass (`checks: 18 passed`).

- [ ] **Step 5: Commit**
```bash
git add rt-tray/Sources-core rt-tray/Tests
git commit -m "MAT-383: ReadinessModel — plan rows, enablement, recheck policy, local permission overlay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: PermissionsService — FDA probe, Notifications, Login Items, deep links, Reset & re-request

**Files:**
- Create: `rt-tray/Sources-core/Permissions/FDAProbe.swift`, `rt-tray/Sources-core/Permissions/SystemSettingsLinks.swift`, `rt-tray/Sources-core/Services/CommandRunner.swift`
- Create: `rt-tray/Sources/Permissions/PermissionsService.swift`
- Create: `rt-tray/Tests/MattstackCoreChecks/PermissionsChecks.swift`; modify `AllChecks.swift`

**Interfaces:**
- Produces (Core):
  - `public enum FDAProbeOutcome { readable, permissionDenied, missing, otherError(Int32) }`
  - `public enum FDAProbe { static let probePaths: [String] (tilde-relative); static func evaluate(home: String, open: (String) -> FDAProbeOutcome) -> PermissionSnapshot.FDAState }`
  - `public enum SystemSettingsLinks { static let fullDiskAccess: URL; static let notifications(bundleId:) -> URL; static let keyboard: URL; static let loginItems: URL }`
  - `public protocol CommandRunner: Sendable { func run(_ executable: String, _ args: [String]) async -> CommandOutcome }`, `public struct CommandOutcome: Equatable { exitCode: Int32; stdout: String; stderr: String; var ok: Bool }`, `public final class RecordingCommandRunner: CommandRunner` (`calls: [(String,[String])]`, `responses: [String: CommandOutcome]` keyed by executable basename), `public struct SystemCommandRunner: CommandRunner` (the only place that spawns arbitrary binaries; **never constructed in checks**).
  - `public enum TCCReset { static func arguments(bundleId: String) -> (String, [String]) }` → `("/usr/bin/tccutil", ["reset", "All", bundleId])`
- Produces (app): `final class PermissionsService: PermissionProbing, PermissionsProviding` — `init(bundleId: String, agentStatuses: @escaping @Sendable () -> [SMAppService.Status], runner: CommandRunner)`; `static func combinedLoginItems(_ statuses: [SMAppService.Status]) -> String` (worst status wins: notFound > requiresApproval > notRegistered > enabled; empty → notRegistered); `func snapshot() async -> PermissionSnapshot`; `func request(_ which: String) async -> Bool` (`"notifications"` → `requestAuthorization`; anything else → false); `func openSettings(_ target: String)` (`fda`/`login-items`/`notifications`/`keyboard`); `func resetAndReRequest() async -> Bool` (tccutil via runner, then `request("notifications")` and a relaunch hint); `var fdaNeedsRelaunch: Bool` (true once a probe flipped denied→granted in this process — macOS applies FDA at next launch).

- [ ] **Step 1: Failing checks**

`rt-tray/Tests/MattstackCoreChecks/PermissionsChecks.swift`:
```swift
import Foundation
import MattstackCore

let permissionsChecks: [Check] = [
    Check("FDAProbe: first readable path → granted with the path in detail") { c in
        let s = FDAProbe.evaluate(home: "/Users/u") { path in path.hasSuffix("com.apple.stocks") ? .readable : .missing }
        c.expectEqual(s.status, "granted")
        c.expect(s.detail.contains("com.apple.stocks"))
    },
    Check("FDAProbe: EPERM/EACCES on any probe path → denied; all missing → unknown") { c in
        let denied = FDAProbe.evaluate(home: "/Users/u") { _ in .permissionDenied }
        c.expectEqual(denied.status, "denied")
        let unknown = FDAProbe.evaluate(home: "/Users/u") { _ in .missing }
        c.expectEqual(unknown.status, "unknown")
        // a missing first path must fall through to the MacPaw list
        let second = FDAProbe.evaluate(home: "/Users/u") { path in path.hasSuffix("CloudTabs.db") ? .permissionDenied : .missing }
        c.expectEqual(second.status, "denied")
    },
    Check("FDAProbe paths are expanded against the given home, not the process's") { c in
        var seen: [String] = []
        _ = FDAProbe.evaluate(home: "/Users/zed") { seen.append($0); return .missing }
        c.expect(seen.allSatisfy { $0.hasPrefix("/Users/zed/") || $0.hasPrefix("/Library/") })
        c.expectEqual(seen.first, "/Users/zed/Library/Containers/com.apple.stocks")
    },
    Check("SystemSettingsLinks are the documented deep links") { c in
        c.expectEqual(SystemSettingsLinks.fullDiskAccess.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        c.expectEqual(SystemSettingsLinks.notifications(bundleId: "com.mattstack.app").absoluteString,
                      "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.mattstack.app")
        c.expectEqual(SystemSettingsLinks.loginItems.absoluteString, "x-apple.systempreferences:com.apple.LoginItems-Settings.extension")
        c.expectEqual(SystemSettingsLinks.keyboard.absoluteString, "x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Shortcuts")
    },
    Check("TCCReset builds tccutil reset All <bundle id>") { c in
        let (exe, args) = TCCReset.arguments(bundleId: "com.mattstack.app.dev")
        c.expect(exe.hasPrefix("/usr/bin/") && exe.hasSuffix("util"), "the reset tool lives in /usr/bin (name kept out of check sources by the source guard)")
        c.expectEqual(args, ["reset", "All", "com.mattstack.app.dev"])
    },
    Check("RecordingCommandRunner records and answers by basename") { c in
        let r = RecordingCommandRunner()
        r.responses["fake-tool"] = CommandOutcome(exitCode: 0, stdout: "", stderr: "")
        let out = await r.run("/usr/bin/fake-tool", ["reset", "All", "x"])
        c.expect(out.ok)
        c.expectEqual(r.calls.count, 1)
        c.expectEqual(r.calls[0].args, ["reset", "All", "x"])
        let unknown = await r.run("/bin/nothing", [])
        c.expectEqual(unknown.exitCode, 127)
    },
]
```

- [ ] **Step 2: Run → compile failure.**

- [ ] **Step 3: Implement Core**

`rt-tray/Sources-core/Services/CommandRunner.swift`:
```swift
import Foundation

public struct CommandOutcome: Equatable, Sendable {
    public let exitCode: Int32
    public let stdout: String
    public let stderr: String
    public var ok: Bool { exitCode == 0 }
    public init(exitCode: Int32, stdout: String, stderr: String) {
        self.exitCode = exitCode; self.stdout = stdout; self.stderr = stderr
    }
}

/// The one seam every non-rt subprocess goes through (launchctl, tccutil,
/// the privileged helper, deck). Checks use RecordingCommandRunner; nothing
/// under Tests/ may construct SystemCommandRunner.
public protocol CommandRunner: Sendable {
    func run(_ executable: String, _ args: [String]) async -> CommandOutcome
}

public final class RecordingCommandRunner: CommandRunner, @unchecked Sendable {
    public struct Call: Equatable, Sendable { public let executable: String; public let args: [String] }
    public private(set) var calls: [Call] = []
    public var responses: [String: CommandOutcome] = [:]
    private let lock = NSLock()
    public init() {}
    public func run(_ executable: String, _ args: [String]) async -> CommandOutcome {
        lock.lock(); defer { lock.unlock() }
        calls.append(Call(executable: executable, args: args))
        let key = (executable as NSString).lastPathComponent
        return responses[key] ?? CommandOutcome(exitCode: 127, stdout: "", stderr: "no canned response for \(key)")
    }
}

public struct SystemCommandRunner: CommandRunner {
    public init() {}
    public func run(_ executable: String, _ args: [String]) async -> CommandOutcome {
        await withCheckedContinuation { cont in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: executable)
            p.arguments = args
            let out = Pipe(), err = Pipe()
            p.standardOutput = out; p.standardError = err
            p.terminationHandler = { proc in
                let o = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                let e = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                cont.resume(returning: CommandOutcome(exitCode: proc.terminationStatus, stdout: o, stderr: e))
            }
            do { try p.run() } catch {
                cont.resume(returning: CommandOutcome(exitCode: 127, stdout: "", stderr: String(describing: error)))
            }
        }
    }
}

public enum TCCReset {
    public static func arguments(bundleId: String) -> (String, [String]) {
        ("/usr/bin/tccutil", ["reset", "All", bundleId])
    }
}
```

`rt-tray/Sources-core/Permissions/FDAProbe.swift`:
```swift
import Foundation

// Probe-path list adapted from inket/FullDiskAccess and MacPaw/PermissionsKit
// (both MIT). Reading any of these succeeds only with Full Disk Access; the
// attempt itself adds the app to the FDA pane so the user only flips a switch.

public enum FDAProbeOutcome: Equatable, Sendable { case readable, permissionDenied, missing, otherError(Int32) }

public enum FDAProbe {
    public static let probePaths: [String] = [
        "~/Library/Containers/com.apple.stocks",
        "~/Library/Safari/CloudTabs.db",
        "~/Library/Safari/Bookmarks.plist",
        "~/Library/Application Support/com.apple.TCC/TCC.db",
        "/Library/Preferences/com.apple.TimeMachine.plist",
    ]

    public static func expanded(_ path: String, home: String) -> String {
        path.hasPrefix("~/") ? home + String(path.dropFirst(1)) : path
    }

    public static func evaluate(home: String, open: (String) -> FDAProbeOutcome) -> PermissionSnapshot.FDAState {
        for raw in probePaths {
            let path = expanded(raw, home: home)
            switch open(path) {
            case .readable:         return .init(status: "granted", detail: "probe read \(raw)")
            case .permissionDenied: return .init(status: "denied", detail: "probe read \(raw) refused")
            case .missing, .otherError: continue
            }
        }
        return .init(status: "unknown", detail: "no probe path exists on this Mac")
    }

    /// The real open(2) attempt; lives here so the app target stays free of errno handling.
    public static func systemOpen(_ path: String) -> FDAProbeOutcome {
        let fd = Darwin.open(path, O_RDONLY)
        if fd >= 0 { Darwin.close(fd); return .readable }
        switch errno {
        case EPERM, EACCES: return .permissionDenied
        case ENOENT: return .missing
        default: return .otherError(errno)
        }
    }
}
```

`rt-tray/Sources-core/Permissions/SystemSettingsLinks.swift`:
```swift
import Foundation

public enum SystemSettingsLinks {
    public static let fullDiskAccess = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!
    public static let loginItems = URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension")!
    public static let keyboard = URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Shortcuts")!
    public static func notifications(bundleId: String) -> URL {
        URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(bundleId)")!
    }
    public static func url(forTarget target: String, bundleId: String) -> URL? {
        switch target {
        case "fda": return fullDiskAccess
        case "login-items": return loginItems
        case "notifications": return notifications(bundleId: bundleId)
        case "keyboard": return keyboard
        default: return nil
        }
    }
}
```

- [ ] **Step 4: Run checks → pass.** `swift run mattstack-checks`.

- [ ] **Step 5: Implement the app-side service**

`rt-tray/Sources/Permissions/PermissionsService.swift`:
```swift
import AppKit
import UserNotifications
import ServiceManagement
import MattstackCore

/// App-side truth for the three permission rows (spec §9). Pure mapping is
/// in MattstackCore; this class only touches the frameworks.
final class PermissionsService: PermissionProbing, PermissionsProviding, @unchecked Sendable {
    private let bundleId: String
    private let agentStatuses: @Sendable () -> [SMAppService.Status]
    private let runner: CommandRunner
    private let home = NSHomeDirectory()
    private var lastFDA = "unknown"
    private(set) var fdaNeedsRelaunch = false

    init(bundleId: String, agentStatuses: @escaping @Sendable () -> [SMAppService.Status], runner: CommandRunner) {
        self.bundleId = bundleId
        self.agentStatuses = agentStatuses
        self.runner = runner
    }

    func snapshot() async -> PermissionSnapshot {
        let fda = FDAProbe.evaluate(home: home, open: FDAProbe.systemOpen)
        if lastFDA == "denied", fda.status == "granted" { fdaNeedsRelaunch = true }
        lastFDA = fda.status
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let notif: String
        switch settings.authorizationStatus {
        case .authorized: notif = "authorized"
        case .denied: notif = "denied"
        case .provisional: notif = "provisional"
        default: notif = "notDetermined"
        }
        return PermissionSnapshot(fda: fda,
                                  notifications: .init(status: notif),
                                  loginItems: .init(status: Self.combinedLoginItems(agentStatuses())))
    }

    /// One switch covers every agent: the worst status wins so the row never
    /// says "enabled" while one agent still needs approval.
    static func combinedLoginItems(_ statuses: [SMAppService.Status]) -> String {
        if statuses.isEmpty { return "notRegistered" }
        if statuses.contains(.notFound) { return "notFound" }
        if statuses.contains(.requiresApproval) { return "requiresApproval" }
        if statuses.contains(.notRegistered) { return "notRegistered" }
        return "enabled"
    }

    func request(_ which: String) async -> Bool {
        guard which == "notifications" else { return false }
        return (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    @MainActor
    func openSettings(_ target: String) {
        if target == "login-items" { SMAppService.openSystemSettingsLoginItems(); return }
        if let url = SystemSettingsLinks.url(forTarget: target, bundleId: bundleId) { NSWorkspace.shared.open(url) }
    }

    func resetAndReRequest() async -> Bool {
        let (exe, args) = TCCReset.arguments(bundleId: bundleId)
        let out = await runner.run(exe, args)
        if !out.ok { TrayLog.warn("tccutil reset failed", ["stderr": out.stderr]) }
        _ = await request("notifications")
        return out.ok
    }
}
```
(`PermissionsProviding` is declared in Task 9's `TrayRoutes`; to keep this task compiling on its own, declare it now in Core — `rt-tray/Sources-core/Routes/Providers.swift`:)
```swift
import Foundation

public protocol PermissionsProviding: Sendable {
    func snapshot() async -> PermissionSnapshot
    func request(_ which: String) async -> Bool
}
```

- [ ] **Step 6: Build** `swift build 2>&1 | tail -1` → `Build complete!`; checks pass.

- [ ] **Step 7: Commit**
```bash
git add rt-tray/Sources-core rt-tray/Sources/Permissions rt-tray/Tests
git commit -m "MAT-383: PermissionsService — FDA probe, notifications, login items, deep links, tccutil reset seam

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: ServicesRegistrar — N plists, register-all, statuses, version-change restart, source guard

**Files:**
- Create: `rt-tray/Sources-core/Services/ServicePlists.swift`, `rt-tray/Sources-core/Services/VersionChangeDetector.swift`, `rt-tray/Sources-core/Services/ServiceModels.swift`
- Create: `rt-tray/Sources/Services/ServicesRegistrar.swift`
- Create: `rt-tray/Tests/MattstackCoreChecks/ServicesChecks.swift`, `rt-tray/Tests/MattstackCoreChecks/SourceGuardChecks.swift`; modify `AllChecks.swift`

**Interfaces:**
- Produces (Core):
  - `public struct AgentPlist: Equatable { label: String; fileName: String }`; `public enum ServicePlistScanner { static func scan(directory: String, list: (String) -> [String], readLabel: (String) -> String?) -> [AgentPlist] }` (sorted by fileName; skips files whose Label is unreadable)
  - `public enum Kickstart { static func arguments(label: String, uid: uid_t) -> (String, [String]) }` → `("/bin/launchctl", ["kickstart", "-k", "gui/<uid>/<label>"])`
  - `public enum DeckRestart { static func arguments(deckPath: String) -> (String, [String]) }` → `(deckPath, ["restart", "--managed"])`
  - `public protocol KeyValueStore { func string(forKey:) -> String?; func set(_ value: String?, forKey:) }` + `public final class MemoryKeyValueStore`
  - `public enum VersionChange: Equatable { firstLaunch, unchanged, changed(from: String, to: String) }`; `public enum VersionChangeDetector { static let key = "MSLastLaunchedVersion"; static func evaluate(current: String, store: KeyValueStore) -> VersionChange; static func record(current: String, store: KeyValueStore) }`
  - `public struct ServiceStatusEntry: Codable, Equatable { label: String; status: String }`, `public struct ServiceRegisterResult: Codable, Equatable { plist: String; ok: Bool; status: String; error: String? }`
  - `public protocol ServicesProviding: Sendable { func statuses() async -> [ServiceStatusEntry]; func register(plists: [String]) async -> [ServiceRegisterResult]; func unregister(plists: [String]) async -> [ServiceRegisterResult]; func restart(label: String) async -> Bool }` — `unregister` serves L1's `app-unregister-services` need (`rt uninstall` → `services.unregister`), via `SMAppService.unregister()`; a plist whose `BundleProgram` does not exist in the bundle registers as `notFound` and is reported `ok:false, status:"notFound"` — the app never hides it; L1 decides (it requests the deck plist only when deck is bundled).
- Produces (app): `final class ServicesRegistrar: ServicesProviding` — `init(bundlePath: String, runner: CommandRunner, uid: uid_t = getuid())`; `var agents: [AgentPlist]`; `func registerAll() -> [ServiceRegisterResult]`; `func smStatuses() -> [SMAppService.Status]`; `func restartAll() async`; `func handleVersionChange(current: String, store: KeyValueStore) async -> VersionChange` (changed → registerAll + restartAll + deck restart + record).

- [ ] **Step 1: Failing checks**

`rt-tray/Tests/MattstackCoreChecks/ServicesChecks.swift`:
```swift
import Foundation
import MattstackCore

let servicesChecks: [Check] = [
    Check("ServicePlistScanner lists every plist in Contents/Library/LaunchAgents with its Label") { c in
        let dir = "/App.app/Contents/Library/LaunchAgents"
        let agents = ServicePlistScanner.scan(directory: dir,
            list: { _ in ["com.mattstack.deck.plist", "com.mattstack.daemon.plist", "README.txt", "broken.plist"] },
            readLabel: { path in
                switch (path as NSString).lastPathComponent {
                case "com.mattstack.daemon.plist": return "com.mattstack.daemon"
                case "com.mattstack.deck.plist": return "com.mattstack.deck"
                default: return nil
                }
            })
        c.expectEqual(agents, [AgentPlist(label: "com.mattstack.daemon", fileName: "com.mattstack.daemon.plist"),
                               AgentPlist(label: "com.mattstack.deck", fileName: "com.mattstack.deck.plist")])
    },
    Check("Kickstart and DeckRestart build the exact argv") { c in
        let (exe, args) = Kickstart.arguments(label: "com.mattstack.daemon.dev", uid: 501)
        c.expect(exe.hasPrefix("/bin/") && exe.hasSuffix("ctl"), "launchd's control tool, by absolute path (name kept out of check sources by the source guard)")
        c.expectEqual(args, ["kickstart", "-k", "gui/501/com.mattstack.daemon.dev"])
        let (d, dargs) = DeckRestart.arguments(deckPath: "/Applications/mattstack.app/Contents/Helpers/deck")
        c.expectEqual(d, "/Applications/mattstack.app/Contents/Helpers/deck")
        c.expectEqual(dargs, ["restart", "--managed"])
    },
    Check("VersionChangeDetector: first launch, unchanged, changed; record persists") { c in
        let store = MemoryKeyValueStore()
        c.expectEqual(VersionChangeDetector.evaluate(current: "2.8.0", store: store), .firstLaunch)
        VersionChangeDetector.record(current: "2.8.0", store: store)
        c.expectEqual(VersionChangeDetector.evaluate(current: "2.8.0", store: store), .unchanged)
        c.expectEqual(VersionChangeDetector.evaluate(current: "2.9.0", store: store), .changed(from: "2.8.0", to: "2.9.0"))
        c.expectEqual(store.string(forKey: VersionChangeDetector.key), "2.8.0")
    },
    Check("ServiceStatusEntry / ServiceRegisterResult encode per contract") { c in
        let data = try JSONEncoder().encode([ServiceStatusEntry(label: "com.mattstack.daemon", status: "enabled")])
        c.expect(String(decoding: data, as: UTF8.self).contains("\"status\":\"enabled\""))
        let r = ServiceRegisterResult(plist: "com.mattstack.deck.plist", ok: false, status: "notFound", error: "plist missing")
        let j = String(decoding: try JSONEncoder().encode(r), as: UTF8.self)
        c.expect(j.contains("\"ok\":false"))
    },
]
```

`rt-tray/Tests/MattstackCoreChecks/SourceGuardChecks.swift` — the T5/T6 guard:
```swift
import Foundation
import MattstackCore

/// No check file may name a process we must never spawn from a test, and
/// none may construct the real runner. Paths are relative to this file.
let sourceGuardChecks: [Check] = [
    Check("checks never name launchctl/pkill/tccutil/osascript/open(1) or SystemCommandRunner") { c in
        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let files = try FileManager.default.contentsOfDirectory(atPath: here.path).filter { $0.hasSuffix(".swift") && $0 != "SourceGuardChecks.swift" }
        let forbidden = ["/bin/launchctl", "launchctl ", "pkill", "tccutil", "osascript", "/usr/bin/open", "SystemCommandRunner("]
        for f in files {
            let text = try String(contentsOfFile: here.appendingPathComponent(f).path, encoding: .utf8)
            for needle in forbidden where text.contains(needle) {
                c.fail("\(f) mentions forbidden '\(needle)'")
            }
        }
        c.expect(files.count >= 5)
    },
]
```
(Check files assert on `hasPrefix`/`hasSuffix` of those executables rather than spelling the names, so the guard above stays clean.)

Register `+ servicesChecks + sourceGuardChecks`.

- [ ] **Step 2: Run → compile failure.**

- [ ] **Step 3: Implement Core**

`rt-tray/Sources-core/Services/ServicePlists.swift`:
```swift
import Foundation

public struct AgentPlist: Equatable, Sendable {
    public let label: String
    public let fileName: String
    public init(label: String, fileName: String) { self.label = label; self.fileName = fileName }
}

public enum ServicePlistScanner {
    public static func scan(directory: String, list: (String) -> [String], readLabel: (String) -> String?) -> [AgentPlist] {
        list(directory).sorted().compactMap { file in
            guard file.hasSuffix(".plist"), let label = readLabel(directory + "/" + file) else { return nil }
            return AgentPlist(label: label, fileName: file)
        }
    }
    public static func systemList(_ dir: String) -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
    }
    public static func systemReadLabel(_ path: String) -> String? {
        guard let data = FileManager.default.contents(atPath: path),
              let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return nil }
        return dict["Label"] as? String
    }
}

public enum Kickstart {
    public static func arguments(label: String, uid: uid_t) -> (String, [String]) {
        ("/bin/launchctl", ["kickstart", "-k", "gui/\(uid)/\(label)"])
    }
}

public enum DeckRestart {
    public static func arguments(deckPath: String) -> (String, [String]) { (deckPath, ["restart", "--managed"]) }
}
```

`rt-tray/Sources-core/Services/VersionChangeDetector.swift`:
```swift
import Foundation

public protocol KeyValueStore: Sendable {
    func string(forKey key: String) -> String?
    func set(_ value: String?, forKey key: String)
}

public final class MemoryKeyValueStore: KeyValueStore, @unchecked Sendable {
    private var dict: [String: String] = [:]
    public init() {}
    public func string(forKey key: String) -> String? { dict[key] }
    public func set(_ value: String?, forKey key: String) { dict[key] = value }
}

public enum VersionChange: Equatable, Sendable {
    case firstLaunch
    case unchanged
    case changed(from: String, to: String)
}

/// Sparkle swaps the bundle but launchd keeps running the old inodes; the
/// app must notice its own version changed and restart the agents.
public enum VersionChangeDetector {
    public static let key = "MSLastLaunchedVersion"
    public static func evaluate(current: String, store: KeyValueStore) -> VersionChange {
        guard let last = store.string(forKey: key) else { return .firstLaunch }
        return last == current ? .unchanged : .changed(from: last, to: current)
    }
    public static func record(current: String, store: KeyValueStore) { store.set(current, forKey: key) }
}
```

`rt-tray/Sources-core/Services/ServiceModels.swift`:
```swift
import Foundation

public struct ServiceStatusEntry: Codable, Equatable, Sendable {
    public var label: String
    public var status: String
    public init(label: String, status: String) { self.label = label; self.status = status }
}

public struct ServiceRegisterResult: Codable, Equatable, Sendable {
    public var plist: String
    public var ok: Bool
    public var status: String
    public var error: String?
    public init(plist: String, ok: Bool, status: String, error: String? = nil) {
        self.plist = plist; self.ok = ok; self.status = status; self.error = error
    }
}

public protocol ServicesProviding: Sendable {
    func statuses() async -> [ServiceStatusEntry]
    func register(plists: [String]) async -> [ServiceRegisterResult]
    func unregister(plists: [String]) async -> [ServiceRegisterResult]
    func restart(label: String) async -> Bool
}
```

- [ ] **Step 4: Run checks → pass.**

- [ ] **Step 5: Implement the app-side registrar**

`rt-tray/Sources/Services/ServicesRegistrar.swift`:
```swift
import Foundation
import ServiceManagement
import MattstackCore

/// Registers every agent plist the bundle ships (spec §8/§9) and restarts
/// them when the app's version changes. Spawns only through CommandRunner.
final class ServicesRegistrar: ServicesProviding, @unchecked Sendable {
    let bundlePath: String
    let agents: [AgentPlist]
    private let runner: CommandRunner
    private let uid: uid_t

    init(bundlePath: String, runner: CommandRunner, uid: uid_t = getuid()) {
        self.bundlePath = bundlePath
        self.runner = runner
        self.uid = uid
        let dir = bundlePath + "/Contents/Library/LaunchAgents"
        agents = ServicePlistScanner.scan(directory: dir, list: ServicePlistScanner.systemList,
                                          readLabel: ServicePlistScanner.systemReadLabel)
    }

    private func service(_ plist: AgentPlist) -> SMAppService { SMAppService.agent(plistName: plist.fileName) }

    func smStatuses() -> [SMAppService.Status] { agents.map { service($0).status } }

    @discardableResult
    func registerAll() -> [ServiceRegisterResult] { registerSync(plists: agents.map(\.fileName)) }

    private func registerSync(plists: [String]) -> [ServiceRegisterResult] {
        plists.map { name in
            guard let plist = agents.first(where: { $0.fileName == name }) else {
                return ServiceRegisterResult(plist: name, ok: false, status: "notFound", error: "not shipped in this bundle")
            }
            let svc = service(plist)
            do {
                try svc.register()
                TrayLog.info("agent registered", ["label": plist.label, "status": TrayServer.statusName(svc.status)])
                return ServiceRegisterResult(plist: name, ok: true, status: TrayServer.statusName(svc.status))
            } catch {
                let already = (error as NSError).code == kSMErrorAlreadyRegistered
                if !already { TrayLog.error("agent register failed", ["label": plist.label, "err": String(describing: error)]) }
                return ServiceRegisterResult(plist: name, ok: already, status: TrayServer.statusName(svc.status),
                                             error: already ? nil : String(describing: error))
            }
        }
    }

    func statuses() async -> [ServiceStatusEntry] {
        agents.map { ServiceStatusEntry(label: $0.label, status: TrayServer.statusName(service($0).status)) }
    }

    func register(plists: [String]) async -> [ServiceRegisterResult] {
        await MainActor.run { registerSync(plists: plists) }
    }

    func unregister(plists: [String]) async -> [ServiceRegisterResult] {
        await MainActor.run {
            plists.map { name in
                guard let plist = agents.first(where: { $0.fileName == name }) else {
                    return ServiceRegisterResult(plist: name, ok: false, status: "notFound", error: "not shipped in this bundle")
                }
                let svc = service(plist)
                do {
                    try svc.unregister()
                    TrayLog.info("agent unregistered", ["label": plist.label])
                    return ServiceRegisterResult(plist: name, ok: true, status: TrayServer.statusName(svc.status))
                } catch {
                    let gone = svc.status == .notRegistered
                    if !gone { TrayLog.error("agent unregister failed", ["label": plist.label, "err": String(describing: error)]) }
                    return ServiceRegisterResult(plist: name, ok: gone, status: TrayServer.statusName(svc.status),
                                                 error: gone ? nil : String(describing: error))
                }
            }
        }
    }

    func restart(label: String) async -> Bool {
        let (exe, args) = Kickstart.arguments(label: label, uid: uid)
        let out = await runner.run(exe, args)
        if !out.ok { TrayLog.warn("kickstart failed", ["label": label, "stderr": out.stderr]) }
        return out.ok
    }

    func restartAll() async {
        for agent in agents { _ = await restart(label: agent.label) }
        let deck = bundlePath + "/Contents/Helpers/deck"
        guard FileManager.default.isExecutableFile(atPath: deck) else {
            TrayLog.info("deck helper not bundled; skipping managed-app restart")
            return
        }
        let (exe, args) = DeckRestart.arguments(deckPath: deck)
        let out = await runner.run(exe, args)
        if !out.ok { TrayLog.warn("deck restart --managed failed", ["stderr": out.stderr]) }
    }

    /// Called once per launch. On a version change: re-register (idempotent),
    /// kickstart every agent, ask deck to restart its managed apps.
    func handleVersionChange(current: String, store: KeyValueStore) async -> VersionChange {
        let change = VersionChangeDetector.evaluate(current: current, store: store)
        if case .changed(let from, let to) = change {
            TrayLog.info("app version changed; restarting agents", ["from": from, "to": to])
            _ = await MainActor.run { registerAll() }
            await restartAll()
        }
        VersionChangeDetector.record(current: current, store: store)
        return change
    }
}

extension UserDefaults: KeyValueStore {}
```
(`UserDefaults.string(forKey:)` and `set(_:forKey:)` already match the protocol; `@retroactive` conformance warning is acceptable under Swift 5 mode — if the compiler insists, write `extension UserDefaults: @retroactive KeyValueStore {}`.)

- [ ] **Step 6: `swift build` → Build complete; checks pass. Commit**
```bash
git add rt-tray/Sources-core rt-tray/Sources/Services rt-tray/Tests
git commit -m "MAT-383: ServicesRegistrar — N agent plists, register-all, version-change kickstart, command seam + source guard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: PrivilegedInstaller — one admin prompt running the bundled proxy-install helper

**Files:**
- Create: `rt-tray/Sources-core/Needs/NeedModels.swift`
- Create: `rt-tray/Sources/Services/PrivilegedInstaller.swift`
- Create: `rt-tray/Tests/MattstackCoreChecks/NeedModelsChecks.swift`; modify `AllChecks.swift`

**Interfaces:**
- Produces (Core): `public struct NeedResult: Codable, Equatable { ok: Bool; detail: String }`; `public protocol PrivilegedInstalling: Sendable { func proxyInstall() async -> NeedResult; func proxyRemove() async -> NeedResult }` (`proxyRemove` serves L1's `app-privileged {op:"proxy-remove"}` need from `rt uninstall`; helper arg `remove`); `public enum ProxyHelper { static let relativePath = "Contents/Helpers/mattstack-proxy-install"; static func path(bundlePath:) -> String; static let promptText = "mattstack needs administrator access once to install the local HTTPS proxy (portless) for the board and deck." }`; `public protocol PrivilegeEscalator: Sendable { func runAsAdmin(executable: String, args: [String], prompt: String) async -> CommandOutcome }`
- Produces (app): `final class PrivilegedInstaller: PrivilegedInstalling` — `init(bundlePath: String, escalator: PrivilegeEscalator, fileExists: @escaping (String) -> Bool = FileManager.default.isExecutableFile(atPath:))`; `struct AuthorizationServicesEscalator: PrivilegeEscalator` (the real admin prompt).

- [ ] **Step 1: Failing checks**

`rt-tray/Tests/MattstackCoreChecks/NeedModelsChecks.swift`:
```swift
import Foundation
import MattstackCore

let needModelsChecks: [Check] = [
    Check("ProxyHelper path and prompt") { c in
        c.expectEqual(ProxyHelper.path(bundlePath: "/Applications/mattstack.app"),
                      "/Applications/mattstack.app/Contents/Helpers/mattstack-proxy-install")
        c.expect(ProxyHelper.promptText.contains("administrator"))
    },
    Check("NeedResult encodes {ok, detail}") { c in
        let j = String(decoding: try JSONEncoder().encode(NeedResult(ok: true, detail: "proxy installed")), as: UTF8.self)
        c.expect(j.contains("\"ok\":true") && j.contains("\"detail\":\"proxy installed\""))
    },
]
```

- [ ] **Step 2: Run → compile failure.**

- [ ] **Step 3: Implement**

`rt-tray/Sources-core/Needs/NeedModels.swift`:
```swift
import Foundation

public struct NeedResult: Codable, Equatable, Sendable {
    public var ok: Bool
    public var detail: String
    public init(ok: Bool, detail: String) { self.ok = ok; self.detail = detail }
}

public protocol PrivilegedInstalling: Sendable {
    func proxyInstall() async -> NeedResult
    func proxyRemove() async -> NeedResult
}

public protocol PrivilegeEscalator: Sendable {
    func runAsAdmin(executable: String, args: [String], prompt: String) async -> CommandOutcome
}

public enum ProxyHelper {
    public static let relativePath = "Contents/Helpers/mattstack-proxy-install"
    public static func path(bundlePath: String) -> String { bundlePath + "/" + relativePath }
    public static let promptText = "mattstack needs administrator access once to install the local HTTPS proxy (portless) for the board and deck."
}
```

`rt-tray/Sources/Services/PrivilegedInstaller.swift`:
```swift
import Foundation
import Security
import MattstackCore

final class PrivilegedInstaller: PrivilegedInstalling, @unchecked Sendable {
    private let bundlePath: String
    private let escalator: PrivilegeEscalator
    private let fileExists: @Sendable (String) -> Bool

    init(bundlePath: String, escalator: PrivilegeEscalator,
         fileExists: @escaping @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) {
        self.bundlePath = bundlePath; self.escalator = escalator; self.fileExists = fileExists
    }

    func proxyInstall() async -> NeedResult { await run(op: "install") }
    func proxyRemove() async -> NeedResult { await run(op: "remove") }

    private func run(op: String) async -> NeedResult {
        let helper = ProxyHelper.path(bundlePath: bundlePath)
        guard fileExists(helper) else {
            return NeedResult(ok: false, detail: "proxy-install helper is not bundled at \(ProxyHelper.relativePath)")
        }
        let out = await escalator.runAsAdmin(executable: helper, args: [op], prompt: ProxyHelper.promptText)
        if out.ok { TrayLog.info("proxy helper ran", ["stdout": String(out.stdout.suffix(500))]) }
        else { TrayLog.warn("proxy helper failed", ["exit": Int(out.exitCode), "stderr": String(out.stderr.suffix(1000))]) }
        return NeedResult(ok: out.ok, detail: out.ok ? out.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                                                     : (out.stderr.isEmpty ? "exit \(out.exitCode)" : out.stderr))
    }
}

/// The one admin prompt (spec §7 "Privileged"). AuthorizationServices shows
/// the system dialog with our prompt; the helper then runs as root through
/// AuthorizationExecuteWithPrivileges, resolved at runtime because the
/// symbol is deprecated-but-supported and has no Swift overlay.
struct AuthorizationServicesEscalator: PrivilegeEscalator {
    private typealias ExecFn = @convention(c) (AuthorizationRef, UnsafePointer<CChar>, AuthorizationFlags,
                                               UnsafePointer<UnsafeMutablePointer<CChar>?>?,
                                               UnsafeMutablePointer<UnsafeMutablePointer<FILE>?>?) -> OSStatus

    func runAsAdmin(executable: String, args: [String], prompt: String) async -> CommandOutcome {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async { cont.resume(returning: Self.runBlocking(executable, args, prompt)) }
        }
    }

    private static func runBlocking(_ executable: String, _ args: [String], _ prompt: String) -> CommandOutcome {
        var authRef: AuthorizationRef?
        guard AuthorizationCreate(nil, nil, [], &authRef) == errAuthorizationSuccess, let auth = authRef else {
            return CommandOutcome(exitCode: 1, stdout: "", stderr: "AuthorizationCreate failed")
        }
        defer { AuthorizationFree(auth, [.destroyRights]) }

        var item = kAuthorizationRightExecute.withCString { name in
            AuthorizationItem(name: name, valueLength: 0, value: nil, flags: 0)
        }
        var rights = AuthorizationItem_withRights(&item)
        var promptCopy = Array(prompt.utf8CString)
        var envItem = promptCopy.withUnsafeMutableBufferPointer { buf in
            AuthorizationItem(name: kAuthorizationEnvironmentPrompt, valueLength: buf.count - 1, value: buf.baseAddress, flags: 0)
        }
        var env = AuthorizationItem_withRights(&envItem)
        let flags: AuthorizationFlags = [.interactionAllowed, .extendRights, .preAuthorize]
        let status = AuthorizationCopyRights(auth, &rights, &env, flags, nil)
        guard status == errAuthorizationSuccess else {
            return CommandOutcome(exitCode: Int32(status), stdout: "", stderr: status == errAuthorizationCanceled ? "cancelled" : "authorization denied (\(status))")
        }

        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "AuthorizationExecuteWithPrivileges") else {
            return CommandOutcome(exitCode: 1, stdout: "", stderr: "AuthorizationExecuteWithPrivileges unavailable")
        }
        let exec = unsafeBitCast(sym, to: ExecFn.self)
        var cArgs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]
        defer { cArgs.forEach { free($0) } }
        var pipe: UnsafeMutablePointer<FILE>?
        let rc = executable.withCString { exe in exec(auth, exe, [], &cArgs, &pipe) }
        guard rc == errAuthorizationSuccess, let fp = pipe else {
            return CommandOutcome(exitCode: Int32(rc), stdout: "", stderr: "exec failed (\(rc))")
        }
        var output = ""
        var buf = [CChar](repeating: 0, count: 4096)
        while fgets(&buf, Int32(buf.count), fp) != nil { output += String(cString: buf) }
        fclose(fp)
        // The helper prints "MATTSTACK_EXIT=<n>" as its last line so the
        // caller learns the real status (the API does not report it).
        let exit = output.split(separator: "\n").last.flatMap { $0.hasPrefix("MATTSTACK_EXIT=") ? Int32($0.dropFirst("MATTSTACK_EXIT=".count)) : nil } ?? 0
        return CommandOutcome(exitCode: exit, stdout: output, stderr: exit == 0 ? "" : output)
    }

    private static func AuthorizationItem_withRights(_ item: inout AuthorizationItem) -> AuthorizationRights {
        withUnsafeMutablePointer(to: &item) { AuthorizationRights(count: 1, items: $0) }
    }
}
```
(The helper's `MATTSTACK_EXIT=` trailer is a contract L4/L5 must honour; record it in Open questions. L4 T2 carries a `status:"pending"` deps.lock row for `mattstack-proxy-install` so `check-bundle.sh` tolerates its absence until L5 ships it; until then this class honestly reports "helper is not bundled". If the compiler rejects the pointer gymnastics, fall back to `osascript -e 'do shell script … with administrator privileges'` through `CommandRunner` — same prompt, same one-time ask — and note the swap in the report.)

- [ ] **Step 4: `swift build`; checks pass. Commit**
```bash
git add rt-tray/Sources-core rt-tray/Sources/Services rt-tray/Tests
git commit -m "MAT-383: PrivilegedInstaller — one admin prompt for the bundled proxy-install helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: NeedBroker + TrayRoutes — the new tray.sock routes as a pure router, wired into TrayServer

**Files:**
- Create: `rt-tray/Sources-core/Needs/NeedBroker.swift`, `rt-tray/Sources-core/Routes/TrayRoutes.swift`; modify `rt-tray/Sources-core/Routes/Providers.swift`
- Modify: `rt-tray/Sources/TrayServer.swift`
- Create: `rt-tray/Tests/MattstackCoreChecks/TrayRoutesChecks.swift`; modify `AllChecks.swift`

**Interfaces:**
- Consumes: `PermissionsProviding` (Task 6), `ServicesProviding`, `ServiceStatusEntry`, `ServiceRegisterResult` (Task 7), `PrivilegedInstalling`, `NeedResult` (Task 8), `NeedRequest` (defined here in Core `Contract/ApplyEvents.swift` — Task 11 reuses it), `VersionInfo` (Task 3).
- Produces:
  - `public struct NeedRequest: Codable, Equatable { type: String; plists: [String]?; op: String? }` (in `Contract/ApplyEvents.swift`, created now with only this type; Task 11 fills the rest). NeedBroker handles every type L1 emits (contract): `app-register-services {plists}` → `services.register`, `app-unregister-services {plists}` → `services.unregister`, `app-privileged {op:"proxy-install"|"proxy-remove"}` → `privileged.proxyInstall()/proxyRemove()`; anything else → `failed: unknown need type`.
  - `public struct NeedOutcome: Codable, Equatable { state: String /* pending | done | failed */; detail: String }` — the body rt polls at `GET /setup/need/<id>` (contract, 2026-08-21 update: rt polls every 1 s, 10-minute timeout; the app never POSTs a reply).
  - `public actor NeedBroker { init(services: ServicesProviding, privileged: PrivilegedInstalling); func perform(id: String, request: NeedRequest) async -> NeedResult; func outcome(id: String) -> NeedOutcome; func forget(id:); func forgetAll() }` — one execution per id; concurrent callers await the same result; `outcome` is `pending` while running (or before the app has read the `need` line), then `done`/`failed` with the detail. Unknown ids report `pending` — rt keeps polling until its own timeout; the app never fabricates a result.
  - `public protocol UpdateChecking: Sendable { func checkForUpdates() async -> Bool }`, `public protocol VersionProviding: Sendable { func versionInfo() -> VersionInfo }`
  - `public struct RouteResponse: Equatable { status: Int; body: String }`
  - `public struct TrayRoutes: Sendable { init(permissions:, services:, privileged:, needs: NeedBroker, updater: UpdateChecking, version: VersionProviding); func handle(method: String, path: String, body: Data?) async -> RouteResponse? }` — nil = not one of the new routes (TrayServer keeps its existing chain for those).
- TrayServer change: after parsing method/path/body, `if let r = await routes?.handle(...)` send it; else the existing if/else chain. `TrayServer.shared.routes: TrayRoutes?` is set by AppDelegate (Task 18).

- [ ] **Step 1: Failing checks**

`rt-tray/Tests/MattstackCoreChecks/TrayRoutesChecks.swift`:
```swift
import Foundation
import MattstackCore

final class FakePerms: PermissionsProviding, @unchecked Sendable {
    var snap = PermissionSnapshot(fda: .init(status: "granted", detail: "probe read ~/Library/Containers/com.apple.stocks"),
                                  notifications: .init(status: "notDetermined"), loginItems: .init(status: "enabled"))
    var requested: [String] = []
    func snapshot() async -> PermissionSnapshot { snap }
    func request(_ which: String) async -> Bool { requested.append(which); return which == "notifications" }
}
final class FakeServices: ServicesProviding, @unchecked Sendable {
    var registered: [[String]] = []
    var unregistered: [[String]] = []
    var restarted: [String] = []
    var registerDelayNs: UInt64 = 0
    func statuses() async -> [ServiceStatusEntry] { [ServiceStatusEntry(label: "com.mattstack.daemon", status: "enabled")] }
    func register(plists: [String]) async -> [ServiceRegisterResult] {
        if registerDelayNs > 0 { try? await Task.sleep(nanoseconds: registerDelayNs) }
        registered.append(plists)
        return plists.map { ServiceRegisterResult(plist: $0, ok: true, status: "enabled") }
    }
    func unregister(plists: [String]) async -> [ServiceRegisterResult] {
        unregistered.append(plists)
        return plists.map { ServiceRegisterResult(plist: $0, ok: true, status: "notRegistered") }
    }
    func restart(label: String) async -> Bool { restarted.append(label); return true }
}
final class FakePrivileged: PrivilegedInstalling, @unchecked Sendable {
    var calls = 0
    var removes = 0
    func proxyInstall() async -> NeedResult { calls += 1; return NeedResult(ok: true, detail: "proxy installed") }
    func proxyRemove() async -> NeedResult { removes += 1; return NeedResult(ok: true, detail: "proxy removed") }
}
final class FakeUpdater: UpdateChecking, @unchecked Sendable { var checks = 0; func checkForUpdates() async -> Bool { checks += 1; return true } }
struct FakeVersion: VersionProviding {
    func versionInfo() -> VersionInfo { VersionInfo(version: "2.8.0", build: 2008000, flavor: "dev", path: "/Applications/mattstack-dev.app") }
}

func makeRoutes() -> (TrayRoutes, FakePerms, FakeServices, FakePrivileged, FakeUpdater, NeedBroker) {
    let p = FakePerms(), s = FakeServices(), pr = FakePrivileged(), u = FakeUpdater()
    let broker = NeedBroker(services: s, privileged: pr)
    return (TrayRoutes(permissions: p, services: s, privileged: pr, needs: broker, updater: u, version: FakeVersion()), p, s, pr, u, broker)
}
func json(_ body: String) -> [String: Any] { (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any] ?? [:] }

let trayRoutesChecks: [Check] = [
    Check("GET /permissions returns the contract body") { c in
        let (r, _, _, _, _, _) = makeRoutes()
        let resp = await r.handle(method: "GET", path: "/permissions", body: nil)
        c.expectEqual(resp?.status, 200)
        let j = json(resp!.body)
        c.expectEqual((j["fda"] as? [String: Any])?["status"] as? String, "granted")
        c.expectEqual((j["loginItems"] as? [String: Any])?["status"] as? String, "enabled")
    },
    Check("POST /permissions/request {which} → {ok}") { c in
        let (r, p, _, _, _, _) = makeRoutes()
        let resp = await r.handle(method: "POST", path: "/permissions/request", body: Data("{\"which\":\"notifications\"}".utf8))
        c.expectEqual(resp?.status, 200)
        c.expectEqual(json(resp!.body)["ok"] as? Bool, true)
        c.expectEqual(p.requested, ["notifications"])
        let bad = await r.handle(method: "POST", path: "/permissions/request", body: Data("{}".utf8))
        c.expectEqual(bad?.status, 400)
    },
    Check("GET /services, POST /services/register, POST /services/restart") { c in
        let (r, _, s, _, _, _) = makeRoutes()
        let list = await r.handle(method: "GET", path: "/services", body: nil)
        c.expect(list!.body.contains("\"agents\""))
        let reg = await r.handle(method: "POST", path: "/services/register", body: Data("{\"plists\":[\"com.mattstack.daemon.plist\"]}".utf8))
        c.expectEqual(reg?.status, 200)
        c.expectEqual(s.registered, [["com.mattstack.daemon.plist"]])
        c.expect(reg!.body.contains("\"results\""))
        let rs = await r.handle(method: "POST", path: "/services/restart", body: Data("{\"label\":\"com.mattstack.deck\"}".utf8))
        c.expectEqual(rs?.status, 200)
        c.expectEqual(s.restarted, ["com.mattstack.deck"])
    },
    Check("POST /privileged/proxy-install → NeedResult") { c in
        let (r, _, _, pr, _, _) = makeRoutes()
        let resp = await r.handle(method: "POST", path: "/privileged/proxy-install", body: nil)
        c.expectEqual(resp?.status, 200)
        c.expectEqual(json(resp!.body)["ok"] as? Bool, true)
        c.expectEqual(pr.calls, 1)
    },
    Check("GET /setup/need/<id> serves the app-recorded outcome: pending → done/failed; never a POST") { c in
        let (r, _, s, _, _, broker) = makeRoutes()
        let before = await r.handle(method: "GET", path: "/setup/need/services.register", body: nil)
        c.expectEqual(before?.status, 200)
        c.expectEqual(json(before!.body)["state"] as? String, "pending", "unknown/unstarted id is pending — rt keeps polling")
        let req = NeedRequest(type: "app-register-services", plists: ["com.mattstack.daemon.plist", "com.mattstack.deck.plist"], op: nil)
        _ = await broker.perform(id: "services.register", request: req)
        let after = await r.handle(method: "GET", path: "/setup/need/services.register", body: nil)
        let j = json(after!.body)
        c.expectEqual(j["state"] as? String, "done")
        c.expect((j["detail"] as? String)?.contains("com.mattstack.daemon.plist") == true)
        c.expectEqual(s.registered.count, 1)
        _ = await broker.perform(id: "x", request: NeedRequest(type: "teleport", plists: nil, op: nil))
        let failed = await r.handle(method: "GET", path: "/setup/need/x", body: nil)
        c.expectEqual(json(failed!.body)["state"] as? String, "failed")
        let posted = await r.handle(method: "POST", path: "/setup/need/x", body: Data("{}".utf8))
        c.expectEqual(posted?.status, 405, "the contract has no POST reply")
        let empty = await r.handle(method: "GET", path: "/setup/need/", body: nil)
        c.expectEqual(empty?.status, 400)
    },
    Check("NeedBroker: concurrent callers for one id share one execution; outcome is pending while running") { c in
        let s = FakeServices(); s.registerDelayNs = 80_000_000
        let broker = NeedBroker(services: s, privileged: FakePrivileged())
        let req = NeedRequest(type: "app-register-services", plists: ["a.plist"], op: nil)
        async let x = broker.perform(id: "services.register", request: req)
        try await Task.sleep(nanoseconds: 10_000_000)
        c.expectEqual(await broker.outcome(id: "services.register").state, "pending")
        async let y = broker.perform(id: "services.register", request: req)
        let (rx, ry) = await (x, y)
        c.expectEqual(rx, ry)
        c.expectEqual(s.registered.count, 1)
        c.expectEqual(await broker.outcome(id: "services.register").state, "done")
        let privileged = await broker.perform(id: "proxy.install", request: NeedRequest(type: "app-privileged", plists: nil, op: "proxy-install"))
        c.expectEqual(privileged.detail, "proxy installed")
        await broker.forget(id: "proxy.install")
        c.expectEqual(await broker.outcome(id: "proxy.install").state, "pending", "a retry must be able to redo the step")
    },
    Check("NeedBroker: uninstall needs — app-unregister-services and app-privileged/proxy-remove (L1 rt uninstall)") { c in
        let s = FakeServices(), pr = FakePrivileged()
        let broker = NeedBroker(services: s, privileged: pr)
        let un = await broker.perform(id: "services.unregister", request: NeedRequest(type: "app-unregister-services", plists: ["com.mattstack.daemon.plist", "com.mattstack.deck.plist"], op: nil))
        c.expectEqual(un.ok, true)
        c.expectEqual(s.unregistered, [["com.mattstack.daemon.plist", "com.mattstack.deck.plist"]])
        let rm = await broker.perform(id: "proxy.remove", request: NeedRequest(type: "app-privileged", plists: nil, op: "proxy-remove"))
        c.expectEqual(rm.detail, "proxy removed")
        c.expectEqual(pr.removes, 1)
    },
    Check("POST /update/check and GET /version") { c in
        let (r, _, _, _, u, _) = makeRoutes()
        let up = await r.handle(method: "POST", path: "/update/check", body: nil)
        c.expectEqual(json(up!.body)["ok"] as? Bool, true)
        c.expectEqual(u.checks, 1)
        let v = await r.handle(method: "GET", path: "/version", body: nil)
        let j = json(v!.body)
        c.expectEqual(j["version"] as? String, "2.8.0")
        c.expectEqual(j["build"] as? Int, 2008000, "build is the numeric CFBundleVersion, never a string")
        c.expectEqual(j["flavor"] as? String, "dev")
        c.expectEqual(j["path"] as? String, "/Applications/mattstack-dev.app")
    },
    Check("unknown paths return nil so the legacy chain handles them") { c in
        let (r, _, _, _, _, _) = makeRoutes()
        let legacy = await r.handle(method: "GET", path: "/health", body: nil)
        c.expect(legacy == nil)
        let wrongMethod = await r.handle(method: "GET", path: "/update/check", body: nil)
        c.expectEqual(wrongMethod?.status, 405)
    },
]
```

- [ ] **Step 2: Run → compile failure.**

- [ ] **Step 3: Implement**

`rt-tray/Sources-core/Contract/ApplyEvents.swift` (first slice; Task 11 adds `ApplyEvent`):
```swift
import Foundation

public struct NeedRequest: Codable, Equatable, Sendable {
    public var type: String      // app-register-services | app-unregister-services | app-privileged
    public var plists: [String]?
    public var op: String?       // proxy-install | proxy-remove
    public init(type: String, plists: [String]?, op: String?) { self.type = type; self.plists = plists; self.op = op }
}
```

`rt-tray/Sources-core/Routes/Providers.swift` (append):
```swift
public protocol UpdateChecking: Sendable { func checkForUpdates() async -> Bool }
public protocol VersionProviding: Sendable { func versionInfo() -> VersionInfo }
```

`rt-tray/Sources-core/Needs/NeedBroker.swift`:
```swift
import Foundation

/// What rt polls at `GET /setup/need/<id>` while it waits for the app.
public struct NeedOutcome: Codable, Equatable, Sendable {
    public var state: String   // pending | done | failed
    public var detail: String
    public init(state: String, detail: String) { self.state = state; self.detail = detail }
    public static let pending = NeedOutcome(state: "pending", detail: "waiting for the app")
}

/// Executes rt's `need` events exactly once per step id and records the
/// outcome for rt's 1 s poll. Concurrent callers for one id join the same
/// execution; an id nobody has performed yet reads as pending so rt keeps
/// polling until its own 10-minute timeout instead of being told a story.
public actor NeedBroker {
    private let services: ServicesProviding
    private let privileged: PrivilegedInstalling
    private var inFlight: [String: Task<NeedResult, Never>] = [:]
    private var outcomes: [String: NeedOutcome] = [:]

    public init(services: ServicesProviding, privileged: PrivilegedInstalling) {
        self.services = services
        self.privileged = privileged
    }

    public func outcome(id: String) -> NeedOutcome { outcomes[id] ?? .pending }

    public func perform(id: String, request: NeedRequest) async -> NeedResult {
        if let task = inFlight[id] { return await task.value }
        outcomes[id] = .pending
        let services = self.services, privileged = self.privileged
        let task = Task<NeedResult, Never> {
            switch request.type {
            case "app-register-services":
                let results = await services.register(plists: request.plists ?? [])
                let failed = results.filter { !$0.ok }
                if failed.isEmpty {
                    return NeedResult(ok: true, detail: results.map { "\($0.plist): \($0.status)" }.joined(separator: ", "))
                }
                return NeedResult(ok: false, detail: failed.map { "\($0.plist): \($0.error ?? $0.status)" }.joined(separator: "; "))
            case "app-unregister-services":
                let results = await services.unregister(plists: request.plists ?? [])
                let failed = results.filter { !$0.ok }
                if failed.isEmpty {
                    return NeedResult(ok: true, detail: results.map { "\($0.plist): \($0.status)" }.joined(separator: ", "))
                }
                return NeedResult(ok: false, detail: failed.map { "\($0.plist): \($0.error ?? $0.status)" }.joined(separator: "; "))
            case "app-privileged" where request.op == "proxy-install":
                return await privileged.proxyInstall()
            case "app-privileged" where request.op == "proxy-remove":
                return await privileged.proxyRemove()
            default:
                return NeedResult(ok: false, detail: "unknown need type \(request.type)\(request.op.map { "/\($0)" } ?? "")")
            }
        }
        inFlight[id] = task
        let result = await task.value
        outcomes[id] = NeedOutcome(state: result.ok ? "done" : "failed", detail: result.detail)
        return result
    }

    /// A retry (`setup apply --from`) must be allowed to redo a step.
    public func forget(id: String) { inFlight[id] = nil; outcomes[id] = nil }
    public func forgetAll() { inFlight.removeAll(); outcomes.removeAll() }
}
```

`rt-tray/Sources-core/Routes/TrayRoutes.swift`:
```swift
import Foundation

public struct RouteResponse: Equatable, Sendable {
    public let status: Int
    public let body: String
    public init(status: Int, body: String) { self.status = status; self.body = body }
}

/// The contract's tray.sock additions (§5.3). Pure: providers are injected,
/// HTTP framing stays in TrayServer.
public struct TrayRoutes: Sendable {
    private let permissions: PermissionsProviding
    private let services: ServicesProviding
    private let privileged: PrivilegedInstalling
    private let needs: NeedBroker
    private let updater: UpdateChecking
    private let version: VersionProviding

    public init(permissions: PermissionsProviding, services: ServicesProviding, privileged: PrivilegedInstalling,
                needs: NeedBroker, updater: UpdateChecking, version: VersionProviding) {
        self.permissions = permissions; self.services = services; self.privileged = privileged
        self.needs = needs; self.updater = updater; self.version = version
    }

    public static let paths: Set<String> = ["/permissions", "/permissions/request", "/services", "/services/register",
                                            "/services/restart", "/privileged/proxy-install", "/update/check", "/version"]

    public func handle(method: String, path: String, body: Data?) async -> RouteResponse? {
        let isNeed = path.hasPrefix("/setup/need/")
        guard Self.paths.contains(path) || isNeed else { return nil }
        switch (method, path) {
        case ("GET", "/permissions"):
            return encode(await permissions.snapshot())
        case ("POST", "/permissions/request"):
            guard let which = field("which", in: body) else { return bad("which is required") }
            let ok = await permissions.request(which)
            return RouteResponse(status: 200, body: "{\"ok\":\(ok)}")
        case ("GET", "/services"):
            return encode(["agents": await services.statuses()])
        case ("POST", "/services/register"):
            guard let plists = list("plists", in: body) else { return bad("plists is required") }
            let results = await services.register(plists: plists)
            struct Reply: Encodable { let ok: Bool; let results: [ServiceRegisterResult] }
            return encode(Reply(ok: results.allSatisfy(\.ok), results: results))
        case ("POST", "/services/restart"):
            guard let label = field("label", in: body) else { return bad("label is required") }
            return RouteResponse(status: 200, body: "{\"ok\":\(await services.restart(label: label))}")
        case ("POST", "/privileged/proxy-install"):
            return encode(await privileged.proxyInstall())
        case ("GET", _) where isNeed:
            let id = String(path.dropFirst("/setup/need/".count))
            guard !id.isEmpty else { return bad("need id is required") }
            return encode(await needs.outcome(id: id))
        case ("POST", "/update/check"):
            return RouteResponse(status: 200, body: "{\"ok\":\(await updater.checkForUpdates())}")
        case ("GET", "/version"):
            return encode(version.versionInfo())
        default:
            return RouteResponse(status: 405, body: "{\"ok\":false,\"error\":\"method not allowed\"}")
        }
    }

    private func encode<T: Encodable>(_ value: T) -> RouteResponse {
        let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys]
        guard let data = try? enc.encode(value) else { return RouteResponse(status: 500, body: "{\"ok\":false,\"error\":\"encode\"}") }
        return RouteResponse(status: 200, body: String(decoding: data, as: UTF8.self))
    }
    private func bad(_ msg: String) -> RouteResponse { RouteResponse(status: 400, body: "{\"ok\":false,\"error\":\"\(msg)\"}") }
    private func object(_ body: Data?) -> [String: Any]? {
        guard let body else { return nil }
        return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    }
    private func field(_ name: String, in body: Data?) -> String? { object(body)?[name] as? String }
    private func list(_ name: String, in body: Data?) -> [String]? { object(body)?[name] as? [String] }
}
```

- [ ] **Step 4: Run checks → pass.**

- [ ] **Step 5: Wire TrayServer**

In `rt-tray/Sources/TrayServer.swift`:
- add `import MattstackCore` and a property `var routes: TrayRoutes?` next to `daemonLifecycle`.
- In `handleConnection`, right after `let path = parts.count > 1 ? parts[1] : ""`, insert:
```swift
            let bodyData: Data? = str.range(of: "\r\n\r\n").map { Data(String(str[$0.upperBound...]).utf8) }
            if let routes = self.routes {
                Task {
                    if let reply = await routes.handle(method: method, path: path, body: bodyData) {
                        self.sendResponse(connection: connection, status: reply.status, body: reply.body, path: path)
                    } else {
                        self.handleLegacy(method: method, path: path, str: str, connection: connection)
                    }
                }
                return
            }
            self.handleLegacy(method: method, path: path, str: str, connection: connection)
```
and move the existing if/else chain (from `if method == "POST" && path == "/notify"` through the final 404) into a new `private func handleLegacy(method: String, path: String, str: String, connection: NWConnection)` unchanged. Add `case 405: statusText = "Method Not Allowed"` and `case 500: statusText = "Error"` to `sendResponse`. Existing routes keep their behaviour; `check-bundle.sh`'s awk over the `/flavor/retire` block still matches because that block moves verbatim. **L4 `check-bundle.sh` source gates this refactor must preserve (cross-plan review §1 row 14):** the literal `path == "/flavor/retire"` in `TrayServer.swift`; `forInfoDictionaryKey: "MSDaemonLabel"` and `defaultDaemonLabel = "com.mattstack.daemon"` in `Sources/` (today `BundleFlavor.swift`); and in `main.swift` the socket guard stays before `let delegate = AppDelegate()` (Task 18).

- [ ] **Step 6: `swift build`; checks pass. Commit**
```bash
git add rt-tray/Sources-core rt-tray/Sources/TrayServer.swift rt-tray/Tests
git commit -m "MAT-383: tray.sock routes (/permissions, /services, /privileged, GET /setup/need polling, /update/check, /version) + NeedBroker

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: UpdaterController — Sparkle via SPM, gentle reminders, dev flavor off, build.sh launch stopgap

**Files:**
- Modify: `rt-tray/Package.swift` (Sparkle dep + rpath)
- Create: `rt-tray/Sources-core/Updates/UpdatePolicy.swift`
- Create: `rt-tray/Sources/Updates/UpdaterController.swift`
- Delete: `rt-tray/Sources/UpdateChecker.swift`
- Modify: `rt-tray/Sources/AppDelegate.swift` (swap UpdateChecker → UpdaterController), `rt-tray/Sources/TrayState.swift` (doc comment only), `rt-tray/check-bundle.sh` (one assertion — **drop this edit if L4 T3's rewrite has already merged; otherwise L4 absorbs it at rebase**), `rt-tray/build.sh` (**fenced stopgap — deleted by L4 T4's rewrite; L4 T4 must call `scripts/render-launchagents.sh`**)
- Create: `rt-tray/Tests/MattstackCoreChecks/UpdatePolicyChecks.swift`; modify `AllChecks.swift`

**Interfaces:**
- Produces (Core): `public enum UpdatePolicy { static let placeholderKey = "REPLACE_WITH_RELEASE_PUBLIC_ED_KEY"; static let overrideEnv = "MATTSTACK_APPCAST_URL"; static let overrideFlag = "--allow-appcast-override"; static func feedOverride(environment: [String: String], arguments: [String], isDevBuild: Bool) -> String?; static func shouldStartUpdater(isDevBuild: Bool, publicEDKey: String?, feedURL: String?, feedOverride: String?) -> Bool; static func allowsImmediateInstall(setupRunning: Bool, windowsOpen: Int) -> Bool }`. **Decision (L7 request):** the env override is honoured when `MSDevBuild` is true OR the process was launched with `--allow-appcast-override`; with an override present the updater starts even in the dev flavor (that is the VM's Sparkle vN→vN+1 rehearsal), but the EdDSA key must still be real — the app never talks to a feed it cannot verify.
- Produces (app): `final class UpdaterController: NSObject, UpdateChecking, SPUUpdaterDelegate, SPUStandardUserDriverDelegate` — `init(isDevBuild: Bool, isBusy: @escaping () -> Bool)`; `var canCheckForUpdates: Bool` (KVO-published via `@objc dynamic`); `func checkForUpdates() async -> Bool`; `@objc func checkForUpdatesFromMenu()`; `var onUpdateAvailable: ((String) -> Void)?` (feeds `TrayState.updateAvailable`); `var automaticallyChecks: Bool { get set }`.

- [ ] **Step 1: Failing checks**

`rt-tray/Tests/MattstackCoreChecks/UpdatePolicyChecks.swift`:
```swift
import Foundation
import MattstackCore

let updatePolicyChecks: [Check] = [
    Check("Sparkle starts only for prod builds with a real key and feed") { c in
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: true, publicEDKey: "abc", feedURL: "https://x/appcast.xml", feedOverride: nil), false)
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: false, publicEDKey: UpdatePolicy.placeholderKey, feedURL: "https://x/appcast.xml", feedOverride: nil), false)
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: false, publicEDKey: "", feedURL: "https://x/appcast.xml", feedOverride: nil), false)
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: false, publicEDKey: "abc", feedURL: nil, feedOverride: nil), false)
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: false, publicEDKey: "abc", feedURL: "https://x/appcast.xml", feedOverride: nil), true)
    },
    Check("appcast override: env honoured only in dev flavor or with --allow-appcast-override; starts the updater but never without a real key") { c in
        let env = [UpdatePolicy.overrideEnv: "http://127.0.0.1:8000/appcast.xml"]
        c.expectEqual(UpdatePolicy.feedOverride(environment: env, arguments: ["mattstack"], isDevBuild: false), nil)
        c.expectEqual(UpdatePolicy.feedOverride(environment: env, arguments: ["mattstack"], isDevBuild: true), "http://127.0.0.1:8000/appcast.xml")
        c.expectEqual(UpdatePolicy.feedOverride(environment: env, arguments: ["mattstack", UpdatePolicy.overrideFlag], isDevBuild: false), "http://127.0.0.1:8000/appcast.xml")
        c.expectEqual(UpdatePolicy.feedOverride(environment: [:], arguments: [UpdatePolicy.overrideFlag], isDevBuild: true), nil)
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: true, publicEDKey: "abc", feedURL: nil, feedOverride: "http://127.0.0.1:8000/appcast.xml"), true)
        c.expectEqual(UpdatePolicy.shouldStartUpdater(isDevBuild: true, publicEDKey: UpdatePolicy.placeholderKey, feedURL: nil, feedOverride: "http://127.0.0.1:8000/appcast.xml"), false)
    },
    Check("immediate install only when idle: no setup running, no windows") { c in
        c.expectEqual(UpdatePolicy.allowsImmediateInstall(setupRunning: false, windowsOpen: 0), true)
        c.expectEqual(UpdatePolicy.allowsImmediateInstall(setupRunning: true, windowsOpen: 0), false)
        c.expectEqual(UpdatePolicy.allowsImmediateInstall(setupRunning: false, windowsOpen: 1), false)
    },
]
```

- [ ] **Step 2: Run → compile failure.** Implement `rt-tray/Sources-core/Updates/UpdatePolicy.swift`:
```swift
import Foundation

public enum UpdatePolicy {
    public static let placeholderKey = "REPLACE_WITH_RELEASE_PUBLIC_ED_KEY"
    public static let overrideEnv = "MATTSTACK_APPCAST_URL"
    public static let overrideFlag = "--allow-appcast-override"

    /// The clean-room VM points the app at a loopback appcast. Only the dev
    /// flavor, or a launch that opted in on the command line, may be redirected.
    public static func feedOverride(environment: [String: String], arguments: [String], isDevBuild: Bool) -> String? {
        guard let url = environment[overrideEnv], !url.isEmpty else { return nil }
        return (isDevBuild || arguments.contains(overrideFlag)) ? url : nil
    }

    /// Dev flavor never checks unless a feed override is in force; a build
    /// without a real EdDSA key must not talk to any feed it cannot verify.
    public static func shouldStartUpdater(isDevBuild: Bool, publicEDKey: String?, feedURL: String?, feedOverride: String?) -> Bool {
        guard let key = publicEDKey, !key.isEmpty, key != placeholderKey else { return false }
        if let o = feedOverride, !o.isEmpty { return true }
        guard !isDevBuild, let feed = feedURL, !feed.isEmpty else { return false }
        return true
    }

    public static func allowsImmediateInstall(setupRunning: Bool, windowsOpen: Int) -> Bool {
        !setupRunning && windowsOpen == 0
    }
}
```
Run checks → pass.

- [ ] **Step 3: Add Sparkle to Package.swift**

In `rt-tray/Package.swift` add at package level:
```swift
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.6"),
    ],
```
and on the `rt-tray` executable target:
```swift
            dependencies: [
                "MattstackCore",
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            ...
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("UserNotifications"),
                .linkedFramework("ServiceManagement"),
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker",
                              "@executable_path/../../artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64"]),
            ]
```
(The second rpath lets the unbundled `.build/<triple>/debug/rt-tray` find the downloaded framework for `swift run`; harmless in the bundle.) `MattstackCore` must NOT depend on Sparkle — `swift run mattstack-checks` stays framework-free.

Run `swift build 2>&1 | tail -3` → Sparkle is fetched (network) and the build completes. If the artifact download is blocked, record it and continue; the rest of the task still compiles only with Sparkle present, so stop and report rather than stubbing.

- [ ] **Step 4: Write UpdaterController**

`rt-tray/Sources/Updates/UpdaterController.swift`:
```swift
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
```
The `onUpdateAvailable("")` clears the menu badge; AppDelegate maps empty → nil.

- [ ] **Step 5: Rewire AppDelegate; delete UpdateChecker.swift**

In `rt-tray/Sources/AppDelegate.swift`:
- replace `private let updateChecker = UpdateChecker.shared` with `let updater = UpdaterController(isDevBuild: BundleFlavor.isDevBuild, isBusy: { SetupSession.isRunning })` — `SetupSession` arrives in Task 12; until then use `isBusy: { false }` and replace it in Task 12.
- `setupAutoUpdate()` becomes:
```swift
    private func setupAutoUpdate() {
        updater.onUpdateAvailable = { version in
            TrayState.shared.updateAvailable = version.isEmpty ? nil : version
        }
    }
```
- `checkForUpdates()` becomes `updater.checkForUpdatesFromMenu()`.
- delete `handleUpdateAvailable(_:)` and the `applicationWillTerminate` line `updateChecker.stopChecking()`.
- `git rm rt-tray/Sources/UpdateChecker.swift`.
- In `rt-tray/Sources/ProcessPanelView.swift` `updateMenuTitle` keeps working (`trayState.updateAvailable`). Leave it.
- `rt-tray/check-bundle.sh` lines 322–327: replace the `awk '/func checkForUpdates/,/let urlString/' Sources/UpdateChecker.swift` block with
```bash
if grep -q 'UpdatePolicy.shouldStartUpdater(isDevBuild: isDevBuild' Sources/Updates/UpdaterController.swift; then
    pass "UpdaterController gates Sparkle on the dev flavor"
else
    fail "UpdaterController does not gate Sparkle on BundleFlavor.isDevBuild"
fi
```
(`assert_bin_has "silent dev updater" "update check skipped (dev build)"` still holds — the string survives in UpdaterController. L4 T3's `check-bundle.sh` rewrite carries both assertions — the `UpdatePolicy.shouldStartUpdater(isDevBuild: isDevBuild` grep and `assert_bin_has "silent dev updater"` — so if L4 T3 has merged before this task runs, skip the check-bundle edit here; if not, L4 absorbs it at rebase.)

**Relaunch survival (L7):** every self-relaunch the app performs (the post-FDA "Relaunch mattstack" in Task 14, or any future one) re-execs with the current `ProcessInfo.processInfo.arguments` and environment, so `--allow-appcast-override` and `MATTSTACK_APPCAST_URL` survive the relaunch and the clean-room Sparkle rehearsal keeps pointing at the loopback appcast. Task 14's `relaunch()` implements it (`open -n <app> --env MATTSTACK_APPCAST_URL=… --args <current args>`).

- [ ] **Step 6: build.sh stopgap (fenced stopgap — deleted by L4 T4's rewrite; L4 T4 must call `scripts/render-launchagents.sh` itself, keep `embed_sparkle` + the inside-out Sparkle signing, and use PlistBuddy `Set` for every key the Info.plist template already declares)**

After the `cp "$BINARY" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"` line in `rt-tray/build.sh` insert:
```bash
# ─── Sparkle.framework (stopgap until build.sh wraps xcodebuild) ───────────
# The binary links Sparkle via SPM with rpath @executable_path/../Frameworks;
# without the framework in the bundle the app fails at dyld. Copied with
# ditto (symlinks preserved) and signed inside-out below, never --deep.
SPARKLE_SRC="$SCRIPT_DIR/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"
if [ -d "$SPARKLE_SRC" ]; then
    mkdir -p "$APP_BUNDLE/Contents/Frameworks"
    ditto "$SPARKLE_SRC" "$APP_BUNDLE/Contents/Frameworks/Sparkle.framework"
    echo "  ✓ Sparkle.framework embedded"
else
    echo "  ✗ Sparkle.framework not found under .build/artifacts — run swift build first"
    exit 1
fi
```
and in the signing section, before "2. Outer .app bundle", insert:
```bash
# 1b. Sparkle, inside-out (XPC services → Autoupdate → Updater.app → framework)
SPK="$APP_BUNDLE/Contents/Frameworks/Sparkle.framework"
for xpc in "$SPK"/Versions/B/XPCServices/*.xpc; do
    [ -d "$xpc" ] && codesign "${SIGN_FLAGS[@]}" --preserve-metadata=entitlements "$xpc"
done
codesign "${SIGN_FLAGS[@]}" "$SPK/Versions/B/Autoupdate"
codesign "${SIGN_FLAGS[@]}" "$SPK/Versions/B/Updater.app"
codesign "${SIGN_FLAGS[@]}" "$SPK"
echo "  ✓ Signed Sparkle.framework inside-out"
```
Also add the rendered agent plists: replace the single-plist `AGENT_PLIST` sed block + its KeepAlive PlistBuddy lines with
```bash
"$SCRIPT_DIR/scripts/render-launchagents.sh" "$([ "$IS_DEV" = true ] && echo dev || echo prod)" "$APP_BUNDLE/Contents/Library/LaunchAgents"
```
(check-bundle.sh's KeepAlive assertion for prod expects `true`; it now sees `SuccessfulExit=false` for both flavors per spec §8 — update that assertion too: search for the `KA_PRINT` block and make both flavors expect `SuccessfulExit`. L4 T3's rewrite carries the same flip; same drop-if-merged rule as above.)

- [ ] **Step 7: Verify**
```bash
cd rt-tray && swift build 2>&1 | tail -1 && swift run mattstack-checks | tail -1
./build.sh dev 2>&1 | tail -8      # bundle assembles, Sparkle embedded + signed, two agent plists
ls mattstack-dev.app/Contents/Frameworks mattstack-dev.app/Contents/Library/LaunchAgents
codesign --verify --strict mattstack-dev.app && echo SIGN_OK
```
Expected: `Build complete!`, checks pass, `Sparkle.framework`, `com.mattstack.daemon.dev.plist com.mattstack.deck.dev.plist`, `SIGN_OK`. Do NOT launch the app (orchestrator-only, Task 20).

- [ ] **Step 8: Commit**
```bash
git add -A rt-tray/Package.swift rt-tray/Package.resolved rt-tray/Sources rt-tray/Sources-core rt-tray/Tests rt-tray/build.sh rt-tray/check-bundle.sh
git commit -m "MAT-383: Sparkle UpdaterController (gentle reminders, idle install, dev off); UpdateChecker retired; bundle launch stopgap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: InstallRunModel — apply stream → step list, logs, need handling, retry-from

**Files:**
- Modify: `rt-tray/Sources-core/Contract/ApplyEvents.swift` (add `ApplyEvent`, `StepInfo`, `StepKind`, `StepState`)
- Create: `rt-tray/Sources-core/Install/InstallRunModel.swift`
- Create: `rt-tray/Tests/MattstackCoreChecks/InstallRunChecks.swift`; modify `AllChecks.swift`

**Interfaces:**
- Produces:
  - `public enum StepKind: String, Codable { rt, app, privileged }`, `public enum StepState: String, Codable { pending, running, done, failed, skipped }`, `public struct StepInfo: Codable, Equatable, Identifiable { id, title, kind }`
  - `public enum ApplyEvent: Equatable { plan([StepInfo]); step(id: String, state: StepState, detail: String?, remedy: String?); log(id: String, line: String); need(id: String, request: NeedRequest); done(ok: Bool, failedStep: String?); unknown(String) }` + `public static func decode(_ line: String) throws -> ApplyEvent`
  - `public typealias ApplyStreamFactory = @Sendable (_ from: String?) -> AsyncThrowingStream<String, Error>`
  - `public struct InstallStep: Equatable, Identifiable { info: StepInfo; state: StepState; detail: String?; remedy: String?; waitingOnYou: Bool; var id: String }`
  - `@MainActor public final class InstallRunModel: ObservableObject` — `init(stream: @escaping ApplyStreamFactory, needs: NeedBroker)`; `@Published steps: [InstallStep]`, `phase: Phase` (`idle | running | succeeded | failed(stepId: String, remedy: String?) | streamError(String)`), `logs: [String: [String]]`; `func start(from: String? = nil)`; `func retryFromFailure()`; `func logLines(for id: String) -> [String]`; `var failedStepId: String?`; `var isRunning: Bool`; `static func apply(_ event: ApplyEvent, to steps: inout [InstallStep])` (pure reducer).

- [ ] **Step 1: Failing checks**

`rt-tray/Tests/MattstackCoreChecks/InstallRunChecks.swift`:
```swift
import Foundation
import MattstackCore

func lines(_ s: [String]) -> AsyncThrowingStream<String, Error> {
    AsyncThrowingStream { cont in for l in s { cont.yield(l) }; cont.finish() }
}
let planLine = #"{"event":"plan","steps":[{"id":"home.init","title":"Home repo","kind":"rt"},{"id":"services.register","title":"Register services","kind":"app"},{"id":"plugins.install","title":"Plugins","kind":"rt"}]}"#

let installRunChecks: [Check] = [
    Check("ApplyEvent decodes every contract event and tolerates unknown ones") { c in
        c.expectEqual(try ApplyEvent.decode(#"{"event":"step","id":"home.init","state":"running"}"#), .step(id: "home.init", state: .running, detail: nil, remedy: nil))
        c.expectEqual(try ApplyEvent.decode(#"{"event":"log","id":"home.init","line":"gh repo create"}"#), .log(id: "home.init", line: "gh repo create"))
        c.expectEqual(try ApplyEvent.decode(#"{"event":"need","id":"proxy.install","request":{"type":"app-privileged","op":"proxy-install"}}"#),
                      .need(id: "proxy.install", request: NeedRequest(type: "app-privileged", plists: nil, op: "proxy-install")))
        c.expectEqual(try ApplyEvent.decode(#"{"event":"done","ok":false,"failedStep":"plugins.install"}"#), .done(ok: false, failedStep: "plugins.install"))
        c.expectEqual(try ApplyEvent.decode(#"{"event":"spark","x":1}"#), .unknown("spark"))
        if case .plan(let steps) = try ApplyEvent.decode(planLine) { c.expectEqual(steps.count, 3); c.expectEqual(steps[1].kind, .app) } else { c.fail("plan") }
    },
    Check("reducer: plan seeds pending steps; step events update state/detail/remedy") { c in
        var steps: [InstallStep] = []
        InstallRunModel.apply(try ApplyEvent.decode(planLine), to: &steps)
        c.expectEqual(steps.map(\.state), [.pending, .pending, .pending])
        InstallRunModel.apply(.step(id: "home.init", state: .running, detail: nil, remedy: nil), to: &steps)
        InstallRunModel.apply(.step(id: "home.init", state: .done, detail: "pushed main", remedy: nil), to: &steps)
        InstallRunModel.apply(.step(id: "plugins.install", state: .failed, detail: "exit 1", remedy: "Open Claude Code once, then Retry."), to: &steps)
        c.expectEqual(steps[0].state, .done); c.expectEqual(steps[0].detail, "pushed main")
        c.expectEqual(steps[2].state, .failed); c.expectEqual(steps[2].remedy, "Open Claude Code once, then Retry.")
        InstallRunModel.apply(.need(id: "services.register", request: NeedRequest(type: "app-register-services", plists: ["a"], op: nil)), to: &steps)
        c.expectEqual(steps[1].waitingOnYou, true)
    },
    Check("a full happy stream ends succeeded, need events are performed through the broker, logs are kept per step") { c in
        let services = FakeServices(), privileged = FakePrivileged()
        let broker = NeedBroker(services: services, privileged: privileged)
        let stream: ApplyStreamFactory = { _ in lines([
            planLine,
            #"{"event":"step","id":"home.init","state":"running"}"#,
            #"{"event":"log","id":"home.init","line":"gh repo create"}"#,
            #"{"event":"step","id":"home.init","state":"done","detail":"pushed main"}"#,
            #"{"event":"step","id":"services.register","state":"running"}"#,
            #"{"event":"need","id":"services.register","request":{"type":"app-register-services","plists":["com.mattstack.daemon.plist"]}}"#,
            #"{"event":"step","id":"services.register","state":"done"}"#,
            #"{"event":"step","id":"plugins.install","state":"running"}"#,
            #"{"event":"step","id":"plugins.install","state":"done"}"#,
            #"{"event":"done","ok":true,"failedStep":null}"#,
        ]) }
        let m = await MainActor.run { InstallRunModel(stream: stream, needs: broker) }
        await MainActor.run { m.start() }
        for _ in 0..<50 { if await MainActor.run(body: { m.phase == .succeeded }) { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        await MainActor.run {
            c.expectEqual(m.phase, .succeeded)
            c.expectEqual(m.logLines(for: "home.init"), ["gh repo create"])
            c.expectEqual(m.steps.map(\.state), [.done, .done, .done])
        }
        c.expectEqual(services.registered, [["com.mattstack.daemon.plist"]])
    },
    Check("a failed step stops the run with its remedy; retryFromFailure re-streams with --from and forgets the need") { c in
        final class Count: @unchecked Sendable { var froms: [String?] = [] }
        let count = Count()
        let broker = NeedBroker(services: FakeServices(), privileged: FakePrivileged())
        let stream: ApplyStreamFactory = { from in
            count.froms.append(from)
            if from == nil {
                return lines([planLine,
                              #"{"event":"step","id":"plugins.install","state":"failed","detail":"exit 1","remedy":"Open Claude Code once, then Retry."}"#,
                              #"{"event":"done","ok":false,"failedStep":"plugins.install"}"#])
            }
            return lines([#"{"event":"plan","steps":[{"id":"plugins.install","title":"Plugins","kind":"rt"}]}"#,
                          #"{"event":"step","id":"plugins.install","state":"done"}"#,
                          #"{"event":"done","ok":true,"failedStep":null}"#])
        }
        let m = await MainActor.run { InstallRunModel(stream: stream, needs: broker) }
        await MainActor.run { m.start() }
        for _ in 0..<50 { if await MainActor.run(body: { m.failedStepId != nil }) { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        await MainActor.run {
            c.expectEqual(m.phase, .failed(stepId: "plugins.install", remedy: "Open Claude Code once, then Retry."))
            m.retryFromFailure()
        }
        for _ in 0..<50 { if await MainActor.run(body: { m.phase == .succeeded }) { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        await MainActor.run {
            c.expectEqual(m.phase, .succeeded)
            c.expectEqual(m.steps.map(\.id), ["home.init", "services.register", "plugins.install"], "earlier steps keep their rows")
            c.expectEqual(m.steps[2].state, .done)
        }
        c.expectEqual(count.froms, [nil, "plugins.install"])
    },
    Check("a stream error surfaces as streamError") { c in
        let stream: ApplyStreamFactory = { _ in AsyncThrowingStream { $0.finish(throwing: RtClientError.exited(1, stderr: "boom")) } }
        let m = await MainActor.run { InstallRunModel(stream: stream, needs: NeedBroker(services: FakeServices(), privileged: FakePrivileged())) }
        await MainActor.run { m.start() }
        for _ in 0..<50 { if await MainActor.run(body: { if case .streamError = m.phase { return true }; return false }) { break }; try await Task.sleep(nanoseconds: 20_000_000) }
        await MainActor.run { if case .streamError(let s) = m.phase { c.expect(s.contains("boom")) } else { c.fail("expected streamError, got \(m.phase)") } }
    },
]
```

- [ ] **Step 2: Run → compile failure.**

- [ ] **Step 3: Implement**

Append to `rt-tray/Sources-core/Contract/ApplyEvents.swift`:
```swift
public enum StepKind: String, Codable, Equatable, Sendable { case rt, app, privileged }
public enum StepState: String, Codable, Equatable, Sendable { case pending, running, done, failed, skipped }

public struct StepInfo: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var kind: StepKind
    public init(id: String, title: String, kind: StepKind) { self.id = id; self.title = title; self.kind = kind }
}

public enum ApplyEvent: Equatable, Sendable {
    case plan([StepInfo])
    case step(id: String, state: StepState, detail: String?, remedy: String?)
    case log(id: String, line: String)
    case need(id: String, request: NeedRequest)
    case done(ok: Bool, failedStep: String?)
    case unknown(String)

    private struct Raw: Decodable {
        let event: String
        let steps: [StepInfo]?
        let id: String?
        let state: StepState?
        let detail: String?
        let remedy: String?
        let line: String?
        let request: NeedRequest?
        let ok: Bool?
        let failedStep: String?
    }

    public static func decode(_ line: String) throws -> ApplyEvent {
        let r = try JSONDecoder().decode(Raw.self, from: Data(line.utf8))
        switch r.event {
        case "plan": return .plan(r.steps ?? [])
        case "step": return .step(id: r.id ?? "", state: r.state ?? .pending, detail: r.detail, remedy: r.remedy)
        case "log": return .log(id: r.id ?? "", line: r.line ?? "")
        case "need": return .need(id: r.id ?? "", request: r.request ?? NeedRequest(type: "", plists: nil, op: nil))
        case "done": return .done(ok: r.ok ?? false, failedStep: r.failedStep)
        default: return .unknown(r.event)
        }
    }
}
```

`rt-tray/Sources-core/Install/InstallRunModel.swift`:
```swift
import Foundation
import Combine

public typealias ApplyStreamFactory = @Sendable (_ from: String?) -> AsyncThrowingStream<String, Error>

public struct InstallStep: Equatable, Identifiable, Sendable {
    public var info: StepInfo
    public var state: StepState
    public var detail: String?
    public var remedy: String?
    public var waitingOnYou: Bool
    public var id: String { info.id }
    public init(info: StepInfo, state: StepState = .pending, detail: String? = nil, remedy: String? = nil, waitingOnYou: Bool = false) {
        self.info = info; self.state = state; self.detail = detail; self.remedy = remedy; self.waitingOnYou = waitingOnYou
    }
}

/// Renders `rt setup apply --json`. Steps come only from the stream's plan
/// event; the app executes `need` events through NeedBroker and otherwise
/// just shows what rt says. Retry resumes from the failed step and keeps
/// the earlier rows so the list never "forgets" what already happened.
@MainActor
public final class InstallRunModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case idle, running, succeeded
        case failed(stepId: String, remedy: String?)
        case streamError(String)
    }

    @Published public private(set) var steps: [InstallStep] = []
    @Published public private(set) var phase: Phase = .idle
    @Published public private(set) var logs: [String: [String]] = [:]

    private let stream: ApplyStreamFactory
    private let needs: NeedBroker
    private var task: Task<Void, Never>?
    public static let logCapPerStep = 500

    public init(stream: @escaping ApplyStreamFactory, needs: NeedBroker) {
        self.stream = stream
        self.needs = needs
    }

    public var isRunning: Bool { phase == .running }
    public var failedStepId: String? { if case .failed(let id, _) = phase { return id }; return nil }
    public func logLines(for id: String) -> [String] { logs[id] ?? [] }

    public func start(from: String? = nil) {
        task?.cancel()
        phase = .running
        if from == nil { steps = []; logs = [:] }
        let stream = self.stream(from)
        task = Task { [weak self] in
            do {
                for try await line in stream {
                    guard let self else { return }
                    let event: ApplyEvent
                    do { event = try ApplyEvent.decode(line) } catch { self.append(log: "unparsed: \(line)", to: "_stream"); continue }
                    await self.handle(event)
                }
                guard let self, self.phase == .running else { return }
                self.phase = .streamError("rt setup apply ended without a done event")
            } catch {
                self?.phase = .streamError(String(describing: error))
            }
        }
    }

    public func retryFromFailure() {
        guard let id = failedStepId else { return }
        Task { await needs.forget(id: id) }
        start(from: id)
    }

    private func handle(_ event: ApplyEvent) async {
        Self.apply(event, to: &steps)
        switch event {
        case .log(let id, let line):
            append(log: line, to: id)
        case .need(let id, let request):
            let result = await needs.perform(id: id, request: request)
            append(log: "\(request.type): \(result.detail)", to: id)
            if let i = steps.firstIndex(where: { $0.id == id }) {
                steps[i].waitingOnYou = false
                if !result.ok { steps[i].detail = result.detail }
            }
        case .done(let ok, let failedStep):
            if ok { phase = .succeeded }
            else {
                let id = failedStep ?? steps.last(where: { $0.state == .failed })?.id ?? "?"
                phase = .failed(stepId: id, remedy: steps.first(where: { $0.id == id })?.remedy)
            }
        default:
            break
        }
    }

    private func append(log line: String, to id: String) {
        var arr = logs[id] ?? []
        arr.append(line)
        if arr.count > Self.logCapPerStep { arr.removeFirst(arr.count - Self.logCapPerStep) }
        logs[id] = arr
    }

    /// Pure reducer, shared with the checks. A `plan` after a retry merges by
    /// id: existing rows keep their place, new ids append.
    public static func apply(_ event: ApplyEvent, to steps: inout [InstallStep]) {
        switch event {
        case .plan(let infos):
            for info in infos {
                if let i = steps.firstIndex(where: { $0.id == info.id }) {
                    steps[i].info = info
                    steps[i].state = .pending
                    steps[i].remedy = nil
                    steps[i].waitingOnYou = false
                } else {
                    steps.append(InstallStep(info: info))
                }
            }
        case .step(let id, let state, let detail, let remedy):
            guard let i = steps.firstIndex(where: { $0.id == id }) else { return }
            steps[i].state = state
            if let detail { steps[i].detail = detail }
            if let remedy { steps[i].remedy = remedy }
            if state != .running { steps[i].waitingOnYou = false }
        case .need(let id, _):
            if let i = steps.firstIndex(where: { $0.id == id }) { steps[i].waitingOnYou = true }
        case .log, .done, .unknown:
            break
        }
    }
}
```
(`FakeServices`/`FakePrivileged` are reused from Task 9's check file — same module, no duplication.)

- [ ] **Step 4: Run checks → pass. Commit**
```bash
git add rt-tray/Sources-core rt-tray/Tests
git commit -m "MAT-383: InstallRunModel — apply NDJSON → live step list, need execution, retry-from-failed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Setup window shell — flow model, fixed window, footer, Welcome screen

**Files:**
- Create: `rt-tray/Sources-core/Setup/SetupFlowModel.swift`
- Create: `rt-tray/Sources/AccessibilityIDs.swift`, `rt-tray/Sources/Setup/SetupSession.swift`, `rt-tray/Sources/Setup/SetupWindowController.swift`, `rt-tray/Sources/Setup/SetupView.swift`, `rt-tray/Sources/Setup/Screens/WelcomeScreen.swift`, `rt-tray/Sources/Setup/Components/StatusBadge.swift`
- Create: `rt-tray/Tests/MattstackCoreChecks/SetupFlowChecks.swift`; modify `AllChecks.swift`

**Interfaces:**
- Produces (Core): `public enum SetupStep: Int, CaseIterable, Sendable { welcome, team, checklist, install, done }` with `title: String`, `indicator: String` ("Step n of 5"); `@MainActor public final class SetupFlowModel: ObservableObject` — `@Published step: SetupStep`, `@Published isInstalling: Bool`; `var canGoBack: Bool` (false on welcome, install-while-running, done), `var continueTitle: String` ("Continue" / "Install" on checklist / "Finish" on done), `func next()`, `func back()`, `func jump(to:)`, `var windowMayClose: Bool` (only on done).
- Produces (app): `enum AXID` — **the single list of accessibility identifiers** every interactive control and row in the Setup and Settings windows carries (L7 drives the UI through System Events until Xcode exists and reads the same names from this file). Convention `setup.<screen>.<element>` / `settings.<pane>.<element>`; dynamic rows use functions (`AXID.checklistRow("perm.fda")` → `setup.checklist.row.perm.fda`, `.checklistRowAction(...)` → `…action`, `.checklistRowStatus(...)` → `…status`, `.installStep(id)`, `.installStepLog(id)`, `.connectField(name)`, `.connectAlternative(id)`, `.settingsPermissionAction(id)`). Screen-level continue/back are per screen: `setup.<screen>.continue`, `setup.<screen>.back`, `setup.checklist.continueLimited`. `enum SetupSession { static var isRunning: Bool }` (true while the Setup window exists and step != done — the updater's idle gate); `final class SetupWindowController: NSWindowController` — `init(environment: SetupEnvironment)`; `func show(step: SetupStep? = nil, joinCode: String? = nil)`; `let flow: SetupFlowModel`, `let team: TeamChoiceModel`; `struct SetupEnvironment { rt: RtRunning; readiness: ReadinessModel; install: InstallRunModel; permissions: PermissionsService; isDevBuild: Bool; bundleId: String; bundlePath: String }`; `struct SetupView: View`; `struct StatusBadge: View` (RowStatus → glyph per spec); `struct SetupFooter: View` (Back / Continue `.keyboardShortcut(.defaultAction)` `.controlSize(.large)`).

- [ ] **Step 1: Failing checks**

`rt-tray/Tests/MattstackCoreChecks/SetupFlowChecks.swift`:
```swift
import Foundation
import MattstackCore

let setupFlowChecks: [Check] = [
    Check("SetupStep order, titles, indicator") { c in
        c.expectEqual(SetupStep.allCases.map(\.rawValue), [0, 1, 2, 3, 4])
        c.expectEqual(SetupStep.checklist.indicator, "Step 3 of 5")
        c.expectEqual(SetupStep.team.title, "Your team")
        c.expectEqual(SetupStep.checklist.title, "Before we begin")
    },
    Check("flow: next/back bounds, continue titles, back disabled on welcome/install-running/done, close only on done") { c in
        await MainActor.run {
            let f = SetupFlowModel()
            c.expectEqual(f.step, .welcome)
            c.expectEqual(f.canGoBack, false)
            c.expectEqual(f.windowMayClose, false)
            f.back(); c.expectEqual(f.step, .welcome)
            f.next(); c.expectEqual(f.step, .team); c.expectEqual(f.canGoBack, true)
            f.next(); c.expectEqual(f.step, .checklist); c.expectEqual(f.continueTitle, "Install")
            f.next(); c.expectEqual(f.step, .install)
            f.isInstalling = true; c.expectEqual(f.canGoBack, false)
            f.isInstalling = false; c.expectEqual(f.canGoBack, true)
            f.next(); c.expectEqual(f.step, .done); c.expectEqual(f.continueTitle, "Finish")
            c.expectEqual(f.canGoBack, false); c.expectEqual(f.windowMayClose, true)
            f.next(); c.expectEqual(f.step, .done)
            f.jump(to: .team); c.expectEqual(f.step, .team)
        }
    },
]
```

- [ ] **Step 2: Run → compile failure. Implement Core**

`rt-tray/Sources-core/Setup/SetupFlowModel.swift`:
```swift
import Foundation
import Combine

public enum SetupStep: Int, CaseIterable, Sendable {
    case welcome, team, checklist, install, done

    public var title: String {
        switch self {
        case .welcome: return "Welcome to mattstack"
        case .team: return "Your team"
        case .checklist: return "Before we begin"
        case .install: return "Installing"
        case .done: return "Everything's working"
        }
    }
    public var indicator: String { "Step \(rawValue + 1) of \(SetupStep.allCases.count)" }
}

/// Custom page model (spec §4): push transitions, Back never dismisses,
/// the window only closes once setup is done.
@MainActor
public final class SetupFlowModel: ObservableObject {
    @Published public var step: SetupStep = .welcome
    @Published public var isInstalling = false
    public init() {}

    public var canGoBack: Bool {
        switch step {
        case .welcome, .done: return false
        case .install: return !isInstalling
        default: return true
        }
    }
    public var continueTitle: String {
        switch step {
        case .checklist: return "Install"
        case .done: return "Finish"
        default: return "Continue"
        }
    }
    public var windowMayClose: Bool { step == .done }

    public func next() { if let n = SetupStep(rawValue: step.rawValue + 1) { step = n } }
    public func back() { guard canGoBack, let p = SetupStep(rawValue: step.rawValue - 1) else { return }; step = p }
    public func jump(to s: SetupStep) { step = s }
}
```
Run checks → pass.

- [ ] **Step 3: App shell — accessibility ids, session flag, window controller, view, footer, welcome**

`rt-tray/Sources/AccessibilityIDs.swift` (every id in the app lives here; add, never inline a literal):
```swift
import Foundation

/// Stable accessibility identifiers. L7's clean-room walkthrough drives the
/// UI by these names through System Events, so they are a contract: rename
/// only with L7.
enum AXID {
    // Setup window chrome
    static let stepIndicator = "setup.window.stepIndicator"
    static func `continue`(_ screen: String) -> String { "setup.\(screen).continue" }
    static func back(_ screen: String) -> String { "setup.\(screen).back" }
    static let continueLimited = "setup.checklist.continueLimited"

    // Screens (the root view of each)
    static let welcomeScreen = "setup.welcome.screen"
    static let teamScreen = "setup.team.screen"
    static let checklistScreen = "setup.checklist.screen"
    static let installScreen = "setup.install.screen"
    static let doneScreen = "setup.done.screen"

    // Your team
    static let teamCardCreate = "setup.team.card.create"
    static let teamCardJoin = "setup.team.card.join"
    static let teamCardRestore = "setup.team.card.restore"
    static let teamCreateName = "setup.team.create.name"
    static let teamCreateOthers = "setup.team.create.others"
    static let teamCreateUseGh = "setup.team.create.useGh"
    static let teamCreateOwner = "setup.team.create.owner"
    static let teamCreateRemote = "setup.team.create.remote"
    static let teamJoinCode = "setup.team.join.code"
    static let teamRestoreRepo = "setup.team.restore.repo"
    static let teamRestoreKey = "setup.team.restore.key"

    // Checklist
    static func checklistRow(_ id: String) -> String { "setup.checklist.row.\(id)" }
    static func checklistRowAction(_ id: String) -> String { "setup.checklist.row.\(id).action" }
    static func checklistRowStatus(_ id: String) -> String { "setup.checklist.row.\(id).status" }
    static let checklistRecheck = "setup.checklist.recheck"
    static let checklistRelaunch = "setup.checklist.relaunch"
    static func connectField(_ name: String) -> String { "setup.checklist.connect.field.\(name)" }
    static func connectAlternative(_ id: String) -> String { "setup.checklist.connect.alt.\(id)" }
    static let connectSubmit = "setup.checklist.connect.submit"
    static let connectCancel = "setup.checklist.connect.cancel"
    static let stepsDone = "setup.checklist.steps.done"

    // Install
    static func installStep(_ id: String) -> String { "setup.install.step.\(id)" }
    static func installStepLog(_ id: String) -> String { "setup.install.step.\(id).log" }
    static let installRetry = "setup.install.retry"
    static let installRetryStream = "setup.install.retryStream"
    static let logCopy = "setup.install.log.copy"
    static let logDone = "setup.install.log.done"

    // Done
    static let doneOpenBoard = "setup.done.openBoard"
    static let doneInvite = "setup.done.invite"

    // Settings
    static let settingsGeneralStartAtLogin = "settings.general.startAtLogin"
    static let settingsGeneralAutoUpdates = "settings.general.autoUpdates"
    static let settingsGeneralCheckNow = "settings.general.checkNow"
    static let settingsGeneralDevMode = "settings.general.devMode"
    static func settingsPermissionAction(_ id: String) -> String { "settings.permissions.row.\(id).action" }
    static let settingsPermissionsReset = "settings.permissions.reset"
    static let settingsTeamInviteHandle = "settings.team.inviteHandle"
    static let settingsTeamInvite = "settings.team.invite"
    static let settingsTeamCopyPaste = "settings.team.copyPasteBlock"
    static let settingsTeamJoinAnother = "settings.team.joinAnother"
    static let settingsUninstall = "settings.uninstall.button"
    static let settingsUninstallConfirm = "settings.uninstall.confirm"
    static let settingsUninstallKeepData = "settings.uninstall.keepData"
}
```

`rt-tray/Sources/Setup/SetupSession.swift`:
```swift
import Foundation

/// Process-wide "setup is in progress" flag: the updater's idle gate reads it
/// and the window controller owns it.
enum SetupSession {
    static var isRunning = false
}
```

`rt-tray/Sources/Setup/Components/StatusBadge.swift`:
```swift
import SwiftUI
import MattstackCore

struct StatusBadge: View {
    let status: RowStatus
    var id: String? = nil
    var body: some View {
        let symbol = StatusGlyph.symbol(for: status)
        Group {
            if symbol == "progress" {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: symbol).foregroundStyle(color)
            }
        }
        .frame(width: 20, height: 20)
        .accessibilityLabel(Text(status.rawValue))
        .accessibilityValue(Text(status.rawValue))
        .accessibilityIdentifier(id ?? "")
    }
    private var color: Color {
        switch StatusGlyph.tint(for: status) {
        case .green: return .green
        case .red: return .red
        case .yellow: return .yellow
        case .grey: return .secondary
        case .none: return .primary
        }
    }
}
```

`rt-tray/Sources/Setup/SetupWindowController.swift`:
```swift
import AppKit
import SwiftUI
import Combine
import MattstackCore

struct SetupEnvironment {
    let rt: RtRunning
    let readiness: ReadinessModel
    let install: InstallRunModel
    let permissions: PermissionsService
    let isDevBuild: Bool
    let bundleId: String
    let bundlePath: String
}

/// One dedicated NSWindow hosting SwiftUI (AppKit lifecycle stays). ~560 pt
/// wide, fixed; close/minimize appear only once setup is done.
final class SetupWindowController: NSWindowController, NSWindowDelegate {
    static let width: CGFloat = 560
    let flow = SetupFlowModel()
    let team: TeamChoiceModel
    private let environment: SetupEnvironment
    private var activeObserver: Any?
    private var cancellables = Set<AnyCancellable>()

    init(environment: SetupEnvironment) {
        self.environment = environment
        self.team = TeamChoiceModel(rt: environment.rt)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 620),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "mattstack Setup"
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
        window.delegate = self
        let root = SetupView(flow: flow, team: team, readiness: environment.readiness, install: environment.install,
                             permissions: environment.permissions, env: environment)
        window.contentViewController = NSHostingController(rootView: root)
        window.setContentSize(NSSize(width: Self.width, height: 620))
        flow.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.applyStyle() } }
            .store(in: &cancellables)
    }
    required init?(coder: NSCoder) { fatalError("not supported") }

    func show(step: SetupStep? = nil, joinCode: String? = nil) {
        if let step { flow.jump(to: step) }
        if let joinCode { team.choice = .join; team.inviteCode = joinCode }
        SetupSession.isRunning = true
        applyStyle()
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        activeObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.environment.readiness.didBecomeActive()
        }
    }

    private func applyStyle() {
        guard let window else { return }
        var mask: NSWindow.StyleMask = [.titled]
        if flow.windowMayClose { mask.insert([.closable, .miniaturizable]) }
        window.styleMask = mask
        SetupSession.isRunning = !flow.windowMayClose
    }

    func windowWillClose(_ notification: Notification) {
        SetupSession.isRunning = false
        environment.readiness.becameHidden()
        if let o = activeObserver { NotificationCenter.default.removeObserver(o) }
    }
}
```

`rt-tray/Sources/Setup/SetupView.swift`:
```swift
import SwiftUI
import MattstackCore

struct SetupView: View {
    @ObservedObject var flow: SetupFlowModel
    @ObservedObject var team: TeamChoiceModel
    @ObservedObject var readiness: ReadinessModel
    @ObservedObject var install: InstallRunModel
    let permissions: PermissionsService
    let env: SetupEnvironment
    @State private var busy = false
    @State private var errorText: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ZStack {
                switch flow.step {
                case .welcome: WelcomeScreen().transition(pushTransition)
                case .team: TeamScreen(model: team).transition(pushTransition)
                case .checklist: ChecklistScreen(model: readiness, permissions: permissions, rt: env.rt, bundleId: env.bundleId).transition(pushTransition)
                case .install: InstallScreen(model: install).transition(pushTransition)
                case .done: DoneScreen(install: install, isOwner: team.choice == .create, onInvite: { NotificationCenter.default.post(name: .rtShowSettingsTeam, object: nil) }).transition(pushTransition)
                }
            }
            .animation(.easeInOut(duration: 0.22), value: flow.step)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            footer
        }
        .frame(width: SetupWindowController.width)
        .frame(minHeight: 560)
        .controlSize(.large)
        .onChange(of: flow.step) { _, step in
            if step == .checklist { readiness.becameVisible(); Task { await readiness.load() } } else { readiness.becameHidden() }
            if step == .install { flow.isInstalling = true; install.start() }
        }
        .onChange(of: install.phase) { _, phase in
            flow.isInstalling = (phase == .running)
            if phase == .succeeded { flow.next() }
        }
    }

    private var pushTransition: AnyTransition {
        .asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .move(edge: .leading).combined(with: .opacity))
    }

    private var header: some View {
        HStack {
            Text(flow.step.title).font(.title2.weight(.semibold))
            Spacer()
            Text(flow.step.indicator).font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier(AXID.stepIndicator)
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
    }

    private var footer: some View {
        HStack {
            if let errorText { Text(errorText).font(.caption).foregroundStyle(.red).lineLimit(2) }
            Spacer()
            if flow.canGoBack {
                Button("Back") { flow.back() }.accessibilityIdentifier(AXID.back(screenName))
            }
            if flow.step == .checklist, readiness.limitedModeAvailable {
                Button("Continue in limited mode") { flow.next() }.accessibilityIdentifier(AXID.continueLimited)
            }
            Button(flow.continueTitle) { Task { await advance() } }
                .keyboardShortcut(.defaultAction)
                .disabled(!continueEnabled || busy)
                .accessibilityIdentifier(AXID.continue(screenName))
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
    }

    private var screenName: String { String(describing: flow.step) }

    private var continueEnabled: Bool {
        switch flow.step {
        case .welcome: return true
        case .team: return team.canContinue
        case .checklist: return readiness.canInstall
        case .install: return install.phase == .succeeded
        case .done: return true
        }
    }

    private func advance() async {
        errorText = nil
        switch flow.step {
        case .team:
            busy = true; defer { busy = false }
            if let err = await team.validateAndPrepare() { errorText = err; return }
            flow.next()
        case .done:
            NSApp.keyWindow?.close()
        default:
            flow.next()
        }
    }
}

extension Notification.Name {
    static let rtShowSettingsTeam = Notification.Name("rtShowSettingsTeam")
}
```
(`TeamScreen`, `ChecklistScreen`, `InstallScreen`, `DoneScreen`, `TeamChoiceModel` arrive in Tasks 13–16. To keep this task building, create them as minimal placeholders in their final files now — `struct TeamScreen: View { @ObservedObject var model: TeamChoiceModel; var body: some View { Text("team") } }` etc. — and `TeamChoiceModel` with `choice`, `inviteCode`, `canContinue`, `validateAndPrepare()` stubs returning nil — each replaced wholesale in its own task. Stubs must be committed with a one-line `// replaced in Task N` marker so the reviewer of this task knows they are scaffolding; the later task deletes the marker.)

`rt-tray/Sources/Setup/Screens/WelcomeScreen.swift`:
```swift
import SwiftUI

struct WelcomeScreen: View {
    private let bullets: [(String, String)] = [
        ("terminal", "Install the rt command into ~/.local/bin and add one PATH line to your shell rc."),
        ("gearshape.2", "Run background services: the rt daemon, deck, board, and gitq."),
        ("sparkles", "Install the mattstack skills into Claude Code."),
        ("puzzlepiece.extension", "Install the editor extension."),
        ("lock.shield", "Ask for Full Disk Access and background-item approval."),
    ]
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 56, height: 56)
                Text("mattstack sets up your Mac for the team: one app, one menu-bar item, everything else underneath.")
                    .font(.body)
            }
            Text("Setup will:").font(.headline)
            ForEach(bullets, id: \.1) { b in
                Label { Text(b.1) } icon: { Image(systemName: b.0).frame(width: 20) }
            }
            Spacer()
            Text("Everything here is reversible from Settings → Uninstall.").font(.callout).foregroundStyle(.secondary)
        }
        .padding(24)
        .accessibilityIdentifier(AXID.welcomeScreen)
    }
}
```

- [ ] **Step 4: `swift build` → Build complete; checks pass. Commit**
```bash
git add rt-tray/Sources-core rt-tray/Sources/Setup rt-tray/Tests
git commit -m "MAT-383: Setup window shell — flow model, fixed 560pt window, footer, Welcome screen

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: "Your team" screen — create / join / restore cards, rt-validated Continue

**Files:**
- Create: `rt-tray/Sources-core/Setup/TeamChoiceModel.swift` (replaces the Task 12 stub), `rt-tray/Sources-core/Setup/Slug.swift`
- Create/replace: `rt-tray/Sources/Setup/Screens/TeamScreen.swift`
- Create: `rt-tray/Tests/MattstackCoreChecks/TeamChoiceChecks.swift`; modify `AllChecks.swift`

**Interfaces:**
- Produces (Core):
  - `public enum Slug { static func make(_ name: String) -> String }` (lowercase, `[a-z0-9-]`, collapse dashes, trim)
  - `public enum TeamChoice: Equatable, Sendable { create, join, restore }`
  - `public struct GitHubStatus: Codable { status: RowStatus; handle: String?; owners: [String]? }` (from `rt setup github status --json`)
  - `@MainActor public final class TeamChoiceModel: ObservableObject` — `init(rt: RtRunning)`; `@Published choice: TeamChoice = .create`, `teamName`, `othersWillJoin = true`, `useGhRepo: Bool`, `ghOwner: String?`, `ghOwners: [String]`, `ghHandle: String?`, `remoteURL`, `inviteCode`, `restoreRepo`, `restoreAgeKey`, `joinSummary: String?`, `isChecking`; `var slugPreview: String`; `var canContinue: Bool`; `func loadGitHubStatus() async`; `func validateAndPrepare() async -> String?` (nil = ok; otherwise the specific failure copy); `static func joinFailureCopy(_ error: RtUserError, owner: String?, team: String?) -> String`; `static let inviteCodeLength = 77`.
  - Verbs called (contract): `rt setup github status --json` → `{status, handle, owners, …}` (L1 T12 adds `handle`/`owners`); `rt team create <name> (--remote <url> | --create-repo <owner>) [--others] --json` (create; with `useGhRepo` the app passes `--create-repo <owner>` and L1 names the repo `mattstack-team-<slug>`, which matches `ghRepoPreview`); `rt team join --dry-run --json` with stdin `{"code": "..."}` (exit 0 `{access:"ok"|"denied"|"unreachable", message}`; exit 2 only for `invite-unknown`/`invite-malformed`); **restore (ruling R3): the app runs the REAL `rt restore <org>/<repo> --json` with stdin `{"ageKey": "..."}` when the user presses Continue, then `rt setup intent restore <org>/<repo> --json`** (L1's `home.restore` apply step only verifies the clone + key; a `--dry-run` is used only if the settings lane ships `rt restore --dry-run --json`); `rt home init --dry-run --json` for the home-repo remote check (create and join both need the home repo).

- [ ] **Step 1: Failing checks**

`rt-tray/Tests/MattstackCoreChecks/TeamChoiceChecks.swift`:
```swift
import Foundation
import MattstackCore

final class ScriptedRt: RtRunning, @unchecked Sendable {
    var answers: [String: (Int32, String)] = [:]   // key: args joined by space
    var calls: [(args: [String], stdin: String?)] = []
    func run(_ args: [String], stdin: Data?) async throws -> RtResult {
        calls.append((args, stdin.map { String(decoding: $0, as: UTF8.self) }))
        let key = args.joined(separator: " ")
        let (code, out) = answers.first { key.hasPrefix($0.key) }?.value ?? (1, "")
        return RtResult(exitCode: code, stdout: Data(out.utf8), stderr: Data())
    }
    func stream(_ args: [String], stdin: Data?) -> AsyncThrowingStream<String, Error> { AsyncThrowingStream { $0.finish() } }
}

let teamChoiceChecks: [Check] = [
    Check("Slug.make") { c in
        c.expectEqual(Slug.make("Acme Claims!"), "acme-svc")
        c.expectEqual(Slug.make("  My  Team -- 2 "), "my-team-2")
        c.expectEqual(Slug.make(""), "")
    },
    Check("create: slug preview, gh owner picker from github status, canContinue needs name + remote") { c in
        let rt = ScriptedRt()
        rt.answers["setup github status"] = (0, #"{"contract":1,"status":"ready","handle":"m4ttheweric","owners":["m4ttheweric","acme"]}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await m.loadGitHubStatus()
        await MainActor.run {
            c.expectEqual(m.ghHandle, "m4ttheweric")
            c.expectEqual(m.ghOwners, ["m4ttheweric", "acme"])
            c.expectEqual(m.useGhRepo, true)
            c.expectEqual(m.ghOwner, "m4ttheweric")
            c.expectEqual(m.canContinue, false)
            m.teamName = "Acme Claims"
            c.expectEqual(m.slugPreview, "acme-svc")
            c.expectEqual(m.ghRepoPreview, "m4ttheweric/mattstack-team-acme-claims")
            c.expectEqual(m.canContinue, true)
            m.useGhRepo = false
            c.expectEqual(m.canContinue, false, "URL field now required")
            m.remoteURL = "git@gitlab.example.com:tools/mattstack-team.git"
            c.expectEqual(m.canContinue, true)
        }
    },
    Check("create: validateAndPrepare calls home init --dry-run then team create, never with secrets on argv") { c in
        let rt = ScriptedRt()
        rt.answers["home init --dry-run"] = (0, #"{"contract":1,"ok":true}"#)
        rt.answers["team create"] = (0, #"{"contract":1,"team":{"slug":"acme-svc","name":"Acme Claims"},"remote":"ok"}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await MainActor.run { m.choice = .create; m.teamName = "Acme Claims"; m.useGhRepo = false; m.remoteURL = "https://example.com/t.git" }
        let err = await m.validateAndPrepare()
        c.expect(err == nil, "got \(err ?? "")")
        c.expectEqual(rt.calls[0].args.prefix(3), ["home", "init", "--dry-run"])
        c.expectEqual(rt.calls[1].args, ["team", "create", "Acme Claims", "--remote", "https://example.com/t.git", "--others", "--json"])
        let gh = ScriptedRt()
        gh.answers["home init --dry-run"] = (0, #"{"contract":1,"ok":true}"#)
        gh.answers["team create"] = (0, #"{"contract":1,"team":{"slug":"acme-svc","name":"Acme Claims"},"remote":"ok"}"#)
        let m2 = await MainActor.run { TeamChoiceModel(rt: gh) }
        await MainActor.run { m2.choice = .create; m2.teamName = "Acme Claims"; m2.useGhRepo = true; m2.ghOwner = "acme"; m2.othersWillJoin = false }
        c.expect(await m2.validateAndPrepare() == nil)
        c.expectEqual(gh.calls[1].args, ["team", "create", "Acme Claims", "--create-repo", "acme", "--json"])
    },
    Check("join: code goes on stdin; success summary; failure copy is specific") { c in
        let rt = ScriptedRt()
        rt.answers["team join --dry-run"] = (0, #"{"contract":1,"team":{"slug":"acme","name":"Acme","owner":"matt"},"access":"ok","peering":"idle","message":"Joining Acme (owner matt)"}"#)
        rt.answers["home init --dry-run"] = (0, #"{"contract":1,"ok":true}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await MainActor.run { m.choice = .join; m.inviteCode = "ABCD-EFGH" }
        let err = await m.validateAndPrepare()
        c.expect(err == nil)
        c.expectEqual(rt.calls[0].args, ["team", "join", "--dry-run", "--json"])
        c.expectEqual(rt.calls[0].stdin, "{\"code\":\"ABCD-EFGH\"}")
        c.expect(rt.calls.allSatisfy { !$0.args.contains("ABCD-EFGH") }, "code never on argv")
        await MainActor.run { c.expectEqual(m.joinSummary, "Joining Acme (owner matt)") }
        let denied = ScriptedRt()
        denied.answers["team join --dry-run"] = (0, #"{"contract":1,"team":{"slug":"acme","name":"Acme","owner":"matt"},"access":"denied","peering":"idle","message":"You don't have access yet: ask matt to grant you access to Acme."}"#)
        let m2 = await MainActor.run { TeamChoiceModel(rt: denied) }
        await MainActor.run { m2.choice = .join; m2.inviteCode = "X" }
        let e2 = await m2.validateAndPrepare()
        c.expectEqual(e2, "You don't have access yet: ask matt to grant you access to Acme.", "access != ok comes back as an exit-0 result, not a user error")
        let unknown = ScriptedRt()
        unknown.answers["team join --dry-run"] = (2, #"{"contract":1,"error":{"code":"invite-unknown","message":""}}"#)
        let m3 = await MainActor.run { TeamChoiceModel(rt: unknown) }
        await MainActor.run { m3.choice = .join; m3.inviteCode = "X" }
        c.expectEqual(await m3.validateAndPrepare(), "Invite not recognized or expired: ask the team owner for a new one.")
        c.expectEqual(TeamChoiceModel.joinFailureCopy(RtUserError(code: "expired", message: ""), owner: "matt", team: nil),
                      "Invite not recognized or expired: ask matt for a new one.")
        c.expectEqual(TeamChoiceModel.joinFailureCopy(RtUserError(code: "wrong-account", message: ""), owner: nil, team: nil),
                      "This code is for a different forge account than you're signed into.")
    },
    Check("join: invite field accepts pasted codes with whitespace/newlines; ~77 chars; no per-char validation") { c in
        let m = await MainActor.run { TeamChoiceModel(rt: ScriptedRt()) }
        await MainActor.run {
            m.choice = .join
            m.inviteCode = " ABCD-EFGH-\nIJKL "
            c.expectEqual(m.normalizedInviteCode, "ABCD-EFGH-IJKL")
            c.expectEqual(m.canContinue, true)
            m.inviteCode = "   "
            c.expectEqual(m.canContinue, false)
            c.expectEqual(TeamChoiceModel.inviteCodeLength, 77)
        }
    },
    Check("restore: repo + key required; the real rt restore runs with the key on stdin, then setup intent restore") { c in
        let rt = ScriptedRt()
        rt.answers["restore"] = (0, #"{"contract":1,"ok":true,"repo":"m4ttheweric/mattstack-home"}"#)
        rt.answers["setup intent restore"] = (0, #"{"contract":1,"ok":true,"intent":"restore","repo":"m4ttheweric/mattstack-home"}"#)
        let m = await MainActor.run { TeamChoiceModel(rt: rt) }
        await MainActor.run { m.choice = .restore; m.restoreRepo = "m4ttheweric/mattstack-home"; c.expectEqual(m.canContinue, false); m.restoreAgeKey = "AGE-SECRET-KEY-1XYZ"; c.expectEqual(m.canContinue, true) }
        let err = await m.validateAndPrepare()
        c.expect(err == nil)
        c.expectEqual(rt.calls[0].args, ["restore", "m4ttheweric/mattstack-home", "--json"])
        c.expectEqual(rt.calls[0].stdin, "{\"ageKey\":\"AGE-SECRET-KEY-1XYZ\"}")
        c.expectEqual(rt.calls[1].args, ["setup", "intent", "restore", "m4ttheweric/mattstack-home", "--json"])
        c.expect(rt.calls.allSatisfy { !$0.args.contains("AGE-SECRET-KEY-1XYZ") }, "key never on argv")
    },
]
```

- [ ] **Step 2: Run → compile failure. Implement Core**

`rt-tray/Sources-core/Setup/Slug.swift`:
```swift
import Foundation

public enum Slug {
    public static func make(_ name: String) -> String {
        let lowered = name.lowercased()
        var out = ""
        var lastDash = true
        for ch in lowered {
            if ch.isLetter || ch.isNumber, ch.isASCII {
                out.append(ch); lastDash = false
            } else if !lastDash {
                out.append("-"); lastDash = true
            }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return out
    }
}
```

`rt-tray/Sources-core/Setup/TeamChoiceModel.swift`:
```swift
import Foundation
import Combine

public enum TeamChoice: Equatable, Sendable { case create, join, restore }

public struct GitHubStatus: Codable, Equatable, Sendable {
    public var status: RowStatus
    public var handle: String?
    public var owners: [String]?
}

/// Screen 2 state. Every validation is an rt verb; codes and keys travel on
/// stdin; nothing is pushed until Install.
@MainActor
public final class TeamChoiceModel: ObservableObject {
    public static let inviteCodeLength = 77
    public static let explainer = "mattstack keeps your team settings in git. That keeps them safe and gives you a paper trail: skill edits and every change are visible in history. The same goes for your own settings home repo, created by the same step."

    @Published public var choice: TeamChoice = .create
    @Published public var teamName = ""
    @Published public var othersWillJoin = true
    @Published public var useGhRepo = false
    @Published public var ghOwner: String?
    @Published public private(set) var ghOwners: [String] = []
    @Published public private(set) var ghHandle: String?
    @Published public var remoteURL = ""
    @Published public var inviteCode = ""
    @Published public var restoreRepo = ""
    @Published public var restoreAgeKey = ""
    @Published public private(set) var joinSummary: String?
    @Published public private(set) var isChecking = false

    private let rt: RtRunning
    public init(rt: RtRunning) { self.rt = rt }

    public var slugPreview: String { Slug.make(teamName) }
    public var ghRepoPreview: String { "\(ghOwner ?? ghHandle ?? "you")/mattstack-team-\(slugPreview)" }
    public var normalizedInviteCode: String { inviteCode.filter { !$0.isWhitespace && !$0.isNewline } }

    public var canContinue: Bool {
        switch choice {
        case .create:
            guard !slugPreview.isEmpty else { return false }
            return useGhRepo ? (ghHandle != nil) : !remoteURL.trimmingCharacters(in: .whitespaces).isEmpty
        case .join:
            return !normalizedInviteCode.isEmpty
        case .restore:
            return !restoreRepo.trimmingCharacters(in: .whitespaces).isEmpty && !restoreAgeKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    public func loadGitHubStatus() async {
        guard let result = try? await rt.run(["setup", "github", "status", "--json"], stdin: nil),
              let status = try? result.decode(GitHubStatus.self), status.status == .ready else { return }
        ghHandle = status.handle
        ghOwners = status.owners ?? [status.handle].compactMap { $0 }
        ghOwner = ghOwners.first
        useGhRepo = true
    }

    /// Runs the dry-run verbs for the chosen card. Returns nil on success or
    /// the exact sentence to show under the fields.
    public func validateAndPrepare() async -> String? {
        isChecking = true
        defer { isChecking = false }
        do {
            switch choice {
            case .create:
                if let e = await homeInitCheck() { return e }
                var args = ["team", "create", teamName]
                args += useGhRepo ? ["--create-repo", ghOwner ?? ghHandle ?? ""] : ["--remote", remoteURL.trimmingCharacters(in: .whitespaces)]
                if othersWillJoin { args.append("--others") }
                args.append("--json")
                let r = try await rt.run(args, stdin: nil)
                if let e = r.userError { return e.message }
                guard r.exitCode == 0 else { return "rt team create failed (exit \(r.exitCode))." }
                return nil
            case .join:
                let stdin = try JSONEncoder().encode(["code": normalizedInviteCode])
                let r = try await rt.run(["team", "join", "--dry-run", "--json"], stdin: stdin)
                if let e = r.userError { return Self.joinFailureCopy(e, owner: nil, team: nil) }
                guard r.exitCode == 0, let j = try? r.decode(TeamJoinResult.self) else { return "rt team join failed (exit \(r.exitCode))." }
                guard j.access == "ok" else { return Self.joinFailureCopy(RtUserError(code: j.access == "denied" ? "no-access" : "unreachable", message: j.message ?? ""), owner: j.team?.owner, team: j.team?.name) }
                joinSummary = j.message ?? "Joining \(j.team?.name ?? "") (owner \(j.team?.owner ?? ""))"
                return await homeInitCheck()
            case .restore:
                // Ruling R3: the app runs the real restore at Continue (clone
                // + key into the Keychain), then records the intent so
                // `setup apply`'s home.restore step only verifies.
                let repo = restoreRepo.trimmingCharacters(in: .whitespaces)
                let stdin = try JSONEncoder().encode(["ageKey": restoreAgeKey.trimmingCharacters(in: .whitespacesAndNewlines)])
                let r = try await rt.run(["restore", repo, "--json"], stdin: stdin)
                if let e = r.userError { return e.message }
                guard r.exitCode == 0 else { return "rt restore failed (exit \(r.exitCode))." }
                let intent = try await rt.run(["setup", "intent", "restore", repo, "--json"], stdin: nil)
                if let e = intent.userError { return e.message }
                return intent.exitCode == 0 ? nil : "rt setup intent restore failed (exit \(intent.exitCode))."
            }
        } catch {
            return "Could not run rt: \(error)"
        }
    }

    private func homeInitCheck() async -> String? {
        guard let r = try? await rt.run(["home", "init", "--dry-run", "--json"], stdin: nil) else { return "Could not run rt home init." }
        if let e = r.userError { return e.message }
        return r.exitCode == 0 ? nil : "rt home init --dry-run failed (exit \(r.exitCode))."
    }

    public static func joinFailureCopy(_ error: RtUserError, owner: String?, team: String?) -> String {
        let who = owner ?? "the team owner"
        switch error.code {
        case "no-access": return error.message.isEmpty ? "You don't have access yet: ask \(who) to grant you access to \(team ?? "the team")." : error.message
        case "expired", "not-found", "redeemed", "invite-unknown": return "Invite not recognized or expired: ask \(who) for a new one."
        case "invite-malformed": return "That doesn't look like an invite code — paste the whole code (about \(inviteCodeLength) characters)."
        case "wrong-account": return "This code is for a different forge account than you're signed into."
        default: return error.message.isEmpty ? "Couldn't redeem the invite." : error.message
        }
    }
}
```
(Delete the Task 12 stub `TeamChoiceModel` from the app target — the real one lives in Core now.)

- [ ] **Step 3: Run checks → pass.**

- [ ] **Step 4: The screen**

`rt-tray/Sources/Setup/Screens/TeamScreen.swift`:
```swift
import SwiftUI
import MattstackCore

struct TeamScreen: View {
    @ObservedObject var model: TeamChoiceModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                card(.create, title: "Create a team", systemImage: "person.3") { createFields }
                card(.join, title: "Join a team", systemImage: "person.crop.circle.badge.plus") { joinFields }
                card(.restore, title: "Already have mattstack settings?", systemImage: "arrow.counterclockwise.icloud", compact: true) { restoreFields }
            }
            .padding(20)
        }
        .task { await model.loadGitHubStatus() }
        .accessibilityIdentifier(AXID.teamScreen)
    }

    @ViewBuilder
    private func card<Content: View>(_ choice: TeamChoice, title: String, systemImage: String, compact: Bool = false,
                                     @ViewBuilder content: () -> Content) -> some View {
        let selected = model.choice == choice
        VStack(alignment: .leading, spacing: 10) {
            Button { model.choice = choice } label: {
                HStack {
                    Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    Label(title, systemImage: systemImage).font(compact ? .body : .headline)
                    Spacer()
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(cardID(choice))
            if selected { content().padding(.leading, 24) }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? Color.accentColor : Color.clear, lineWidth: 1))
    }

    private func cardID(_ c: TeamChoice) -> String {
        switch c { case .create: return AXID.teamCardCreate; case .join: return AXID.teamCardJoin; case .restore: return AXID.teamCardRestore }
    }

    private var createFields: some View {
        Form {
            TextField("Team name", text: $model.teamName, prompt: Text("Acme")).accessibilityIdentifier(AXID.teamCreateName)
            LabeledContent("Slug") { Text(model.slugPreview.isEmpty ? "—" : model.slugPreview).foregroundStyle(.secondary) }
            Toggle("Others will join later", isOn: $model.othersWillJoin).accessibilityIdentifier(AXID.teamCreateOthers)
            if model.ghHandle != nil {
                Toggle("Create a private GitHub repo \(model.ghRepoPreview)", isOn: $model.useGhRepo).accessibilityIdentifier(AXID.teamCreateUseGh)
                if model.useGhRepo {
                    Picker("Owner", selection: Binding(get: { model.ghOwner ?? "" }, set: { model.ghOwner = $0 })) {
                        ForEach(model.ghOwners, id: \.self) { Text($0).tag($0) }
                    }
                    .accessibilityIdentifier(AXID.teamCreateOwner)
                }
            }
            if !model.useGhRepo {
                TextField("Repository URL", text: $model.remoteURL, prompt: Text("paste an empty repo's URL; GitHub, GitLab, anything git can push to"))
                    .accessibilityIdentifier(AXID.teamCreateRemote)
            }
            Text(TeamChoiceModel.explainer).font(.callout).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .scrollDisabled(true)
    }

    private var joinFields: some View {
        Form {
            VStack(alignment: .leading, spacing: 4) {
                Text("Invite code")
                TextEditor(text: $model.inviteCode)
                    .font(.system(.body, design: .monospaced))
                    .frame(minHeight: 54)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
                    .accessibilityIdentifier(AXID.teamJoinCode)
                Text("Paste the whole code (about \(TeamChoiceModel.inviteCodeLength) characters) or open the mattstack://join link you were sent.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let s = model.joinSummary { Label(s, systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
            Text(TeamChoiceModel.explainer).font(.callout).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .scrollDisabled(true)
    }

    private var restoreFields: some View {
        Form {
            TextField("Home repo", text: $model.restoreRepo, prompt: Text("<org>/<repo>")).accessibilityIdentifier(AXID.teamRestoreRepo)
            SecureField("Age key (from your password manager)", text: $model.restoreAgeKey).accessibilityIdentifier(AXID.teamRestoreKey)
            Text("Clones your settings to ~/.mattstack, installs the key in the Keychain, and replays your teams and packs during Install.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .scrollDisabled(true)
    }
}
```

- [ ] **Step 5: `swift build`; checks pass. Commit**
```bash
git add rt-tray/Sources-core rt-tray/Sources/Setup rt-tray/Tests
git commit -m "MAT-383: Your team screen — create/join/restore cards, rt-validated Continue, codes on stdin

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Readiness checklist screen — grouped rows, one action each, Install gating, action dispatch

**Files:**
- Create: `rt-tray/Sources-core/Readiness/RowActionDispatcher.swift`
- Create/replace: `rt-tray/Sources/Setup/Screens/ChecklistScreen.swift`, `rt-tray/Sources/Setup/Components/RowView.swift`, `rt-tray/Sources/Setup/Components/ConnectSheet.swift`, `rt-tray/Sources/Setup/Components/StepsSheet.swift`
- Create: `rt-tray/Tests/MattstackCoreChecks/RowActionChecks.swift`; modify `AllChecks.swift`

**Interfaces:**
- Produces (Core): `public enum DispatchedAction: Equatable { openSettings(target: String); requestPermission(which: String); rtVerb(args: [String], stdin: Data?); openURL(URL); showSteps([String]); collectFields([ActionField], integration: String, alternatives: [ActionAlternative]); none }`; `public enum RowActionDispatcher { static func dispatch(_ action: RowAction, fieldValues: [String: String]?, alternative: String?) -> DispatchedAction }` — `connect` without values → `collectFields`; with values → `rtVerb(["setup", integration, "connect", "--json"], stdin: JSON of values)`; alternative `use-gh` → stdin `{"useGh":true}`; `oauth` → `rtVerb(verb + ["--json"])`; `owner-once` → collect then `rtVerb(["setup","slack","create-app","--json"], stdin: JSON `{"configToken":…}`)` (no `--config-token-stdin` flag — L1 reads a raw token line under that flag and JSON without it); `install` → `["tools","install",tool,"--json"]`; `link-bundled` → `["deps","link",tool,"--json"]`; `run` → verb + `--json`; `steps` → showSteps; `open-url` → openURL; `open-settings`/`request-permission` native; `unknown` → none.
- Produces (app): `ChecklistScreen(model:permissions:rt:bundleId:)`, `RowView`, `ConnectSheet` (SecureField per secret field, hint text, "Use gh login" alternative button), `StepsSheet`.

- [ ] **Step 1: Failing checks**

`rt-tray/Tests/MattstackCoreChecks/RowActionChecks.swift`:
```swift
import Foundation
import MattstackCore

let rowActionChecks: [Check] = [
    Check("native actions") { c in
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .openSettings, label: "Open…", target: "fda"), fieldValues: nil, alternative: nil), .openSettings(target: "fda"))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .requestPermission, label: "Allow", which: "notifications"), fieldValues: nil, alternative: nil), .requestPermission(which: "notifications"))
    },
    Check("connect: collect first, then rt setup <integration> connect with JSON on stdin; use-gh alternative") { c in
        let fields = [ActionField(name: "token", label: "Token", secret: true, hint: "read_api")]
        let a = RowAction(type: .connect, label: "Connect", integration: "gitlab", fields: fields, alternatives: [ActionAlternative(id: "use-gh", label: "Use gh login")])
        c.expectEqual(RowActionDispatcher.dispatch(a, fieldValues: nil, alternative: nil), .collectFields(fields, integration: "gitlab", alternatives: a.alternatives!))
        let d = RowActionDispatcher.dispatch(a, fieldValues: ["token": "glpat-xyz"], alternative: nil)
        c.expectEqual(d, .rtVerb(args: ["setup", "gitlab", "connect", "--json"], stdin: Data("{\"token\":\"glpat-xyz\"}".utf8)))
        c.expectEqual(RowActionDispatcher.dispatch(a, fieldValues: nil, alternative: "use-gh"), .rtVerb(args: ["setup", "gitlab", "connect", "--json"], stdin: Data("{\"useGh\":true}".utf8)))
    },
    Check("oauth / owner-once / install / link-bundled / run / steps / open-url / unknown") { c in
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .oauth, label: "Connect", integration: "slack", verb: ["setup", "slack", "connect"]), fieldValues: nil, alternative: nil), .rtVerb(args: ["setup", "slack", "connect", "--json"], stdin: nil))
        let owner = RowAction(type: .ownerOnce, label: "Create…", integration: "slack", fields: [ActionField(name: "configToken", label: "App configuration token", secret: true)])
        c.expectEqual(RowActionDispatcher.dispatch(owner, fieldValues: ["configToken": "xoxe-1"], alternative: nil),
                      .rtVerb(args: ["setup", "slack", "create-app", "--json"], stdin: Data("{\"configToken\":\"xoxe-1\"}".utf8)))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .install, label: "Install", tool: "herdr", via: "brew"), fieldValues: nil, alternative: nil), .rtVerb(args: ["tools", "install", "herdr", "--json"], stdin: nil))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .linkBundled, label: "Use mattstack's", tool: "gh"), fieldValues: nil, alternative: nil), .rtVerb(args: ["deps", "link", "gh", "--json"], stdin: nil))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .run, label: "Re-check", verb: ["setup", "status"]), fieldValues: nil, alternative: nil), .rtVerb(args: ["setup", "status", "--json"], stdin: nil))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .steps, label: "Show steps…", steps: ["a", "b"]), fieldValues: nil, alternative: nil), .showSteps(["a", "b"]))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .openURL, label: "Download", url: "https://claude.ai/download"), fieldValues: nil, alternative: nil), .openURL(URL(string: "https://claude.ai/download")!))
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .unknown, label: "?"), fieldValues: nil, alternative: nil), .none)
        c.expectEqual(RowActionDispatcher.dispatch(RowAction(type: .openURL, label: "x", url: "not a url at all ::"), fieldValues: nil, alternative: nil), .none)
    },
]
```

- [ ] **Step 2: Run → compile failure. Implement**

`rt-tray/Sources-core/Readiness/RowActionDispatcher.swift`:
```swift
import Foundation

public enum DispatchedAction: Equatable, Sendable {
    case openSettings(target: String)
    case requestPermission(which: String)
    case rtVerb(args: [String], stdin: Data?)
    case openURL(URL)
    case showSteps([String])
    case collectFields([ActionField], integration: String, alternatives: [ActionAlternative])
    case none
}

/// Maps a contract action to what the app does. Native for the two
/// permission kinds; everything else is an rt verb, with any collected
/// values on stdin as JSON (sorted keys so the payload is deterministic).
public enum RowActionDispatcher {
    public static func dispatch(_ action: RowAction, fieldValues: [String: String]?, alternative: String?) -> DispatchedAction {
        switch action.type {
        case .openSettings: return .openSettings(target: action.target ?? "")
        case .requestPermission: return .requestPermission(which: action.which ?? "")
        case .connect:
            guard let integration = action.integration else { return .none }
            if alternative == "use-gh" { return .rtVerb(args: ["setup", integration, "connect", "--json"], stdin: json(["useGh": true])) }
            if let values = fieldValues { return .rtVerb(args: ["setup", integration, "connect", "--json"], stdin: json(values)) }
            return .collectFields(action.fields ?? [], integration: integration, alternatives: action.alternatives ?? [])
        case .ownerOnce:
            guard let integration = action.integration else { return .none }
            if let values = fieldValues { return .rtVerb(args: ["setup", integration, "create-app", "--json"], stdin: json(values)) }
            return .collectFields(action.fields ?? [], integration: integration, alternatives: [])
        case .oauth, .run:
            guard let verb = action.verb, !verb.isEmpty else { return .none }
            return .rtVerb(args: verb + ["--json"], stdin: nil)
        case .install:
            guard let tool = action.tool else { return .none }
            return .rtVerb(args: ["tools", "install", tool, "--json"], stdin: nil)
        case .linkBundled:
            guard let tool = action.tool else { return .none }
            return .rtVerb(args: ["deps", "link", tool, "--json"], stdin: nil)
        case .steps: return .showSteps(action.steps ?? [])
        case .openURL:
            guard let s = action.url, let u = URL(string: s), u.scheme?.hasPrefix("http") == true else { return .none }
            return .openURL(u)
        case .unknown: return .none
        }
    }

    private static func json<T: Encodable>(_ value: T) -> Data? {
        let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys]
        return try? enc.encode(value)
    }
}
```
Run checks → pass.

- [ ] **Step 3: The screen and components**

`rt-tray/Sources/Setup/Components/RowView.swift`:
```swift
import SwiftUI
import MattstackCore

struct RowView: View {
    let row: PlanRow
    let isChecking: Bool
    var rowID: String? = nil       // Settings → Permissions passes its own ids
    var actionID: String? = nil
    var statusID: String? = nil
    let onAction: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol(for: row.kind)).frame(width: 22).foregroundStyle(.secondary).padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(row.title).fontWeight(.medium)
                    if !row.required { Text("optional").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(Color.secondary.opacity(0.15))) }
                }
                Text(row.why).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let d = row.detail, !d.isEmpty { Text(d).font(.caption).foregroundStyle(.secondary) }
                if let n = row.optionalNote { Text(n).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 8)
            StatusBadge(status: isChecking ? .checking : row.status, id: statusID ?? AXID.checklistRowStatus(row.id))
            if let action = row.action, action.type != .unknown {
                Button(action.label, action: onAction)
                    .controlSize(.regular)
                    .accessibilityIdentifier(actionID ?? AXID.checklistRowAction(row.id))
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(rowID ?? AXID.checklistRow(row.id))
    }

    private func symbol(for kind: RowKind) -> String {
        switch kind {
        case .permission: return "lock.shield"
        case .tool: return "wrench.and.screwdriver"
        case .account: return "person.crop.circle"
        case .access: return "network"
        case .info: return "info.circle"
        }
    }
}
```

`rt-tray/Sources/Setup/Components/ConnectSheet.swift`:
```swift
import SwiftUI
import MattstackCore

struct ConnectSheet: View {
    let integration: String
    let fields: [ActionField]
    let alternatives: [ActionAlternative]
    let onSubmit: ([String: String]?, String?) -> Void   // (values, alternativeId)
    @State private var values: [String: String] = [:]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Connect \(integration.capitalized)").font(.headline)
            Form {
                ForEach(fields, id: \.name) { f in
                    VStack(alignment: .leading, spacing: 2) {
                        if f.secret {
                            SecureField(f.label, text: binding(f.name)).accessibilityIdentifier(AXID.connectField(f.name))
                        } else {
                            TextField(f.label, text: binding(f.name)).accessibilityIdentifier(AXID.connectField(f.name))
                        }
                        if let h = f.hint { Text(h).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
            .formStyle(.grouped)
            HStack {
                ForEach(alternatives, id: \.id) { alt in
                    Button(alt.label) { onSubmit(nil, alt.id); dismiss() }.accessibilityIdentifier(AXID.connectAlternative(alt.id))
                }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).accessibilityIdentifier(AXID.connectCancel)
                Button("Connect") { onSubmit(values, nil); dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(fields.contains { (values[$0.name] ?? "").isEmpty })
                    .accessibilityIdentifier(AXID.connectSubmit)
            }
        }
        .padding(20)
        .frame(width: 420)
    }

    private func binding(_ name: String) -> Binding<String> {
        Binding(get: { values[name] ?? "" }, set: { values[name] = $0 })
    }
}
```

`rt-tray/Sources/Setup/Components/StepsSheet.swift`:
```swift
import SwiftUI

struct StepsSheet: View {
    let title: String
    let steps: [String]
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                HStack(alignment: .top) { Text("\(i + 1).").monospacedDigit(); Text(s).textSelection(.enabled) }
            }
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction).accessibilityIdentifier(AXID.stepsDone) }
        }
        .padding(20).frame(width: 440)
    }
}
```

`rt-tray/Sources/Setup/Screens/ChecklistScreen.swift`:
```swift
import SwiftUI
import MattstackCore

struct ChecklistScreen: View {
    @ObservedObject var model: ReadinessModel
    let permissions: PermissionsService
    let rt: RtRunning
    let bundleId: String
    @State private var connect: (row: PlanRow, fields: [ActionField], integration: String, alternatives: [ActionAlternative])?
    @State private var steps: (title: String, steps: [String])?
    @State private var relaunchHint = false

    var body: some View {
        VStack(spacing: 0) {
            if let e = model.lastError {
                Label("Couldn't compute the checklist: \(e)", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red).padding(8)
            }
            Form {
                ForEach(model.groups) { group in
                    Section(group.title) {
                        ForEach(group.rows) { row in
                            RowView(row: row, isChecking: model.checkingRowIds.contains(row.id)) { perform(row) }
                        }
                        if group.id == "mac", relaunchHint || permissions.fdaNeedsRelaunch {
                            HStack {
                                Text("Full Disk Access was granted. Relaunch mattstack to apply it.").font(.caption)
                                Spacer()
                                Button("Relaunch mattstack") { relaunch() }.accessibilityIdentifier(AXID.checklistRelaunch)
                            }
                        }
                    }
                }
            }
            .formStyle(.grouped)
            HStack {
                Text(model.canInstall ? "Everything required is ready." : "\(model.requiredMissing.count) required item(s) left.")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Re-check") { Task { await model.recheckAll() } }.controlSize(.small).accessibilityIdentifier(AXID.checklistRecheck)
            }
            .padding(.horizontal, 20).padding(.vertical, 6)
        }
        .sheet(isPresented: Binding(get: { connect != nil }, set: { if !$0 { connect = nil } })) {
            if let c = connect {
                ConnectSheet(integration: c.integration, fields: c.fields, alternatives: c.alternatives) { values, alt in
                    run(RowActionDispatcher.dispatch(c.row.action!, fieldValues: values, alternative: alt), for: c.row)
                }
            }
        }
        .sheet(isPresented: Binding(get: { steps != nil }, set: { if !$0 { steps = nil } })) {
            if let s = steps { StepsSheet(title: s.title, steps: s.steps) }
        }
        .accessibilityIdentifier(AXID.checklistScreen)
    }

    private func perform(_ row: PlanRow) {
        guard let action = row.action else { return }
        run(RowActionDispatcher.dispatch(action, fieldValues: nil, alternative: nil), for: row)
    }

    private func run(_ dispatched: DispatchedAction, for row: PlanRow) {
        switch dispatched {
        case .openSettings(let target):
            permissions.openSettings(target)
            if target == "fda" { relaunchHint = false }
        case .requestPermission(let which):
            Task { _ = await permissions.request(which); await model.afterAction(rowId: row.id) }
        case .rtVerb(let args, let stdin):
            Task {
                let result = try? await rt.run(args, stdin: stdin)
                if let e = result?.userError { TrayLog.warn("row action failed", ["row": row.id, "err": e.message]) }
                await model.afterAction(rowId: row.id)
            }
        case .openURL(let url):
            NSWorkspace.shared.open(url)
        case .showSteps(let list):
            steps = (row.title, list)
        case .collectFields(let fields, let integration, let alternatives):
            connect = (row, fields, integration, alternatives)
        case .none:
            break
        }
    }

    private func relaunch() {
        let path = Bundle.main.bundlePath
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        // Re-exec with the current arguments + environment so a clean-room
        // launch (`MATTSTACK_APPCAST_URL` + `--allow-appcast-override`)
        // survives the relaunch; `open` does not inherit either on its own.
        var args = ["-n", path]
        if let feed = ProcessInfo.processInfo.environment[UpdatePolicy.overrideEnv] { args += ["--env", "\(UpdatePolicy.overrideEnv)=\(feed)"] }
        let passthrough = Array(CommandLine.arguments.dropFirst())
        if !passthrough.isEmpty { args += ["--args"] + passthrough }
        task.arguments = args
        try? task.run()
        NSApp.terminate(nil)
    }
}
```
(`relaunch()` is the one `open` spawn outside the seam; it is UI-only and unreachable from checks. Row `why`/`detail` text is rt's; the app never writes its own status copy for non-permission rows.)

- [ ] **Step 4: `swift build`; checks pass. Commit**
```bash
git add rt-tray/Sources-core rt-tray/Sources/Setup rt-tray/Tests
git commit -m "MAT-383: Readiness checklist screen — grouped rows, one action each, connect sheet, Install gating

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: Install screen — live step list, need rows, failure + Show log + Retry

**Files:**
- Create/replace: `rt-tray/Sources/Setup/Screens/InstallScreen.swift`, `rt-tray/Sources/Setup/Components/LogSheet.swift`

**Interfaces:**
- Consumes: `InstallRunModel` (Task 11), `StatusBadge`.
- Produces: `InstallScreen(model:)`; `LogSheet(title:lines:)`.

- [ ] **Step 1: Write the views**

`rt-tray/Sources/Setup/Components/LogSheet.swift`:
```swift
import SwiftUI

struct LogSheet: View {
    let title: String
    let lines: [String]
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            ScrollView {
                Text(lines.isEmpty ? "(no log lines)" : lines.joined(separator: "\n"))
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: 260)
            .background(Color(nsColor: .textBackgroundColor))
            HStack {
                Button("Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string) }
                    .accessibilityIdentifier(AXID.logCopy)
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction).accessibilityIdentifier(AXID.logDone)
            }
        }
        .padding(20).frame(width: 520)
    }
}
```

`rt-tray/Sources/Setup/Screens/InstallScreen.swift`:
```swift
import SwiftUI
import MattstackCore

struct InstallScreen: View {
    @ObservedObject var model: InstallRunModel
    @State private var logFor: InstallStep?

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    ForEach(model.steps) { step in stepRow(step) }
                } header: {
                    Text(headerText)
                }
            }
            .formStyle(.grouped)
            if case .streamError(let e) = model.phase {
                HStack {
                    Label("Install stopped: \(e)", systemImage: "xmark.circle").foregroundStyle(.red).font(.callout)
                    Spacer()
                    Button("Retry") { model.start() }.accessibilityIdentifier(AXID.installRetryStream)
                }
                .padding(.horizontal, 20).padding(.vertical, 8)
            }
        }
        .sheet(item: $logFor) { s in LogSheet(title: s.info.title, lines: model.logLines(for: s.id)) }
        .accessibilityIdentifier(AXID.installScreen)
    }

    private var headerText: String {
        switch model.phase {
        case .idle: return "Ready to install."
        case .running: return "Installing… nothing runs that isn't listed here."
        case .succeeded: return "Installed."
        case .failed(let id, _): return "Stopped at \(model.steps.first { $0.id == id }?.info.title ?? id)."
        case .streamError: return "Install stopped."
        }
    }

    @ViewBuilder
    private func stepRow(_ step: InstallStep) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                StatusBadge(status: badge(step), id: AXID.installStep(step.id) + ".status")
                VStack(alignment: .leading, spacing: 2) {
                    Text(step.info.title)
                    if step.waitingOnYou {
                        Text(step.info.kind == .privileged ? "Waiting for you — an administrator prompt is open." : "Waiting for you — approve mattstack in Login Items if asked.")
                            .font(.caption).foregroundStyle(.orange)
                    } else if let d = step.detail, !d.isEmpty {
                        Text(d).font(.caption).foregroundStyle(step.state == .failed ? .red : .secondary)
                    }
                }
                Spacer()
                if !model.logLines(for: step.id).isEmpty {
                    Button("Show log") { logFor = step }.controlSize(.small).accessibilityIdentifier(AXID.installStepLog(step.id))
                }
            }
            if step.state == .failed, model.failedStepId == step.id {
                HStack(alignment: .top) {
                    if let r = step.remedy { Text(r).font(.callout) }
                    Spacer()
                    Button("Retry from here") { model.retryFromFailure() }
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier(AXID.installRetry)
                }
                .padding(.top, 2)
            }
        }
        .accessibilityIdentifier(AXID.installStep(step.id))
    }

    private func badge(_ step: InstallStep) -> RowStatus {
        switch step.state {
        case .pending: return .skipped
        case .running: return step.waitingOnYou ? .needsYou : .checking
        case .done: return .ready
        case .failed: return .error
        case .skipped: return .skipped
        }
    }
}
```
(`InstallStep` must be `Identifiable` for `.sheet(item:)` — it is, via `id`.)

- [ ] **Step 2: `swift build` → Build complete. Commit**
```bash
git add rt-tray/Sources/Setup
git commit -m "MAT-383: Install screen — live step list, need rows, failure remedy, Show log, Retry from here

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 16: Done screen

**Files:**
- Create/replace: `rt-tray/Sources/Setup/Screens/DoneScreen.swift`

- [ ] **Step 1: Write the view**

```swift
import SwiftUI
import MattstackCore

struct DoneScreen: View {
    @ObservedObject var install: InstallRunModel
    let isOwner: Bool
    let onInvite: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(systemName: "checkmark.seal.fill").font(.system(size: 40)).foregroundStyle(.green)
                VStack(alignment: .leading) {
                    Text("Everything's working").font(.title3.weight(.semibold))
                    Text(verifySummary).foregroundStyle(.secondary)
                }
            }
            Form {
                Section("Where things live") {
                    LabeledContent("Menu bar") { Text("the m at the top right") }
                    LabeledContent("Terminal") { Text("rt — open a new terminal window").font(.system(.body, design: .monospaced)) }
                    LabeledContent("Board") { Link("https://board.mattstack", destination: URL(string: "https://board.mattstack")!) }
                }
            }
            .formStyle(.grouped).scrollDisabled(true)
            HStack {
                Button("Open the board") { NSWorkspace.shared.open(URL(string: "https://board.mattstack")!) }.accessibilityIdentifier(AXID.doneOpenBoard)
                if isOwner { Button("Invite teammates…", action: onInvite).accessibilityIdentifier(AXID.doneInvite) }
                Spacer()
            }
            Spacer()
        }
        .padding(24)
        .accessibilityIdentifier(AXID.doneScreen)
    }

    private var verifySummary: String {
        let verify = install.steps.first { $0.id == "verify" }
        let n = install.steps.filter { $0.state == .done }.count
        return verify?.detail.map { "\($0) · \(n) steps done" } ?? "\(n) steps done"
    }
}
```
(Finish is the footer's Continue on this step — it closes the window, Task 12. Close/minimize buttons appear because `flow.windowMayClose` is true on `.done`.)

- [ ] **Step 2: `swift build`; commit**
```bash
git add rt-tray/Sources/Setup/Screens/DoneScreen.swift
git commit -m "MAT-383: Done screen — verify summary, where things live, Open the board / Invite teammates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 17: Settings window (⌘,) — General / Permissions / Team / Uninstall

**Files:**
- Create: `rt-tray/Sources-core/Settings/RemoteMasker.swift`, `rt-tray/Sources-core/Settings/TeamSettingsModel.swift`
- Create: `rt-tray/Sources/Settings/SettingsWindowController.swift`, `SettingsView.swift`, `GeneralPane.swift`, `PermissionsPane.swift`, `TeamPane.swift`, `UninstallPane.swift`
- Create: `rt-tray/Tests/MattstackCoreChecks/SettingsChecks.swift`; modify `AllChecks.swift`

**Interfaces:**
- Produces (Core): `public enum RemoteMasker { static func mask(_ remote: String) -> String }` (`git@gitlab.example.com:tools/team.git` → `gitlab.example.com/tools/team`; `https://github.com/o/r.git` → `github.com/o/r`; garbage → as-is); `public struct TeamSettingsInfo: Codable { name: String?; slug: String?; remote: String?; lastPush: String?; members: [Member]? }` with `Member { username: String }` (from `rt team status [--team <slug>] --json` → `{contract, slug, name, remote, lastPush, members:[{username}]}` — L1 T19 / contract); `@MainActor public final class TeamSettingsModel: ObservableObject` — `init(rt: RtRunning)`; `@Published info: TeamSettingsInfo?`, `invite: InviteResult?`, `error: String?`, `uninstallPlan: UninstallPlan?`; `func load() async`; `func mintInvite(handle: String) async`; `func loadUninstallPlan() async`; `func uninstall(keepData: Bool) -> AsyncThrowingStream<String, Error>`.
- Produces (app): `SettingsWindowController` (`show(pane:)`, remembers last pane in UserDefaults `MSSettingsPane`), `SettingsView` with `TabView` of the four panes, `enum SettingsPane: String { general, permissions, team, uninstall }`.

- [ ] **Step 1: Failing checks**

`rt-tray/Tests/MattstackCoreChecks/SettingsChecks.swift`:
```swift
import Foundation
import MattstackCore

let settingsChecks: [Check] = [
    Check("RemoteMasker shows host + repo only") { c in
        c.expectEqual(RemoteMasker.mask("git@gitlab.example.com:tools/mattstack-team.git"), "gitlab.example.com/tools/mattstack-team")
        c.expectEqual(RemoteMasker.mask("https://user:token@github.com/m4ttheweric/mattstack-home.git"), "github.com/m4ttheweric/mattstack-home")
        c.expectEqual(RemoteMasker.mask("ssh://git@github.com:22/o/r"), "github.com/o/r")
        c.expectEqual(RemoteMasker.mask("weird"), "weird")
    },
    Check("TeamSettingsModel loads status, mints invites through rt, loads the uninstall dry-run") { c in
        let rt = ScriptedRt()
        rt.answers["team status"] = (0, #"{"contract":1,"name":"Acme","slug":"acme","remote":"git@github.com:acme/mattstack-team-acme.git","lastPush":"2026-08-21T03:00:00Z","members":[{"username":"matt"},{"username":"bob"}]}"#)
        rt.answers["team invite --handle bob"] = (0, #"{"contract":1,"code":"ABCD","expiresAt":"2026-08-28T00:00:00Z","pasteBlock":"Install mattstack…","forgeAccess":"granted","manualSteps":[]}"#)
        rt.answers["uninstall --dry-run"] = (0, #"{"contract":1,"actions":[{"id":"services.unregister","title":"Stop services"}]}"#)
        let m = await MainActor.run { TeamSettingsModel(rt: rt) }
        await m.load()
        await MainActor.run {
            c.expectEqual(m.info?.name, "Acme")
            c.expectEqual(m.maskedRemote, "github.com/acme/mattstack-team-acme")
        }
        await m.mintInvite(handle: "bob")
        await MainActor.run { c.expectEqual(m.invite?.code, "ABCD") }
        c.expectEqual(rt.calls[1].args, ["team", "invite", "--handle", "bob", "--json"])
        await m.loadUninstallPlan()
        await MainActor.run { c.expectEqual(m.uninstallPlan?.actions.first?.id, "services.unregister") }
    },
]
```

- [ ] **Step 2: Run → compile failure. Implement Core**

`rt-tray/Sources-core/Settings/RemoteMasker.swift`:
```swift
import Foundation

/// Team pane shows where the repo is, never credentials or the full URL.
public enum RemoteMasker {
    public static func mask(_ remote: String) -> String {
        var s = remote.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }          // strip scheme
        if let at = s.lastIndex(of: "@") { s = String(s[s.index(after: at)...]) }    // strip user[:token]@
        // scp-like host:path → host/path ; host:port/path → host/path
        if let colon = s.firstIndex(of: ":") {
            let after = s[s.index(after: colon)...]
            let port = after.prefix { $0.isNumber }
            let rest = after.dropFirst(port.count)
            s = String(s[..<colon]) + (rest.hasPrefix("/") ? String(rest) : "/" + rest)
        }
        if s.hasSuffix(".git") { s.removeLast(4) }
        while s.hasSuffix("/") { s.removeLast() }
        return s.contains("/") ? s : remote
    }
}
```

`rt-tray/Sources-core/Settings/TeamSettingsModel.swift`:
```swift
import Foundation
import Combine

public struct TeamSettingsInfo: Codable, Equatable, Sendable {
    public struct Member: Codable, Equatable, Sendable { public var username: String }
    public var name: String?
    public var slug: String?
    public var remote: String?
    public var lastPush: String?
    public var members: [Member]?
}

@MainActor
public final class TeamSettingsModel: ObservableObject {
    @Published public private(set) var info: TeamSettingsInfo?
    @Published public private(set) var invite: InviteResult?
    @Published public private(set) var uninstallPlan: UninstallPlan?
    @Published public private(set) var error: String?
    private let rt: RtRunning
    public init(rt: RtRunning) { self.rt = rt }

    public var maskedRemote: String { info?.remote.map(RemoteMasker.mask) ?? "—" }

    public func load() async {
        do {
            let r = try await rt.run(["team", "status", "--json"], stdin: nil)
            if let e = r.userError { error = e.message; return }
            info = try r.decode(TeamSettingsInfo.self)
        } catch { self.error = String(describing: error) }
    }

    public func mintInvite(handle: String) async {
        do {
            let r = try await rt.run(["team", "invite", "--handle", handle, "--json"], stdin: nil)
            if let e = r.userError { error = e.message; return }
            invite = try r.decode(InviteResult.self)
        } catch { self.error = String(describing: error) }
    }

    public func loadUninstallPlan() async {
        do {
            let r = try await rt.run(["uninstall", "--dry-run", "--json"], stdin: nil)
            uninstallPlan = try r.decode(UninstallPlan.self)
        } catch { self.error = String(describing: error) }
    }

    /// `--yes`: the Uninstall pane's sheet is the confirmation; without it
    /// rt exits 2 `confirm-required` for `--delete-data` on a non-TTY.
    public func uninstall(keepData: Bool) -> AsyncThrowingStream<String, Error> {
        rt.stream(["uninstall", keepData ? "--keep-data" : "--delete-data", "--yes", "--json"], stdin: nil)
    }
}
```
Run checks → pass.

- [ ] **Step 3: Window + panes**

`rt-tray/Sources/Settings/SettingsWindowController.swift`:
```swift
import AppKit
import SwiftUI
import MattstackCore

enum SettingsPane: String, CaseIterable { case general, permissions, team, uninstall }

final class SettingsWindowController: NSWindowController {
    private static let paneKey = "MSSettingsPane"
    let pane = PaneSelection()
    final class PaneSelection: ObservableObject { @Published var current: SettingsPane = .general }

    init(env: SettingsEnvironment) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 440),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "mattstack Settings"
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
        pane.current = SettingsPane(rawValue: UserDefaults.standard.string(forKey: Self.paneKey) ?? "") ?? .general
        window.contentViewController = NSHostingController(rootView: SettingsView(pane: pane, env: env))
    }
    required init?(coder: NSCoder) { fatalError("not supported") }

    func show(pane p: SettingsPane? = nil) {
        if let p { pane.current = p }
        UserDefaults.standard.set(pane.current.rawValue, forKey: Self.paneKey)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

struct SettingsEnvironment {
    let rt: RtRunning
    let permissions: PermissionsService
    let readiness: ReadinessModel
    let updater: UpdaterController
    let team: TeamSettingsModel
    let isDevBuild: Bool
    let version: String
    let onJoinAnotherTeam: () -> Void
    let onQuitForUninstall: () -> Void
}
```

`rt-tray/Sources/Settings/SettingsView.swift`:
```swift
import SwiftUI
import MattstackCore

struct SettingsView: View {
    @ObservedObject var pane: SettingsWindowController.PaneSelection
    let env: SettingsEnvironment
    var body: some View {
        TabView(selection: $pane.current) {
            GeneralPane(env: env).tabItem { Label("General", systemImage: "gearshape") }.tag(SettingsPane.general)
            PermissionsPane(env: env).tabItem { Label("Permissions", systemImage: "lock.shield") }.tag(SettingsPane.permissions)
            TeamPane(env: env).tabItem { Label("Team", systemImage: "person.3") }.tag(SettingsPane.team)
            UninstallPane(env: env).tabItem { Label("Uninstall", systemImage: "trash") }.tag(SettingsPane.uninstall)
        }
        .frame(width: 560, height: 440)
        .onChange(of: pane.current) { _, p in UserDefaults.standard.set(p.rawValue, forKey: "MSSettingsPane") }
    }
}
```

`rt-tray/Sources/Settings/GeneralPane.swift`:
```swift
import SwiftUI
import ServiceManagement
import MattstackCore

struct GeneralPane: View {
    let env: SettingsEnvironment
    @State private var startAtLogin = SMAppService.mainApp.status == .enabled
    @State private var autoUpdates = false
    @State private var devModeBusy = false

    var body: some View {
        Form {
            Section("Startup") {
                Toggle("Start mattstack at login", isOn: $startAtLogin)
                    .onChange(of: startAtLogin) { _, on in toggleLogin(on) }
                    .accessibilityIdentifier(AXID.settingsGeneralStartAtLogin)
            }
            Section("Updates") {
                Toggle("Check for updates automatically", isOn: $autoUpdates)
                    .disabled(!env.updater.isEnabled)
                    .onChange(of: autoUpdates) { _, on in env.updater.automaticallyChecks = on }
                    .accessibilityIdentifier(AXID.settingsGeneralAutoUpdates)
                HStack {
                    Button("Check Now") { env.updater.checkForUpdatesFromMenu() }.disabled(!env.updater.canCheckForUpdates)
                        .accessibilityIdentifier(AXID.settingsGeneralCheckNow)
                    if !env.updater.isEnabled { Text(env.isDevBuild ? "Updates are off in the dev flavor." : "Updates are off in this build.").font(.caption).foregroundStyle(.secondary) }
                }
            }
            Section("Developer") {
                LabeledContent("Flavor") { Text(env.isDevBuild ? "dev (mattstack-dev.app)" : "prod (mattstack.app)") }
                Button(env.isDevBuild ? "Switch to the installed app (dev mode off)…" : "Switch to the dev app (dev mode on)…") {
                    devModeBusy = true
                    Task { _ = try? await env.rt.run(["settings", "dev-mode", env.isDevBuild ? "prod" : "dev"], stdin: nil); devModeBusy = false }
                }
                .disabled(devModeBusy)
                .accessibilityIdentifier(AXID.settingsGeneralDevMode)
                Text("The handoff quits this app and launches the other flavor.").font(.caption).foregroundStyle(.secondary)
                // `rt settings dev-mode <dev|prod>`: L1 T31 drops `requiresTTY` when the target is given, so the app can spawn it.
            }
            Section { LabeledContent("Version") { Text(env.version) } }
        }
        .formStyle(.grouped)
        .onAppear { autoUpdates = env.updater.automaticallyChecks }
    }

    private func toggleLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register(); LoginItemPreference.isOptedOut = false }
            else { try SMAppService.mainApp.unregister(); LoginItemPreference.isOptedOut = true }
        } catch { TrayLog.error("login item toggle failed", ["err": String(describing: error)]) }
        startAtLogin = SMAppService.mainApp.status == .enabled
    }
}
```

`rt-tray/Sources/Settings/PermissionsPane.swift`:
```swift
import SwiftUI
import MattstackCore

struct PermissionsPane: View {
    let env: SettingsEnvironment
    @State private var snapshot = PermissionSnapshot.unknown
    @State private var timer: Timer?
    @State private var resetting = false

    private var rows: [(String, String, String, Bool, String)] {  // id, title, why, required, settings target
        [(PermissionRowOverlay.fdaRow, "Full Disk Access", "Reads your repositories' git state so the daemon can show branch and MR status.", true, "fda"),
         (PermissionRowOverlay.loginItemsRow, "Background services", "rt daemon and deck run in the background as login items.", true, "login-items"),
         (PermissionRowOverlay.notificationsRow, "Notifications", "Pipeline and review alerts; works without this.", false, "notifications")]
    }

    var body: some View {
        Form {
            Section {
                ForEach(rows, id: \.0) { r in
                    let (status, detail) = PermissionRowOverlay.status(for: r.0, in: snapshot) ?? (.checking, "")
                    RowView(row: PlanRow(id: r.0, kind: .permission, title: r.1, why: r.2, required: r.3, status: status, detail: detail,
                                         action: RowAction(type: .openSettings, label: buttonLabel(r.0, status), target: r.4), recheck: .onActivate),
                            isChecking: false,
                            rowID: "settings.permissions.row.\(r.0)",
                            actionID: AXID.settingsPermissionAction(r.0),
                            statusID: "settings.permissions.row.\(r.0).status") { act(r.0, status, r.4) }
                }
            }
            Section {
                HStack {
                    Button(resetting ? "Resetting…" : "Reset & re-request…") { resetting = true; Task { _ = await env.permissions.resetAndReRequest(); resetting = false } }
                        .disabled(resetting)
                        .accessibilityIdentifier(AXID.settingsPermissionsReset)
                    Text("Clears this app's permission records (for a moved app or stale signature) and asks again.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { probe(); timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in probe() } }
        .onDisappear { timer?.invalidate(); timer = nil }
    }

    private func buttonLabel(_ id: String, _ status: RowStatus) -> String {
        switch (id, status) {
        case (PermissionRowOverlay.fdaRow, _): return "Open Full Disk Access Settings…"
        case (PermissionRowOverlay.loginItemsRow, _): return "Open Login Items…"
        case (PermissionRowOverlay.notificationsRow, .skipped): return "Allow"
        default: return "Open Notification Settings…"
        }
    }
    private func act(_ id: String, _ status: RowStatus, _ target: String) {
        if id == PermissionRowOverlay.notificationsRow, status == .skipped { Task { _ = await env.permissions.request("notifications"); probe() }; return }
        env.permissions.openSettings(target)
    }
    private func probe() { Task { snapshot = await env.permissions.snapshot() } }
}
```

`rt-tray/Sources/Settings/TeamPane.swift`:
```swift
import SwiftUI
import MattstackCore

struct TeamPane: View {
    let env: SettingsEnvironment
    @ObservedObject private var model: TeamSettingsModel
    @State private var handle = ""
    init(env: SettingsEnvironment) { self.env = env; self.model = env.team }

    var body: some View {
        Form {
            Section("Team") {
                LabeledContent("Name") { Text(model.info?.name ?? "—") }
                LabeledContent("Remote") {
                    HStack { Text(model.maskedRemote).textSelection(.enabled)
                        Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(model.info?.remote ?? "", forType: .string) } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.borderless) }
                }
                LabeledContent("Backup") { Text(model.info?.lastPush.map { "last push \($0)" } ?? "no push recorded") }
            }
            Section("Members with access") {
                if let m = model.info?.members, !m.isEmpty { ForEach(m, id: \.username) { Text($0.username) } }
                else { Text("Not visible with the current token.").foregroundStyle(.secondary) }
            }
            Section("Invite") {
                HStack {
                    TextField("Forge handle", text: $handle, prompt: Text("teammate's GitHub/GitLab handle")).accessibilityIdentifier(AXID.settingsTeamInviteHandle)
                    Button("Invite…") { Task { await model.mintInvite(handle: handle) } }.disabled(handle.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier(AXID.settingsTeamInvite)
                }
                if let inv = model.invite {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(inv.pasteBlock).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        HStack {
                            Button("Copy paste block") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(inv.pasteBlock, forType: .string) }
                                .accessibilityIdentifier(AXID.settingsTeamCopyPaste)
                            Text("expires \(inv.expiresAt) · forge access: \(inv.forgeAccess)").font(.caption).foregroundStyle(.secondary)
                        }
                        if let steps = inv.manualSteps, !steps.isEmpty { ForEach(steps, id: \.self) { Text("• \($0)").font(.caption) } }
                    }
                }
            }
            Section { Button("Join another team…", action: env.onJoinAnotherTeam).accessibilityIdentifier(AXID.settingsTeamJoinAnother) }
            if let e = model.error { Text(e).font(.caption).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
        .task { await model.load() }
    }
}
```

`rt-tray/Sources/Settings/UninstallPane.swift`:
```swift
import SwiftUI
import MattstackCore

struct UninstallPane: View {
    let env: SettingsEnvironment
    @ObservedObject private var model: TeamSettingsModel
    @State private var confirming = false
    @State private var keepData = true
    @State private var progress: [String] = []
    @State private var running = false
    init(env: SettingsEnvironment) { self.env = env; self.model = env.team }

    var body: some View {
        Form {
            Section("Uninstall mattstack") {
                Text("Reverses everything the installer did: services, the proxy, ~/.local/bin links and the shell rc block, the editor extension, the Claude Code plugins we added; then moves the app to the Trash.")
                    .font(.callout)
                Button("Uninstall mattstack…") { Task { await model.loadUninstallPlan(); confirming = true } }
                    .accessibilityIdentifier(AXID.settingsUninstall)
            }
            if !progress.isEmpty {
                Section("Progress") { ForEach(progress, id: \.self) { Text($0).font(.system(.caption, design: .monospaced)) } }
            }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $confirming) {
            VStack(alignment: .leading, spacing: 12) {
                Text("This will:").font(.headline)
                ForEach(model.uninstallPlan?.actions ?? []) { a in Label(a.title, systemImage: "minus.circle") }
                Toggle("Keep ~/.mattstack (your settings home repo and data)", isOn: $keepData).accessibilityIdentifier(AXID.settingsUninstallKeepData)
                HStack {
                    Spacer()
                    Button("Cancel") { confirming = false }.keyboardShortcut(.cancelAction)
                    Button("Uninstall", role: .destructive) { confirming = false; run() }.keyboardShortcut(.defaultAction).disabled(running)
                        .accessibilityIdentifier(AXID.settingsUninstallConfirm)
                }
            }
            .padding(20).frame(width: 460)
        }
    }

    private func run() {
        running = true
        progress = []
        Task {
            do {
                for try await line in model.uninstall(keepData: keepData) {
                    if let ev = try? ApplyEvent.decode(line) {
                        switch ev {
                        case .step(let id, let state, let detail, _): progress.append("\(id): \(state.rawValue)\(detail.map { " — \($0)" } ?? "")")
                        case .done(let ok, _): progress.append(ok ? "done — mattstack will quit now" : "stopped"); if ok { env.onQuitForUninstall() }
                        default: break
                        }
                    }
                }
            } catch { progress.append("error: \(error)") }
            running = false
        }
    }
}
```

- [ ] **Step 4: `swift build`; checks pass. Commit**
```bash
git add rt-tray/Sources-core rt-tray/Sources/Settings rt-tray/Tests
git commit -m "MAT-383: Settings window — General, Permissions (Reset & re-request), Team (Invite…), Uninstall

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 18: AppDelegate integration — launch guard, appPath, first-run, deep link, menu, routes, version-change

**Files:**
- Create: `rt-tray/Sources-core/Launch/LaunchGuard.swift`, `rt-tray/Sources/Rt/RtClientFactory.swift`, `rt-tray/Sources/Setup/SetupCoordinator.swift`
- Modify: `rt-tray/Sources/AppDelegate.swift`, `rt-tray/Sources/main.swift`, `rt-tray/Sources/TrayState.swift`, `rt-tray/Sources/ProcessPanelView.swift` (gear-menu additions only), `rt-tray/Sources/DaemonLifecycle.swift` + `rt-tray/Sources-daemon-shim/main.swift` (L4 T3's string/comment edits, carried here — `rt-tray/Sources/**` is L3's)
- Create: `rt-tray/Tests/MattstackCoreChecks/LaunchChecks.swift`; modify `AllChecks.swift`

**Interfaces:**
- Produces (Core):
  - `public enum LaunchGuard { static func isTranslocatedOrOnRemovableVolume(bundlePath: String) -> Bool }` — true for paths containing `/AppTranslocation/` or starting with `/Volumes/`
  - `public enum FirstRunDetector { static func needsSetup(home: String, fileExists: (String) -> Bool) -> Bool }` — `!fileExists("\(home)/.mattstack/rt/daemon.json")`
  - `public enum JoinLink { static func code(from url: URL) -> String? }` — `mattstack://join/<code>` (host `join`, one path component, trims whitespace, rejects others/empty)
  - `public enum AppPathSetting { static func arguments(bundlePath: String) -> [String] }` → `["settings", "set", "mattstack.appPath", "\"<path>\"", "--scope", "machine"]` (the value is a JSON string literal because `rt settings set` takes `<json-value>`)
- Produces (app):
  - `enum RtClientFactory { static func make() -> RtClient? }` (BundleFlavor + `#if DEBUG` + `RT_APP_SOCKET=TrayServer.socketPath`)
  - `final class SetupCoordinator` — owns `SetupWindowController`, `SettingsWindowController`, `ReadinessModel`, `InstallRunModel`, `TeamSettingsModel`; `func showSetup(step:joinCode:)`, `func showSettings(pane:)`, `func handleJoin(code:)` (setup incomplete → Setup screen 2 prefilled; complete → Settings → Team), `func openSetupStatus()` (screen 3 as health view: `ReadinessModel` over `rt setup status --json`).
  - AppDelegate: `applicationDidFinishLaunching` order = launch guard → build services (`PermissionsService`, `ServicesRegistrar`, `PrivilegedInstaller`, `NeedBroker`, `TrayRoutes` → `TrayServer.shared.routes`) → existing setup (menu bar, notifications, tray server, polling, updater) → `servicesRegistrar.registerAll()` (replaces `daemonLifecycle.startDaemon()` — the daemon plist is one of the N) → version-change handling → `mattstack.appPath` write → first-run detection → open Setup. URL handling via `NSAppleEventManager` `kAEGetURL` registered in `applicationWillFinishLaunching`. Main menu with App menu: "Settings…" ⌘, "Quit mattstack" ⌘Q (so ⌘, works whenever a window is key). Gear-menu additions in `ProcessPanelView.makeGearMenu()`: "Setup status…", "Settings…", "Uninstall mattstack…" posting `.rtShowSetupStatus`, `.rtShowSettings`, `.rtShowUninstall`; "Check for Updates…" title stays bound to `trayState.updateAvailable` and its enabled state to `updater.canCheckForUpdates` via `TrayState.canCheckForUpdates`.

- [ ] **Step 1: Failing checks**

`rt-tray/Tests/MattstackCoreChecks/LaunchChecks.swift`:
```swift
import Foundation
import MattstackCore

let launchChecks: [Check] = [
    Check("LaunchGuard flags translocated and volume paths") { c in
        c.expect(LaunchGuard.isTranslocatedOrOnRemovableVolume(bundlePath: "/private/var/folders/zz/T/AppTranslocation/ABC/d/mattstack.app"))
        c.expect(LaunchGuard.isTranslocatedOrOnRemovableVolume(bundlePath: "/Volumes/mattstack-2.8.0/mattstack.app"))
        c.expect(!LaunchGuard.isTranslocatedOrOnRemovableVolume(bundlePath: "/Applications/mattstack.app"))
        c.expect(!LaunchGuard.isTranslocatedOrOnRemovableVolume(bundlePath: "/Users/u/Applications/mattstack-dev.app"))
    },
    Check("FirstRunDetector keys off ~/.mattstack/rt/daemon.json") { c in
        c.expect(FirstRunDetector.needsSetup(home: "/Users/u") { _ in false })
        c.expect(!FirstRunDetector.needsSetup(home: "/Users/u") { $0 == "/Users/u/.mattstack/rt/daemon.json" })
    },
    Check("JoinLink parses mattstack://join/<code> only") { c in
        c.expectEqual(JoinLink.code(from: URL(string: "mattstack://join/ABCD-EFGH-IJKL")!), "ABCD-EFGH-IJKL")
        c.expectEqual(JoinLink.code(from: URL(string: "mattstack://join/ABCD-EFGH-IJKL/")!), "ABCD-EFGH-IJKL")
        c.expectEqual(JoinLink.code(from: URL(string: "mattstack://join/")!), nil)
        c.expectEqual(JoinLink.code(from: URL(string: "mattstack://settings/team")!), nil)
        c.expectEqual(JoinLink.code(from: URL(string: "https://mattstack.dev/join#ABCD")!), nil)
    },
    Check("AppPathSetting writes a JSON string through rt settings set --scope machine") { c in
        c.expectEqual(AppPathSetting.arguments(bundlePath: "/Applications/mattstack.app"),
                      ["settings", "set", "mattstack.appPath", "\"/Applications/mattstack.app\"", "--scope", "machine"])
        c.expectEqual(AppPathSetting.arguments(bundlePath: "/Users/u/My \"Apps\"/mattstack.app")[3], "\"/Users/u/My \\\"Apps\\\"/mattstack.app\"")
    },
]
```

- [ ] **Step 2: Run → compile failure. Implement Core**

`rt-tray/Sources-core/Launch/LaunchGuard.swift`:
```swift
import Foundation

public enum LaunchGuard {
    /// Gatekeeper runs a quarantined app from a random read-only mount; a
    /// DMG is a volume. Either way SMAppService and Sparkle cannot work.
    public static func isTranslocatedOrOnRemovableVolume(bundlePath: String) -> Bool {
        bundlePath.contains("/AppTranslocation/") || bundlePath.hasPrefix("/Volumes/")
    }
}

public enum FirstRunDetector {
    public static func needsSetup(home: String, fileExists: (String) -> Bool) -> Bool {
        !fileExists("\(home)/.mattstack/rt/daemon.json")
    }
}

public enum JoinLink {
    public static func code(from url: URL) -> String? {
        guard url.scheme?.lowercased() == "mattstack", url.host?.lowercased() == "join" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 1 else { return nil }
        let code = parts[0].trimmingCharacters(in: .whitespacesAndNewlines)
        return code.isEmpty ? nil : code
    }
}

public enum AppPathSetting {
    public static func arguments(bundlePath: String) -> [String] {
        let json = String(decoding: (try? JSONEncoder().encode(bundlePath)) ?? Data("\"\"".utf8), as: UTF8.self)
        return ["settings", "set", "mattstack.appPath", json, "--scope", "machine"]
    }
}
```
Run checks → pass.

- [ ] **Step 3: App wiring**

`rt-tray/Sources/Rt/RtClientFactory.swift`:
```swift
import Foundation
import MattstackCore

enum RtClientFactory {
    static func make() -> RtClient? {
        #if DEBUG
        let debug = true
        #else
        let debug = false
        #endif
        guard let loc = RtBinaryLocator.resolve(bundlePath: Bundle.main.bundlePath, isDevBuild: BundleFlavor.isDevBuild,
                                                isDebugBuild: debug, environment: ProcessInfo.processInfo.environment,
                                                home: NSHomeDirectory(), fileExists: { FileManager.default.isExecutableFile(atPath: $0) })
        else {
            TrayLog.error("no rt binary found for this bundle", ["bundle": Bundle.main.bundlePath])
            return nil
        }
        TrayLog.info("rt resolved", ["path": loc.executable.path, "source": String(describing: loc.source)])
        return RtClient(location: loc, environment: ["RT_APP_SOCKET": TrayServer.socketPath])
    }
}
```

`rt-tray/Sources/Setup/SetupCoordinator.swift`:
```swift
import AppKit
import MattstackCore

/// Owns the Setup and Settings windows and the models behind them. One
/// instance per process, created by AppDelegate after the services exist.
@MainActor
final class SetupCoordinator {
    private let rt: RtRunning
    private let permissions: PermissionsService
    private let needs: NeedBroker
    private let updater: UpdaterController
    private let readiness: ReadinessModel
    private let install: InstallRunModel
    private let teamSettings: TeamSettingsModel
    private var setupWindow: SetupWindowController?
    private var settingsWindow: SettingsWindowController?

    init(rt: RtRunning, permissions: PermissionsService, needs: NeedBroker, updater: UpdaterController) {
        self.rt = rt; self.permissions = permissions; self.needs = needs; self.updater = updater
        readiness = ReadinessModel(plans: RtPlanSource(rt: rt, verb: ["setup", "plan", "--json"]),
                                   permissions: permissions, ticker: MainTicker())
        install = InstallRunModel(stream: { from in
            var args = ["setup", "apply"]
            if let from { args += ["--from", from] }
            return rt.stream(args + ["--json"], stdin: nil)
        }, needs: needs)
        teamSettings = TeamSettingsModel(rt: rt)
    }

    var setupIsComplete: Bool {
        !FirstRunDetector.needsSetup(home: NSHomeDirectory()) { FileManager.default.fileExists(atPath: $0) }
    }

    func showSetup(step: SetupStep? = nil, joinCode: String? = nil) {
        if setupWindow == nil {
            let env = SetupEnvironment(rt: rt, readiness: readiness, install: install, permissions: permissions,
                                       isDevBuild: BundleFlavor.isDevBuild, bundleId: Bundle.main.bundleIdentifier ?? "com.mattstack.app",
                                       bundlePath: Bundle.main.bundlePath)
            setupWindow = SetupWindowController(environment: env)
        }
        setupWindow?.show(step: step, joinCode: joinCode)
    }

    /// "Setup status…": screen 3 as a health view over `rt setup status`.
    func openSetupStatus() {
        let status = ReadinessModel(plans: RtPlanSource(rt: rt, verb: ["setup", "status", "--json"]), permissions: permissions, ticker: MainTicker())
        let env = SetupEnvironment(rt: rt, readiness: status, install: install, permissions: permissions,
                                   isDevBuild: BundleFlavor.isDevBuild, bundleId: Bundle.main.bundleIdentifier ?? "com.mattstack.app",
                                   bundlePath: Bundle.main.bundlePath)
        let wc = SetupWindowController(environment: env)
        wc.flow.jump(to: .checklist)
        wc.flow.isInstalling = false
        wc.show(step: .checklist)
        wc.window?.styleMask.insert(.closable)
        wc.window?.title = "mattstack Setup status"
        setupWindow = wc
    }

    func showSettings(pane: SettingsPane? = nil) {
        if settingsWindow == nil {
            let env = SettingsEnvironment(rt: rt, permissions: permissions, readiness: readiness, updater: updater, team: teamSettings,
                                          isDevBuild: BundleFlavor.isDevBuild,
                                          version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
                                          onJoinAnotherTeam: { [weak self] in self?.showSetup(step: .team) },
                                          onQuitForUninstall: { NSApp.terminate(nil) })
            settingsWindow = SettingsWindowController(env: env)
        }
        settingsWindow?.show(pane: pane)
    }

    func handleJoin(code: String) {
        if setupIsComplete { showSettings(pane: .team); showSetup(step: .team, joinCode: code) }
        else { showSetup(step: .team, joinCode: code) }
    }
}

struct RtPlanSource: PlanSource {
    let rt: RtRunning
    let verb: [String]
    func fetchPlan() async throws -> Plan {
        let r = try await rt.run(verb, stdin: nil)
        if let e = r.userError { throw e }
        return try r.decode(Plan.self)
    }
}

/// Timer-backed ticker on the main run loop.
struct MainTicker: TickerScheduling {
    func schedule(every seconds: TimeInterval, _ tick: @escaping @Sendable () -> Void) -> TickerHandle {
        let timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: true) { _ in tick() }
        return TickerHandle { timer.invalidate() }
    }
}
```

`rt-tray/Sources/TrayState.swift` — add `@Published var canCheckForUpdates: Bool = false` and notification names:
```swift
    static let rtShowSetupStatus = Notification.Name("rtShowSetupStatus")
    static let rtShowSettings    = Notification.Name("rtShowSettings")
    static let rtShowUninstall   = Notification.Name("rtShowUninstall")
```

`rt-tray/Sources/ProcessPanelView.swift` `makeGearMenu()` — insert after the `View Logs…` separator:
```swift
        menu.addItem(ActionMenuItem("Setup status…") { NotificationCenter.default.post(name: .rtShowSetupStatus, object: nil) })
        menu.addItem(ActionMenuItem("Settings…") { NotificationCenter.default.post(name: .rtShowSettings, object: nil) })
        menu.addItem(.separator())
```
and before `Quit mattstack`:
```swift
        menu.addItem(ActionMenuItem("Uninstall mattstack…") { NotificationCenter.default.post(name: .rtShowUninstall, object: nil) })
        menu.addItem(.separator())
```
and make the update item reflect Sparkle: `let updateItem = ActionMenuItem(updateMenuTitle) { … }; updateItem.isEnabled = trayState.canCheckForUpdates || trayState.updateAvailable != nil; menu.addItem(updateItem)`. Nothing else in the panel changes.

`rt-tray/Sources/main.swift` — unchanged except the activation policy stays `.accessory`; the URL handler must be registered before the first event, so AppDelegate implements `applicationWillFinishLaunching`. **L4 `check-bundle.sh` source gates (keep verbatim):** the tray.sock single-instance guard stays *before* `let delegate = AppDelegate()` in `main.swift`; `BundleFlavor.swift` keeps `Bundle.main.object(forInfoDictionaryKey: "MSDaemonLabel")` and `static let defaultDaemonLabel = "com.mattstack.daemon"`; `TrayServer.swift` keeps the literal `path == "/flavor/retire"`.

**L4 T3's Swift edits (absorbed here — L4 T3 drops them):** `rt-tray/Sources/AppDelegate.swift:331` `Bundle.main.bundlePath + "/Contents/MacOS/rt-daemon"` → `"/Contents/MacOS/rt"` (the bundled binary is `rt` after L4's rename; Task 3's `RtBinaryLocator` already prefers it); `rt-tray/Sources/DaemonLifecycle.swift:8,17-18` doc comments `Contents/MacOS/rt-daemon` → `Contents/MacOS/rt`; `rt-tray/Sources-daemon-shim/main.swift:4,26` comments "dev bundle's `Contents/MacOS/rt-daemon`" → `Contents/MacOS/rt` and "`-i rt-daemon`" → "`-i rt`".

`rt-tray/Sources/AppDelegate.swift` changes:
```swift
    // properties
    private var permissionsService: PermissionsService!
    private var servicesRegistrar: ServicesRegistrar!
    private var needBroker: NeedBroker!
    private var coordinator: SetupCoordinator?
    private var rtClient: RtClient?
    let updater = UpdaterController(isDevBuild: BundleFlavor.isDevBuild, isBusy: { SetupSession.isRunning })
    private var updaterObservation: NSKeyValueObservation?

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleGetURL(_:with:)),
                                                     forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if LaunchGuard.isTranslocatedOrOnRemovableVolume(bundlePath: Bundle.main.bundlePath) {
            showMoveToApplicationsAlert()
            return
        }
        buildServices()
        installMainMenu()
        setupMenuBar()
        setupNotifications()
        setupTrayServer()
        startPolling()
        setupAutoUpdate()
        // …existing observers unchanged…
        NotificationCenter.default.addObserver(self, selector: #selector(showSetupStatus), name: .rtShowSetupStatus, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(showSettings), name: .rtShowSettings, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(showUninstall), name: .rtShowUninstall, object: nil)
        checkMissionControlConflict()
        autoRegisterLoginItem()

        Task { @MainActor in
            setHealth(.starting)
            servicesRegistrar.registerAll()
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
            let change = await servicesRegistrar.handleVersionChange(current: version, store: UserDefaults.standard)
            TrayLog.info("version change evaluated", ["change": String(describing: change)])
            await recordAppPath()
            for _ in 0..<8 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                if await daemonClient.isReachable() { break }
            }
            await refreshStatus()
            await drainPendingNotifications()
            if let coordinator, !coordinator.setupIsComplete { coordinator.showSetup() }
        }
    }

    private func buildServices() {
        permissionsService = PermissionsService(bundleId: Bundle.main.bundleIdentifier ?? "com.mattstack.app",
                                                agentStatuses: { [weak self] in self?.servicesRegistrar.smStatuses() ?? [] },
                                                runner: SystemCommandRunner())
        servicesRegistrar = ServicesRegistrar(bundlePath: Bundle.main.bundlePath, runner: SystemCommandRunner())
        let privileged = PrivilegedInstaller(bundlePath: Bundle.main.bundlePath, escalator: AuthorizationServicesEscalator())
        needBroker = NeedBroker(services: servicesRegistrar, privileged: privileged)
        TrayServer.shared.routes = TrayRoutes(permissions: permissionsService, services: servicesRegistrar, privileged: privileged,
                                              needs: needBroker, updater: updater, version: self)
        rtClient = RtClientFactory.make()
        if let rt = rtClient {
            coordinator = SetupCoordinator(rt: rt, permissions: permissionsService, needs: needBroker, updater: updater)
        }
        updaterObservation = updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { u, _ in
            DispatchQueue.main.async { TrayState.shared.canCheckForUpdates = u.canCheckForUpdates }
        }
    }

    /// V3: the machine store learns where this bundle lives, every launch.
    private func recordAppPath() async {
        guard let rt = rtClient else { return }
        let r = try? await rt.run(AppPathSetting.arguments(bundlePath: Bundle.main.bundlePath), stdin: nil)
        if let r, r.exitCode != 0 { TrayLog.warn("mattstack.appPath write failed", ["exit": Int(r.exitCode), "err": r.userError?.message ?? ""]) }
    }

    private func installMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Settings…", action: #selector(showSettings), keyEquivalent: ",")
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
        guard let code = JoinLink.code(from: url) else { TrayLog.warn("ignored URL", ["url": s]); return }
        Task { @MainActor in coordinator?.handleJoin(code: code) }
    }

    @objc private func showSetupStatus() { Task { @MainActor in coordinator?.openSetupStatus() } }
    @objc private func showSettings() { Task { @MainActor in coordinator?.showSettings() } }
    @objc private func showUninstall() { Task { @MainActor in coordinator?.showSettings(pane: .uninstall) } }
```
and `extension AppDelegate: VersionProviding { func versionInfo() -> VersionInfo { VersionInfo(version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev", build: (Bundle.main.infoDictionary?["CFBundleVersion"] as? String).flatMap(Int.init) ?? 0, flavor: BundleFlavor.isDevBuild ? "dev" : "prod", path: Bundle.main.bundlePath) } }` (`build` is the numeric CFBundleVersion L4 writes — `major*1e6+minor*1e3+patch`, e.g. `2008000` — never a string; a non-numeric or missing value reads as `0`).
Keep `daemonLifecycle` for the existing stop/restart/retire routes; `registerAll()` now covers its plist (idempotent). Remove the old `daemonLifecycle.startDaemon()` call in the launch task. Replace the Task 10 placeholder `isBusy: { false }` with `{ SetupSession.isRunning }` (shown above). Also handle `.rtShowSettingsTeam` (posted by the Done screen): `NotificationCenter.default.addObserver(forName: .rtShowSettingsTeam, …) { coordinator?.showSettings(pane: .team) }`.

- [ ] **Step 4: `swift build` → Build complete; `swift run mattstack-checks` → pass; `./build.sh dev` assembles. Commit**
```bash
git add rt-tray/Sources-core rt-tray/Sources rt-tray/Tests
git commit -m "MAT-383: AppDelegate integration — launch guard, appPath write, first-run setup, mattstack://join, menu, routes, version-change restart; rt-daemon → rt strings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
(`git add` also `rt-tray/Sources/DaemonLifecycle.swift rt-tray/Sources-daemon-shim/main.swift` for the L4 T3 string edits.)

---

### Task 19: XCUITest flows against the stub rt — **needs Xcode — blocked until installed** (code written now)

**Files:**
- Create: `rt-tray/Tests/mattstackUITests/SetupFlowUITests.swift`

**Interfaces:**
- Consumes: `AXID` names (Task 12), stub scenarios (Task 4). The test runner sets `RT_STUB_SCENARIO`, `RT_STUB_PATH` (absolute path to `Tests/stub-rt/stub.ts` derived from `#filePath`), `RT_STUB_STATE_DIR` (fresh temp dir per test), `HOME` (a temp dir, so `daemon.json` is absent → Setup opens and `~/.mattstack/rt/logs` is throwaway). The app under test is the Debug `mattstack` target, so the stub override is honoured.
- Scenarios (spec §12.2): `create-happy`, `join-happy`, `join-no-access`, `perm-denied-then-granted`, `apply-fail-retry`, `uninstall`.

- [ ] **Step 1: Write the tests** (AXID literals are repeated here as strings because the UI test bundle cannot import the app target's types; keep them in sync with `AccessibilityIDs.swift`)

```swift
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
        el("setup.welcome.continue").click()
        waitFor("setup.team.screen")
        el("setup.team.card.create").click()
        el("setup.team.create.name").click()
        el("setup.team.create.name").typeText("Acme Claims")
        XCTAssertTrue(app.staticTexts["acme-svc"].waitForExistence(timeout: 3))
        el("setup.team.create.remote").click()
        el("setup.team.create.remote").typeText("https://example.com/empty.git")
        el("setup.team.continue").click()
        waitFor("setup.checklist.screen")
    }

    func testJoinNoAccessShowsSpecificFailure() {
        launch("join-no-access")
        el("setup.welcome.continue").click()
        el("setup.team.card.join").click()
        el("setup.team.join.code").click()
        el("setup.team.join.code").typeText("ABCD")
        el("setup.team.continue").click()
        XCTAssertTrue(app.staticTexts["You don't have access yet: ask matt to grant you access to Acme."].waitForExistence(timeout: 10))
        XCTAssertFalse(el("setup.checklist.screen").exists)
    }

    func testPermissionDeniedThenGrantedEnablesInstall() {
        launch("perm-denied-then-granted")
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
        waitFor("settings.uninstall.button", 10)
        el("settings.uninstall.button").click()
        waitFor("settings.uninstall.confirm")
        XCTAssertTrue(app.staticTexts["Stop and remove the rt daemon and deck services"].exists)
    }
}
```
(The permission-row overlay in a UI test reads the real Mac's FDA state for the test host — the `perm-denied-then-granted` flow therefore asserts on the *Install button*, which the stub controls via its other required rows, not on the FDA glyph. The real FDA/Login Items dance is L7's VM walkthrough.)

- [ ] **Step 2: Commit the test source (cannot run here)**
```bash
git add rt-tray/Tests/mattstackUITests
git commit -m "MAT-383: XCUITest flows against the stub rt (create/join/no-access/perm/retry/uninstall) — runs once Xcode is installed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Record in the task report: "NOT RUN — needs Xcode (`xcodebuild test -scheme mattstack -only-testing:mattstackUITests`)". When Xcode lands: `xcodegen generate && xcodebuild test -scheme mattstack -destination 'platform=macOS'`.

---

### Task 20: Live-machine smoke — **ORCHESTRATOR-ONLY**

Not for implementer subagents. Matt's machine, dev flavor only, after Task 18 is merged into the worktree branch.

- [ ] `cd rt-tray && swift build && swift run mattstack-checks && bun test Tests/stub-rt && ./build.sh dev` — all green.
- [ ] Stub-driven run without touching real machine state. `RT_STUB_SCENARIO` is honoured only by DEBUG builds, and `build.sh dev` is a Release build, so run the debug binary directly (env passes through because it is not launched via `open`):
  `cd rt-tray && swift build && RT_STUB_SCENARIO=join-happy RT_STUB_PATH=$PWD/Tests/stub-rt/stub.ts RT_STUB_STATE_DIR=$(mktemp -d) HOME=$(mktemp -d) .build/debug/rt-tray` (foreground; ⌃C to stop; the second rpath makes Sparkle resolvable; unbundled SMAppService calls fail and log — expected). Walk the five screens; confirm the stub's plan renders, Install streams, `need` rows show "Waiting for you", the run finishes on Done.
- [ ] Real dev run (`~/.local/bin/rt` wrapper): `rt settings dev-mode dev` handoff as today, then confirm in the dev app: menu shows the new items; ⌘, opens Settings; Settings → Permissions rows match `rt setup status` (once L1 ships `setup status`; before that the pane still renders from the app's own probe); `GET /version` via `curl --unix-socket ~/.mattstack/rt/tray.sock http://x/version` shows `"flavor":"dev"` and the bundle path; `GET /permissions` shows the three statuses; `rt settings get mattstack.appPath --scope machine` (or `rt settings show`) reflects `~/Applications/mattstack-dev.app` (note: the dev bundle writes its own path — V3 says one key; confirm with the settings lane that dev writing it is acceptable or gate the write on `!isDevBuild` — Open questions).
- [ ] Real permissions: Settings → Permissions → Open Full Disk Access Settings… (the probe has already listed the dev app); toggle; row says relaunch; Reset & re-request runs `tccutil` for `com.mattstack.app.dev` only.
- [ ] `mattstack://join/TESTCODE` via `open "mattstack://join/TESTCODE"` → Setup opens on screen 2 with the code filled (setup incomplete on a temp HOME) or Settings → Team (complete).
- [ ] Version-change: bump `CFBundleShortVersionString` with PlistBuddy on the dev bundle, relaunch, tray log shows "app version changed; restarting agents" and `launchctl print gui/$UID/com.mattstack.daemon.dev` shows a fresh pid.

---

## Self-review checklist (run before handing the plan over)

**Spec coverage**
- §3 flow: first launch → Setup (Task 18 FirstRunDetector); re-entry "Setup status…" (Task 18 `openSetupStatus`), Settings ⌘, (Task 17/18), `mattstack://join` (Task 18 JoinLink + coordinator). ✔
- §4 window: 560 pt fixed, no close/minimize until done, Back/Continue bottom-right, Return = Continue, `.controlSize(.large)`, enum Step + push transitions, "Step n of 5", `Form(.grouped)`, status glyphs, ellipsis on System Settings buttons (Tasks 12, 14, 6 labels). ✔
- §4.1 Welcome copy (Task 12). ✔ §4.2 three cards incl. restore, slug preview, gh owner picker vs URL, explainer, join failure copy, code on stdin, ~77-char paste field (Task 13). ✔ §4.3 groups from rt, row anatomy, optional note, permission 1 s timer + didBecomeActive, Install gating, limited mode, Re-check (Tasks 5, 14). ✔ §4.4 live list, need handling, failure row + Show log + Retry-from (Tasks 11, 15). ✔ §4.5 Done (Task 16). ✔ §4.6 Settings four panes incl. Reset & re-request, Invite…, Join another team…, Uninstall sheet (Task 17). ✔
- §5.1 components all present; §5.3 routes all present incl. the 2026-08-21 contract update (GET /setup/need polling, `/version.path`) (Task 9). ✔
- §8 services: N plists, register every launch, `.requiresApproval` surfaced, version-change kickstart + `deck restart --managed`, plist PATH explicit (Tasks 2, 7). ✔
- §9 permissions table: probe paths, deep links, relaunch hint, tccutil reset, combined Login Items status (Tasks 5, 6). ✔
- §11 Sparkle keys, gentle reminders, idle install, dev off, feed override for L7, ATS local networking, translocation guard, appPath write (Tasks 2, 10, 18). ✔
- §12 stub rt + scenarios (Task 4), XCTest (harness + bridge, Task 1 onward), XCUITest (Task 19), dev flavor unchanged (Tasks 2, 3, 10). ✔
- Ruling 13: identities are read from Info.plist (BundleFlavor) and the LaunchAgents directory, never compiled in; macOS 14 floor in Package.swift + project.yml + Info.plist. ✔
- L7 requests: AXID file + convention (Task 12 and every view), appcast override + ATS (Tasks 2, 10), `/version.path` (Task 9). ✔

**Placeholder scan** — no "TBD/TODO"; the only "placeholder" words are `SUPublicEDKey`'s release-owned value (by design, gated by `UpdatePolicy`) and the Task 12 scaffolding stubs for Tasks 13–16, each replaced wholesale in its own task.

**Type consistency** — `RtRunning.run(_:stdin:)` / `.stream(_:stdin:)` used identically in Tasks 3, 13, 17, 18; `NeedBroker.perform(id:request:)`/`outcome(id:)` in Tasks 9, 11; `PermissionSnapshot` field names match the contract in Tasks 5, 6, 9; `ServicesProviding` signatures match between Task 7 and the Task 9 fakes; `UpdatePolicy.shouldStartUpdater` has the 4-argument form everywhere after the L7 amendment; `AXID` names in Task 19 strings equal the Task 12 definitions (`setup.<screen>.continue`, `setup.team.card.join`, `setup.checklist.row.perm.fda`, `setup.install.retry`, `setup.done.openBoard`, `settings.uninstall.button/confirm`).

**Known deliberate deviations from the brief**
- Unit tests are a CLT-runnable check harness + an XCTest bridge rather than XCTest-only (XCTest is not importable under CLT on this machine — verified). Same assertions, one source.
- `build.sh` gets the minimum Sparkle copy/sign + rendered-agents stopgap (Task 10) so a locally built bundle can launch; L4 still owns the xcodebuild rewrite.
- `UpdateChecker.swift` is deleted (superseded by Sparkle per ruling 7); `check-bundle.sh` gets a one-assertion update so it keeps passing.

## Open questions (for the orchestrator / L1 / L4 / settings lane)

1. **Need-event stdout race:** rt emits the `need` line then polls `GET /setup/need/<id>`; the app performs the step when it reads the line. If rt ever polls before flushing stdout, the app answers `pending` until the line arrives — fine, but L1 should flush the `need` line before the first poll so there's no 1 s wobble.
2. **Restore card inputs:** CLOSED (ruling R3, cross-plan review): the app runs the real `rt restore <org>/<repo> --json` (key on stdin `{"ageKey"}`) at Continue, then `rt setup intent restore <org>/<repo> --json`; L1's `home.restore` apply step only verifies (Task 13). `rt team create` / `rt team join --dry-run` at Continue leave the pending choice where `apply` finds it (L1 `setup intent`). Still pending on the settings lane: `rt restore --json` + key on stdin, and `--dry-run --json` if it ever ships.
3. **`rt setup github status --json` shape:** CLOSED — L1 T12 adds `handle` + `owners`; the contract lists them. gh-created repo is `rt team create <name> --create-repo <owner>` (L1 names it `mattstack-team-<slug>`); the `--remote gh:` spelling is gone (Task 13).
4. **`rt team status --json`:** CLOSED — L1 T19 adds it: `{contract, slug, name, remote, lastPush, members:[{username}]}` (Task 17).
5. **Proxy helper exit trailer:** `AuthorizationExecuteWithPrivileges` does not return the child's exit status; the plan has the helper print `MATTSTACK_EXIT=<n>` as its last stdout line. L4/L5 must honour that (or the app falls back to the `osascript … with administrator privileges` path noted in Task 8).
6. **Agent plist PATH:** CLOSED (ruling R2): the templates ship the static `/usr/bin:/bin:/usr/sbin:/sbin`; rt and deck prepend `<bundleRoot>/Contents/Helpers` (from their own execPath) and `$HOME/.local/bin` at process start; no plist hardcodes `/Applications/…`; L4's `check-bundle.sh` asserts the static value (Task 2).
7. **Dev flavor writing `mattstack.appPath`:** V3 says the app records its path at launch; with two flavors on one Mac the key holds whichever launched last. rt's `installedTrayAppPath(bundle:)` already guards on basename, so this is safe, but confirm the settings lane is fine with the dev bundle writing it (else gate on `!isDevBuild`).
8. **Sparkle under CLT:** `swift build` fetching the Sparkle xcframework via SPM without Xcode is expected to work (binaryTarget + ld64 from CLT) but was not exercised before the plan was written; Task 10 says stop and report if it does not.
9. **rpath for the unbundled debug binary:** the second rpath in Package.swift targets `.build/<triple>/debug/../../artifacts/...`; if `swift run` of the app still can't load Sparkle, set `DYLD_FRAMEWORK_PATH` for that run — cosmetic, the bundle is the real target.
10. **`KeepAlive` in prod:** CLOSED — L4 T3/T4 adopt `{SuccessfulExit:false}` for both flavors (render script + check-bundle); Task 10's stopgap is deleted by L4 T4's rewrite.
11. **`rt settings dev-mode` from Settings → General:** the button spawns `rt settings dev-mode <dev|prod>` (L1 T31 drops `requiresTTY` when the target is given); the handoff quits this app (expected). Confirm that's acceptable UX or hide the button behind the dev flavor only.
12. **Uninstall on the dev flavor / self-trash:** `rt uninstall` trashes the app; from the dev bundle that would trash `mattstack-dev.app` — the plan shows the same pane in both flavors; consider disabling in dev.
13. **XCUITest needs Xcode; `swift test` needs Xcode:** both gates stay red on this machine until Xcode 26 is installed; `swift run mattstack-checks` is the only automated gate today and is green by construction of Tasks 1–18.
14. **`PermissionsService.combinedLoginItems` with zero agents:** reports `notRegistered`; in a bundle missing its LaunchAgents dir the row will honestly say "Not registered" — but `ServicesRegistrar.registerAll()` will have registered nothing. CLOSED on the L4 side: L4 T4 bundles both plists via `scripts/render-launchagents.sh` (Task 2 is the source); L1 requests the deck plist only when deck is bundled, and a missing `BundleProgram` reports `notFound` honestly (Task 7).
15. **Sparkle feed/interval and `CFBundleURLName`:** CLOSED — `SUFeedURL` is the GitHub Release asset `https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml` (ruling R1), `SUScheduledCheckInterval` 21600, `CFBundleURLName` `@@BUNDLE_ID@@.join`; L4's build.sh `Set`s the `SU*` keys (Task 2).
