# MAT-383 L3 — mattstack.app shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `rt-tray` into the mattstack.app installer shell: an xcodegen project beside a still-valid `Package.swift`, a testable `MattstackCore` module (contract models, readiness/install models, permission and service logic, tray.sock routes), the five-screen Setup window, the Settings window, Sparkle, SMAppService for N agents, the admin-prompt proxy step, the `mattstack://join` link, the new tray.sock routes, and a stub `rt` that carries the L1 contract for tests.

**Architecture:** Thin native shell over rt verbs (ruling 5). Everything that can be reasoned about without a window lives in a SwiftPM library target `MattstackCore` (`rt-tray/Sources-core/`, Foundation + Combine only) and is exercised by a CLT-runnable check harness; the AppKit/SwiftUI shell (`rt-tray/Sources/`) binds those models to windows, `NSWorkspace`, `SMAppService`, `UNUserNotificationCenter`, AuthorizationServices and Sparkle. The app never parses a store file and never invents a checklist row: it spawns the bundled `rt` by absolute path with `--json`, renders what comes back, and answers rt's callbacks on `tray.sock`.

**Tech Stack:** Swift 5 language mode on the Swift 6.3.1 toolchain (tools-version 5.9), AppKit lifecycle + SwiftUI views, SwiftPM (CLT-buildable) + xcodegen `project.yml` (Xcode-buildable), Sparkle 2.9.6 via SPM, ServiceManagement (`SMAppService`), UserNotifications, AuthorizationServices, Bun for the stub rt.

**Spec:** `docs/superpowers/specs/2026-08-20-mattstack-app-installer-design.md` (§2 rulings 5/6/7/9/10/12/13/15, V2/V3; §3; §4 all screens; §5.1/5.3; §8; §9; §11; §12) and `docs/superpowers/specs/2026-08-21-rt-setup-contract.md` (the JSON + tray.sock routes this plan renders and serves). Research: `docs/superpowers/specs/research/2026-08-20-mattstack-app/research-onboarding-permissions-ux.md`, `research-sparkle-install-launchd.md`, `research-local-inventory.md`. On conflict the spec wins, then the contract.

**Worktree for execution:** `/Users/matt/Documents/GitHub/repo-tools-l3-wt`, branch `goodwinmattheweric/mat-383-app-shell` off `origin/main`. Main checkout `/Users/matt/Documents/GitHub/repo-tools` is read-only reference. Every path below is relative to the worktree root unless absolute.

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
  build.sh                            modified (stopgap only): copy + sign Sparkle.framework so a local bundle launches
  check-bundle.sh                     modified: the UpdateChecker dev-silence grep now points at UpdaterController
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

- [ ] **Step 2: Copy the spec + contract into the worktree if `docs/superpowers/specs/2026-08-20-mattstack-app-installer-design.md` / `2026-08-21-rt-setup-contract.md` are absent there** (they live on the `docs/mattstack-app-installer-spec` branch in `repo-tools-appspec-wt`): `cp` both files and the `research/2026-08-20-mattstack-app/` directory into the worktree's `docs/superpowers/specs/`, commit `MAT-383: carry the installer spec + rt setup contract into the L3 branch`.

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
            XCTFail("\(f.check): \(f.message)", file: StaticString(stringLiteral: f.file), line: UInt(f.line))
        }
        XCTAssertGreaterThan(report.passed, 0)
    }
}
```
(`StaticString(stringLiteral:)` on a runtime string is not allowed; use the simpler `XCTFail("\(f.check) [\(f.file):\(f.line)]: \(f.message)")` instead — the location travels in the message.)

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
- Produces: two app targets `mattstack` / `mattstack-dev` with Info.plist keys `MSDaemonLabel`, `MSDevBuild`, `CFBundleURLTypes` (`mattstack`), `LSMinimumSystemVersion 14.0`, `SUFeedURL`, `SUPublicEDKey`, `SUEnableAutomaticChecks`, `SUAutomaticallyUpdate`, `SUVerifyUpdateBeforeExtraction`, `SUScheduledCheckInterval`; LaunchAgent files `com.mattstack.daemon[.dev].plist` + `com.mattstack.deck[.dev].plist` under `Contents/Library/LaunchAgents` (ServicesRegistrar enumerates that directory, Task 7).

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

`rt-tray/LaunchAgent.plist` — add, after `ThrottleInterval`, an explicit PATH (spec §8: "explicit EnvironmentVariables.PATH … nothing is captured from the user's shell") and keep the rest as is. Insert:
```xml
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>@@HELPERS_PATH_PLACEHOLDER@@</string>
    </dict>
```
Because launchd does not expand variables in `EnvironmentVariables`, the bundle's absolute Helpers path cannot be known at template time. Use the bundle-relative trick launchd does support for `BundleProgram` only; for PATH, the honest value today is the fixed system path plus `~/.local/bin` resolved per user at render time by the **app** (Task 7's `ServicesRegistrar` does not rewrite plists — SMAppService reads them verbatim from the bundle). So set it to a fixed string the programs can extend themselves:
```xml
        <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
```
and note in Open questions that L4/L5 decide whether rt/deck add `<app>/Contents/Helpers` to their own PATH at startup (they know their own bundle). Replace the placeholder with that fixed string.

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
    <string>https://m4ttstack.github.io/rt/appcast.xml</string>
    <key>SUPublicEDKey</key>
    <string>REPLACE_WITH_RELEASE_PUBLIC_ED_KEY</string>
    <key>SUEnableAutomaticChecks</key>
    <true/>
    <key>SUAutomaticallyUpdate</key>
    <true/>
    <key>SUVerifyUpdateBeforeExtraction</key>
    <true/>
    <key>SUScheduledCheckInterval</key>
    <integer>86400</integer>
```
(`SUPublicEDKey` is a placeholder by design — L4's release job owns the real key; `UpdatePolicy` in Task 10 refuses to start Sparkle while the placeholder is present, so a local build never phones a feed it cannot verify.)

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
        SUFeedURL: https://m4ttstack.github.io/rt/appcast.xml
        SUPublicEDKey: REPLACE_WITH_RELEASE_PUBLIC_ED_KEY
        SUEnableAutomaticChecks: true
        SUAutomaticallyUpdate: true
        SUVerifyUpdateBeforeExtraction: true
        SUScheduledCheckInterval: 86400

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
    public var build: String
    public var flavor: String   // prod | dev
    public var path: String
    public init(version: String, build: String, flavor: String, path: String) {
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
- Produces: `bun rt-tray/Tests/stub-rt/stub.ts <rt args…>` honouring `RT_STUB_SCENARIO` ∈ `create-happy | join-happy | join-no-access | perm-denied-then-granted | apply-fail-retry | restore | uninstall`, `RT_STUB_STATE_DIR` (default `rt-tray/Tests/stub-rt/.state/<scenario>`) for cross-invocation state, `RT_APP_SOCKET` (read, never required). Verbs: `setup plan`, `setup status`, `setup apply [--from id]`, `setup <integration> status|connect`, `team create`, `team join [--dry-run]`, `team invite`, `uninstall [--dry-run]`, `settings set`, `restore`, `home init`, `version`. Exit codes per contract. Used by Task 19's XCUITests and by hand with the dev app.

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

test("team join --dry-run reads the code from stdin; no-access is exit 2 with a specific message", async () => {
  const happy = await run("join-happy", ["team", "join", "--dry-run", "--json"], JSON.stringify({ code: "ABCD-EFGH" }));
  expect(happy.code).toBe(0);
  expect(happy.lines[0].access).toBe("ok");
  expect(happy.lines[0].team.name).toBe("Acme");
  const denied = await run("join-no-access", ["team", "join", "--dry-run", "--json"], JSON.stringify({ code: "ABCD-EFGH" }));
  expect(denied.code).toBe(2);
  expect(denied.lines[0].error.code).toBe("no-access");
  expect(denied.lines[0].error.message).toContain("ask");
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

test("uninstall --dry-run lists actions; version answers", async () => {
  const dry = await run("uninstall", ["uninstall", "--dry-run", "--json"]);
  expect(dry.lines[0].actions.length).toBeGreaterThan(3);
  const v = await run("join-happy", ["version", "--json"]);
  expect(v.lines[0].version).toBeDefined();
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
    row("perm.loginItems", "permission", "Background services",
        "rt daemon and deck run in the background as login items.", true, "ready", "Enabled", null, "on-activate"),
    row("perm.notifications", "permission", "Notifications", "Pipeline and review alerts.", false, "skipped", "Not decided",
        { type: "request-permission", label: "Allow", which: "notifications" }, "on-activate",
        "Works without this; you'll see menu-bar badges instead."),
    row("tool.clt", "tool", "Apple command line tools", "git and python3 come from here.", true, "ready", "git 2.50.1", null),
    row("info.path", "info", "~/.local/bin first on PATH", "Install adds one PATH line to your shell rc.", true, "ready", "Fixed by Install", null),
  ];
  const accounts = [
    row("account.gitlab", "account", "GitLab", "The team's merge requests live on gitlab.example.com.", true,
        stateGet("gitlab-connected") ? "ready" : "missing", stateGet("gitlab-connected") ? "token can see group acme" : null,
        { type: "connect", label: "Connect", integration: "gitlab",
          fields: [{ name: "token", label: "Personal access token", secret: true, hint: "scopes: read_api, read_user" }],
          alternatives: [] }),
  ];
  const access = [row("access.teamRepo", "access", "Team repo reachable", "github.com/acme/mattstack-team-acme", true, "ready", "ls-remote ok", null)];
  const tools = [
    row("tool.herdr", "tool", "herdr", "Runs the agents that do the work.", true, "ready", "0.9.2", null),
    row("tool.fastbrowser", "tool", "Fast Browser", "Browser automation for evidence.", true, "needs-you", "extension not loaded",
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
  if (!body.code) fail("no-code", "Paste an invite code.");
  if (scenario === "join-no-access") fail("no-access", "You don't have access yet: ask matt to grant you access to Acme.");
  emit({ team: { slug: "acme", name: "Acme", owner: "matt" }, access: "ok", peering: "idle", message: "Joining Acme (owner matt)" });
}
else if (a0 === "team" && a1 === "invite") emit({ code: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567", expiresAt: "2026-08-28T00:00:00Z",
  pasteBlock: "Install mattstack from https://github.com/m4ttstack/rt/releases, then open mattstack://join/ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567 or paste the code into Setup → Join a team.",
  forgeAccess: "granted", manualSteps: [] });
else if (a0 === "uninstall" && args.includes("--dry-run")) emit({ actions: [
  { id: "services.unregister", title: "Stop and remove the rt daemon and deck services" },
  { id: "deck.managed", title: "Remove board and gitq from deck" },
  { id: "proxy.remove", title: "Remove the local HTTPS proxy (admin prompt)" },
  { id: "path.unlink", title: "Remove ~/.local/bin links and the shell rc block" },
  { id: "plugins.remove", title: "Uninstall the mattstack plugins from Claude Code" },
  { id: "app.trash", title: "Move mattstack.app to the Trash" } ] });
else if (a0 === "uninstall") { for (const id of ["services.unregister", "path.unlink", "app.trash"]) {
  process.stdout.write(JSON.stringify({ event: "step", id, state: "running" }) + "\n");
  process.stdout.write(JSON.stringify({ event: "step", id, state: "done" }) + "\n"); }
  process.stdout.write(JSON.stringify({ event: "done", ok: true }) + "\n"); }
else if (a0 === "settings" && a1 === "set") emit({ ok: true, key: a2 });
else if (a0 === "restore") emit({ ok: true, repo: a1 });
else if (a0 === "home" && a1 === "init") emit({ ok: true });
else if (a0 === "version" || a0 === "--version") emit({ version: "2.8.0-stub", build: "0" });
else fail("unknown-verb", `stub has no answer for: ${args.join(" ")}`);
```

- [ ] **Step 4: Run** `cd rt-tray && bun test Tests/stub-rt/` → 5 pass. Also `RT_STUB_SCENARIO=join-happy bun Tests/stub-rt/stub.ts setup plan --json | head -c 200`.

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
  - `public protocol TickerScheduling: Sendable { func schedule(every seconds: TimeInterval, _ tick: @escaping @Sendable () -> Void) -> TickerHandle }`, `public final class TickerHandle { public let cancel: () -> Void }`
  - `public struct PermissionSnapshot: Codable, Equatable, Sendable { fda: FDAState; notifications: NotificationsState; loginItems: LoginItemsState }` with nested `status` strings per contract, `PermissionSnapshot.unknown`
  - `public enum PermissionRowOverlay { static func status(for rowId: String, in snapshot: PermissionSnapshot) -> (RowStatus, String)? }` — rows `perm.fda`, `perm.loginItems`, `perm.notifications`
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
        await MainActor.run {
            let m = ReadinessModel(plans: FakePlans([makePlan()]), permissions: FakePermissions(), ticker: FakeTicker())
            Task { await m.load() }
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        // re-create synchronously for assertions
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
        c.expectEqual(PermissionRowOverlay.status(for: "perm.loginItems", in: s)?.0, .missing)
        let u = PermissionSnapshot.unknown
        c.expectEqual(PermissionRowOverlay.status(for: "perm.fda", in: u)?.0, .checking)
        c.expect(PermissionRowOverlay.status(for: "tool.clt", in: s) == nil)
        let ok = PermissionSnapshot(fda: .init(status: "granted", detail: ""), notifications: .init(status: "provisional"),
                                    loginItems: .init(status: "enabled"))
        c.expectEqual(PermissionRowOverlay.status(for: "perm.loginItems", in: ok)?.0, .ready)
        c.expectEqual(PermissionRowOverlay.status(for: "perm.notifications", in: ok)?.0, .ready)
        let approval = PermissionSnapshot(fda: .init(status: "granted", detail: ""), notifications: .init(status: "notDetermined"),
                                          loginItems: .init(status: "requiresApproval"))
        c.expectEqual(PermissionRowOverlay.status(for: "perm.loginItems", in: approval)?.0, .needsYou)
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
    public static let loginItemsRow = "perm.loginItems"
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

- [ ] **Step 4: Run** `swift run mattstack-checks` → all pass (`checks: 18 passed`). The first check's stray `Task { await m.load() }` block is redundant — delete those four lines once the rest passes (keep the synchronous re-create).

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
- Produces (app): `final class PermissionsService: PermissionProbing, PermissionsProviding` — `init(bundleId: String, agentStatuses: @escaping () -> [String], runner: CommandRunner)`; `func snapshot() async -> PermissionSnapshot`; `func request(_ which: String) async -> Bool` (`"notifications"` → `requestAuthorization`; anything else → false); `func openSettings(_ target: String)` (`fda`/`login-items`/`notifications`/`keyboard`); `func resetAndReRequest() async -> Bool` (tccutil via runner, then `request("notifications")` and a relaunch hint); `var fdaNeedsRelaunch: Bool` (true once a probe flipped denied→granted in this process — macOS applies FDA at next launch).

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
        c.expectEqual(exe, "/usr/bin/tccutil")
        c.expectEqual(args, ["reset", "All", "com.mattstack.app.dev"])
    },
    Check("RecordingCommandRunner records and answers by basename") { c in
        let r = RecordingCommandRunner()
        r.responses["tccutil"] = CommandOutcome(exitCode: 0, stdout: "", stderr: "")
        let out = await r.run("/usr/bin/tccutil", ["reset", "All", "x"])
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
  - `public protocol ServicesProviding: Sendable { func statuses() async -> [ServiceStatusEntry]; func register(plists: [String]) async -> [ServiceRegisterResult]; func restart(label: String) async -> Bool }`
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
        c.expectEqual(exe, "/bin/launchctl")
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
(The ServicesChecks above reference `/bin/launchctl` only through `Kickstart.arguments`' *output* compared as a string — that literal appears in the check file, so write the expectation as `c.expectEqual((exe as NSString).lastPathComponent, "launchctl")` and `c.expect(exe.hasPrefix("/bin/"))` instead. Same for the `tccutil` expectation in Task 6's PermissionsChecks: compare `lastPathComponent == "tcc" + "util"` is silly — compare `exe.hasSuffix("util")` and `args == ["reset","All",bundleId]`. Update both files accordingly so the guard passes.)

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
    func restart(label: String) async -> Bool
}
```

- [ ] **Step 4: Run checks → pass** (after the literal-avoidance edits described in Step 1).

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
- Produces (Core): `public struct NeedResult: Codable, Equatable { ok: Bool; detail: String }`; `public protocol PrivilegedInstalling: Sendable { func proxyInstall() async -> NeedResult }`; `public enum ProxyHelper { static let relativePath = "Contents/Helpers/mattstack-proxy-install"; static func path(bundlePath:) -> String; static let promptText = "mattstack needs administrator access once to install the local HTTPS proxy (portless) for the board and deck." }`; `public protocol PrivilegeEscalator: Sendable { func runAsAdmin(executable: String, args: [String], prompt: String) async -> CommandOutcome }`
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

    func proxyInstall() async -> NeedResult {
        let helper = ProxyHelper.path(bundlePath: bundlePath)
        guard fileExists(helper) else {
            return NeedResult(ok: false, detail: "proxy-install helper is not bundled at \(ProxyHelper.relativePath)")
        }
        let out = await escalator.runAsAdmin(executable: helper, args: ["install"], prompt: ProxyHelper.promptText)
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
(The helper's `MATTSTACK_EXIT=` trailer is a contract L4/L5 must honour; record it in Open questions. If the compiler rejects the pointer gymnastics, fall back to `osascript -e 'do shell script … with administrator privileges'` through `CommandRunner` — same prompt, same one-time ask — and note the swap in the report.)

- [ ] **Step 4: `swift build`; checks pass. Commit**
```bash
git add rt-tray/Sources-core rt-tray/Sources/Services rt-tray/Tests
git commit -m "MAT-383: PrivilegedInstaller — one admin prompt for the bundled proxy-install helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
