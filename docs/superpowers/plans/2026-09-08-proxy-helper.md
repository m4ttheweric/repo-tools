# Privileged Proxy Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `Contents/Helpers/mattstack-proxy-install` so `proxy.install` installs the bundled portless as a root LaunchDaemon on 443 with one admin prompt, and stops skipping.

**Architecture:** portless (third-party npm tarball) is pinned into the bundle via deps.lock; a first-party Swift helper (built in rt-tray's build like rt-ui) copies the verified portless+node out of the bundle to a root-owned home, writes the LaunchDaemon/sudoers/CA-trust, and reports over the stdout-only `MATTSTACK_EXIT` contract the app already parses. TS-side, the skip gate re-points at first-party resolution and the validator compares deployed vs pinned versions.

**Tech Stack:** SwiftPM executable (macOS 14 floor), bash (build.sh/check-bundle.sh), Bun/TypeScript (lib/setup), launchd, sudoers, security(1).

**Spec:** docs/superpowers/specs/2026-09-08-proxy-helper-design.md

## Global Constraints

- Root never runs unpinned registry code: the helper refuses a copy source whose tree hash mismatches sha256s compiled in at build time.
- Steady state per the deck-lane contract: label `sh.portless.proxy`, port 443, state at the console user's `~/.portless` via `PORTLESS_STATE_DIR`; the sudoers NOPASSWD kickstart rule survives.
- Helper output contract: stdout only; every exit path ends with `MATTSTACK_EXIT=<n>`; a missing trailer parses as success, so the trailer is non-optional.
- The only unprivileged flag is `--version`; no paths from argv.
- Sudoers principal: exactly the console user via `SCDynamicStoreCopyConsoleUser`, never `%admin`.
- Never rebuild or re-sign a blessed bundle; all bundle builds go to scratch (repo CLAUDE.md).
- The compiled rt binary is only ever run under an isolated HOME.
- No em dashes in any authored text. Clean-code comments only.
- `bun run test:all` (not `bun run test`) is the TS gate; plus tsc, docs:check, picker:check, repo-purity.

---

### Task 1: Pin portless into deps.lock, drop the pending helper row

**Files:**
- Modify: `rt-tray/deps.lock` (rows `mattstack-proxy-install` at ~line 70; add `portless` after `cloudflared`)
- Modify: `rt-tray/check-bundle.sh` (the `node|fast-browser` directory-skip case, ~line 341)
- Modify: `lib/__tests__/deps-lock-live.test.ts`
- Test: `lib/__tests__/deps-lock-live.test.ts`

**Interfaces:**
- Produces: deps.lock row `portless` (kind `helper`, `archive: "npm"`, `extract: "package"`, `bundlePath: "Contents/Helpers/portless-dist"`, `exec: ["Contents/Helpers/node/bin/node", "Contents/Helpers/portless-dist/dist/cli.js"]`, `exposeByDefault: false`, `entitlements: "none"`, `status: "bundled"`); the check-bundle smoke's directory-skip case gains `portless`; NO `mattstack-proxy-install` row (first-party from Task 2 on).

- [ ] **Step 1: Write the failing test** — in `deps-lock-live.test.ts`, add to the live-lock describe:

```ts
test("portless is pinned and the helper row is first-party (absent)", () => {
  const portless = lock.tools.find((t) => t.name === "portless");
  expect(portless?.status).toBe("bundled");
  expect(portless?.url).toMatch(/^https:\/\/registry\.npmjs\.org\/portless\/-\/portless-\d+\.\d+\.\d+\.tgz$/);
  expect(portless?.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(portless?.bundlePath).toBe("Contents/Helpers/portless-dist");
  expect(portless?.exec).toEqual(["Contents/Helpers/node/bin/node", "Contents/Helpers/portless-dist/dist/cli.js"]);
  expect(lock.tools.find((t) => t.name === "mattstack-proxy-install")).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test lib/__tests__/deps-lock-live.test.ts` → FAIL (portless undefined).
- [ ] **Step 3: Pin the row.** Compute the pin (0.15.6 at spec time; use the current latest):

```bash
curl -fsSL -o /tmp/portless.tgz "https://registry.npmjs.org/portless/-/portless-0.15.6.tgz"
shasum -a 256 /tmp/portless.tgz
```

Edit deps.lock: delete the `mattstack-proxy-install` row; add (matching the file's compact row style):

```json
{ "name": "portless", "version": "0.15.6", "license": "MIT",
  "url": "https://registry.npmjs.org/portless/-/portless-0.15.6.tgz",
  "sha256": "<the shasum from above>",
  "archive": "npm", "extract": "package", "bundlePath": "Contents/Helpers/portless-dist", "exec": ["Contents/Helpers/node/bin/node", "Contents/Helpers/portless-dist/dist/cli.js"],
  "exposeByDefault": false, "entitlements": "none", "status": "bundled", "kind": "helper" },
```

The `exec` shape is forced by the schema: `parseDepsLock` rejects an empty
`exec` (bundle-layout.ts:112) and every entry must be a `Contents/Helpers/`
path, no flags (bundle-layout.ts:118; fast-browser precedent) — so the argv
prefix is the bundled node's real binary (`Contents/Helpers/node/bin/node`,
a directory row's inner bin) running portless's `dist/cli.js` (its
package.json `bin`; zero runtime deps, verified). `archive: "npm"` matches
the fast-browser registry-tarball precedent (fetch-deps treats it like
tar.gz).

Also in this task, `rt-tray/check-bundle.sh:341-352`'s per-row smoke runs
`$bundlePath --version` and skips directory helpers via a hardcoded
`node|fast-browser` case — add `portless` to that case in the same commit,
or any intermediate check-bundle run fails on the directory bundlePath.
- [ ] **Step 4: Run** `bun test lib/__tests__/deps-lock-live.test.ts lib/__tests__/bundle-layout.test.ts lib/__tests__/deps-lock-file.test.ts` → PASS; then `bash scripts/fetch-deps.sh` → portless downloads, verifies, unpacks.
- [ ] **Step 5: Commit** — `git add rt-tray/deps.lock rt-tray/check-bundle.sh lib/__tests__/deps-lock-live.test.ts && git commit -m "deps.lock: pin portless, retire the pending helper row"`.

### Task 2: Helper skeleton with the MATTSTACK_EXIT contract and --version

**Files:**
- Create: `rt-tray/proxy-helper/Package.swift`, `rt-tray/proxy-helper/Sources/ProxyInstall/main.swift`, `rt-tray/proxy-helper/Sources/ProxyInstall/Report.swift`, `rt-tray/proxy-helper/Tests/ProxyInstallTests/ReportTests.swift`
- Modify: `rt-tray/build.sh` (after the rt-ui embed block, ~line 291)

**Interfaces:**
- Produces: executable answering `--version` → `mattstack-proxy-install <version> protocol 1` exit 0; unknown/missing op → usage on stdout + `MATTSTACK_EXIT=64`; `install`/`remove` stubs → `MATTSTACK_EXIT=69` ("not implemented" until Tasks 3-5). `Report.finish(_ code: Int32) -> Never` prints the trailer and exits; `Report.step(_ line: String)` prints a progress line. Helper version string comes from `HelperVersion.value` (Task 3 generates it; until then a literal `"0.0.0"`).

- [ ] **Step 1: Write the failing test** — `ReportTests.swift`:

```swift
import XCTest
@testable import ProxyInstall

final class ReportTests: XCTestCase {
    func testTrailerLineShape() {
        XCTAssertEqual(Report.trailer(3), "MATTSTACK_EXIT=3")
    }
    func testUsageIsExit64() {
        XCTAssertEqual(ProxyInstallMain.parse(argv: ["x"]), .usage)
        XCTAssertEqual(ProxyInstallMain.parse(argv: ["x", "bogus"]), .usage)
        XCTAssertEqual(ProxyInstallMain.parse(argv: ["x", "--version"]), .version)
        XCTAssertEqual(ProxyInstallMain.parse(argv: ["x", "install"]), .install)
        XCTAssertEqual(ProxyInstallMain.parse(argv: ["x", "remove"]), .remove)
    }
}
```

- [ ] **Step 2: Run to verify it fails** — `cd rt-tray/proxy-helper && swift test` → build failure (types missing).
- [ ] **Step 3: Implement.** `Package.swift`:

```swift
// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "proxy-helper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "ProxyInstall", path: "Sources/ProxyInstall"),
        .testTarget(name: "ProxyInstallTests", dependencies: ["ProxyInstall"], path: "Tests/ProxyInstallTests"),
    ]
)
```

`Report.swift`:

```swift
import Foundation

// The escalator pipes ONLY stdout and derives the exit code from the
// MATTSTACK_EXIT trailer; a missing trailer parses as success, so every
// termination path must run through finish().
enum Report {
    static func trailer(_ code: Int32) -> String { "MATTSTACK_EXIT=\(code)" }
    static func step(_ line: String) { print(line); FileHandle.standardOutput.synchronizeFile() }
    static func finish(_ code: Int32) -> Never {
        print(trailer(code))
        exit(code)
    }
}
```

`main.swift`:

```swift
import Foundation

enum Op: Equatable { case version, install, remove, usage }

enum ProxyInstallMain {
    static func parse(argv: [String]) -> Op {
        switch argv.dropFirst().first {
        case "--version": return .version
        case "install": return .install
        case "remove": return .remove
        default: return .usage
        }
    }
}

switch ProxyInstallMain.parse(argv: CommandLine.arguments) {
case .version:
    print("mattstack-proxy-install \(HelperVersion.value) protocol 1")
    exit(0)
case .usage:
    Report.step("usage: mattstack-proxy-install install|remove|--version")
    Report.finish(64)
case .install, .remove:
    Report.step("not implemented yet")
    Report.finish(69)
}
```

Add `Sources/ProxyInstall/HelperVersion.swift` (placeholder until Task 3's codegen replaces it at build):

```swift
enum HelperVersion { static let value = "0.0.0" }
```

- [ ] **Step 4: Run** `swift test` → PASS; `swift run ProxyInstall --version` → prints the version line, exit 0.
- [ ] **Step 5: Wire the build.** In `rt-tray/build.sh` directly after the rt-ui embed block (mirror its shape):

```bash
# ─── Build + embed the privileged proxy helper ────────────────────────────────
# Mirrors rt-ui exactly, including the prod-only gate: the dev bundle ships
# without it and check-bundle's assertions are mattstack-gated to match.
if [ "$IS_DEV" != true ]; then
    ( cd "$REPO_DIR/rt-tray/proxy-helper" && swift build -c release --disable-sandbox )
    PROXY_HELPER_BIN="$REPO_DIR/rt-tray/proxy-helper/.build/release/ProxyInstall"
    cp "$PROXY_HELPER_BIN" "$CONTENTS/Helpers/mattstack-proxy-install"; chmod +x "$CONTENTS/Helpers/mattstack-proxy-install"
    xattr -cr "$CONTENTS/Helpers/mattstack-proxy-install" 2>/dev/null || true
    HELPER_ENTITLEMENTS+=("$CONTENTS/Helpers/mattstack-proxy-install	none")
fi
```

(Confirm rt-ui's own gate variable name at build.sh:285 and reuse it
verbatim.)

Then a scratch build proves it: run the build target the repo documents for scratch bundles and confirm `Contents/Helpers/mattstack-proxy-install --version` answers from the output tree. Never touch `/Applications/mattstack.app` or `rt-tray/mattstack-dev.app`.
- [ ] **Step 6: Commit** — `git add rt-tray/proxy-helper rt-tray/build.sh && git commit -m "proxy-helper: skeleton with MATTSTACK_EXIT contract, built into Helpers"`.

### Task 3: Build-time pin codegen + verified copy (install step 1)

**Files:**
- Create: `rt-tray/proxy-helper/scripts/gen-pins.sh`, `rt-tray/proxy-helper/Sources/ProxyInstall/CopyStep.swift`, `rt-tray/proxy-helper/Tests/ProxyInstallTests/CopyStepTests.swift`
- Modify: `rt-tray/build.sh` (call gen-pins.sh before the helper's swift build), `rt-tray/proxy-helper/Sources/ProxyInstall/HelperVersion.swift` (becomes generated; add to .gitignore as `Sources/ProxyInstall/Pins.generated.swift`)

**Interfaces:**
- Produces: `PinsValues` (plain struct: `portlessVersion`, `portlessTarballSha256`, `portlessTreeSha256`, `appVersion`, all String) and the generated `Pins.current: PinsValues`. `CopyStep.run(bundleRoot: URL, targetRoot: URL, fs: FileOps, pins: PinsValues) throws` — verifies then stage+renames `Helpers/portless-dist` and `Helpers/node` into `targetRoot`; writes `targetRoot/VERSION` = `pins.portlessVersion`. Production call sites pass `Pins.current`; tests pass a fixture `PinsValues` whose tree hash matches (or mismatches) the fake's, which is what makes the happy-path and swapped-tree tests deterministic. `FileOps` is a seam protocol (list/read/hash/stat/rename/mkdir) with a `RealFileOps` and a test fake. gen-pins.sh must run before ANY `swift build` or `swift test` (the executable target does not compile without the generated file); the test target still compiles no fixture Pins — fixtures are plain `PinsValues` literals inside the tests.
- Consumes: `Report` from Task 2.

- [ ] **Step 1: Write failing tests** — `CopyStepTests.swift` (against the fake `FileOps`):

```swift
func testRefusesSwappedTreeWithValidLayout() {
    let pins = PinsValues.fixture(treeSha256: "cafe")
    let fs = FakeFileOps(treeHash: "deadbeef")
    XCTAssertThrowsError(try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: pins)) {
        XCTAssertTrue("\($0)".contains("hash mismatch"))
    }
    XCTAssertFalse(fs.renamedIntoPlace)
}
func testRefusesNonRootOwnedTargetSegment() {
    let fs = FakeFileOps(targetSegmentOwner: 501)
    XCTAssertThrowsError(try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: .fixture()))
}
func testRefusesSymlinkTargetSegment() {
    let fs = FakeFileOps(targetSegmentIsSymlink: true)
    XCTAssertThrowsError(try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: .fixture()))
}
func testHappyPathStagesThenRenamesAndWritesVersion() {
    let pins = PinsValues.fixture(treeSha256: "cafe", portlessVersion: "9.9.9")
    let fs = FakeFileOps(treeHash: "cafe")
    try! CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: pins)
    XCTAssertTrue(fs.renamedIntoPlace)
    XCTAssertTrue(fs.stagedSiblingOfTarget)
    XCTAssertEqual(fs.written["VERSION"], "9.9.9")
}
```

The tree-hash definition the fake and real ops share: sha256 over each file's `(relative path, sha256(content))` pairs sorted by path — deterministic, layout-and-content binding. For the tarball-level check, hashing the shipped `portless-dist` tree directly is the verification (the tarball sha in Pins guards fetch time; the tree hash, also emitted by gen-pins.sh into `Pins.portlessTreeSha256`, guards install time).
- [ ] **Step 2: Run** `swift test` → FAIL (types missing).
- [ ] **Step 3: Implement.** `gen-pins.sh` (bash, run by build.sh before the helper compile): reads `rt-tray/deps.lock` with the bundled jq or python3, accepts the app version as `$1` (build.sh normalizes its version only at ~line 336, AFTER the embed block's position, so the embed block passes the value explicitly rather than reading a not-yet-set variable — hoist the version stanza or pass the raw value, and say which in the code), computes the tree hash of the FETCHED `rt-tray/deps/arm64/portless-dist` (fetch-deps output; fail loudly if absent), and writes `Sources/ProxyInstall/Pins.generated.swift`:

```swift
let PINS_CURRENT = PinsValues(
    portlessVersion: "<from deps.lock>",
    portlessTarballSha256: "<from deps.lock>",
    portlessTreeSha256: "<computed>",
    appVersion: "<build version>")
enum Pins { static let current = PINS_CURRENT }
enum HelperVersion { static let value = Pins.current.appVersion }
```

Delete the placeholder `HelperVersion.swift`. `Pins.generated.swift` defines `Pins.current: PinsValues` (and `HelperVersion.value = Pins.current.appVersion`); gen-pins.sh writes it and every `swift build`/`swift test` fails loudly without it, which is correct: the helper must never build with unpinned values. Tests never touch `Pins.current` — they construct `PinsValues` fixtures inline (`PinsValues.fixture(...)` is a test-only convenience initializer in the test target).

`CopyStep.swift` implements: resolve `bundleRoot/Helpers/portless-dist` and `bundleRoot/Helpers/node`; `fs.treeHash(portlessDist) == pins.portlessTreeSha256` else throw `hash mismatch`; walk each ancestor segment of `targetRoot` that exists: `fs.stat` must be root-owned (uid 0) and not a symlink, else throw; stage into `targetRoot.deletingLastPathComponent()/.proxy-stage-<pid>`; `fs.rename` over `targetRoot`; write `VERSION`.
- [ ] **Step 4: Run** `swift test` → PASS. Wire `bash rt-tray/proxy-helper/scripts/gen-pins.sh` into build.sh immediately before the helper's swift build; scratch-build to prove the generated pins compile.
- [ ] **Step 5: Commit** — `git add -A rt-tray/proxy-helper rt-tray/build.sh && git commit -m "proxy-helper: build-time pins and verified stage+rename copy"`.

### Task 4: install op — plist, CA trust, sudoers, bootstrap

**Files:**
- Create: `rt-tray/proxy-helper/Sources/ProxyInstall/InstallOp.swift`, `.../LaunchdPlist.swift`, `.../Sudoers.swift`, `Tests/ProxyInstallTests/{LaunchdPlistTests,SudoersTests}.swift`
- Modify: `rt-tray/proxy-helper/Sources/ProxyInstall/main.swift` (wire `.install`)

**Interfaces:**
- Consumes: `CopyStep`, `Report`, `Pins`.
- Produces: `LaunchdPlist.render(nodePath: String, cliPath: String, stateDir: String) -> String`; `Sudoers.render(user: String) -> String`; `ConsoleUser.current() -> String?` (SCDynamicStoreCopyConsoleUser); `InstallOp.run() -> Int32` executing: copy → plist write → trust → sudoers → bootstrap, each sub-step `Report.step`-logged, first failure returns its code.

- [ ] **Step 1: Write failing tests** — golden fixtures:

```swift
func testPlistGolden() {
    let got = LaunchdPlist.render(nodePath: "/Library/Application Support/mattstack/proxy/node",
                                  cliPath: "/Library/Application Support/mattstack/proxy/portless-dist/dist/cli.js",
                                  stateDir: "/Users/tester/.portless")
    XCTAssertEqual(got, goldenPlist) // committed fixture string
}
func testSudoersGolden() {
    XCTAssertEqual(Sudoers.render(user: "tester"),
        "tester ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/sh.portless.proxy\n")
}
```

`goldenPlist` pins: `Label` `sh.portless.proxy`; `ProgramArguments` `[nodePath, cliPath, "start"]` — CHECK the real entrypoint verb first: read the fetched `portless-dist/dist/cli.js` usage (and `package.json` `bin`) and use the daemon-serve subcommand it actually documents for `portless service install`'s plist (copy its shape verbatim; the npm package's own generated plist under `~/.portless` or its source is the reference); `RunAtLoad` true; `KeepAlive` true; `EnvironmentVariables` with `PORTLESS_STATE_DIR` = stateDir and `PATH` `/usr/bin:/bin:/usr/sbin:/sbin`; `StandardOutPath`/`StandardErrorPath` under `/Library/Application Support/mattstack/proxy/log/`.
- [ ] **Step 2: Run** `swift test` → FAIL.
- [ ] **Step 3: Implement** the two renderers exactly to the goldens, `ConsoleUser` via `SCDynamicStoreCopyConsoleUser(nil, nil, nil)` (returns username; nil/"loginwindow" → fail the op with code 78), and `InstallOp`:

```
1 CopyStep.run(bundleRoot: <derived from own executable path, two levels up from Helpers/>, targetRoot: /Library/Application Support/mattstack/proxy)
2 write plist to /Library/LaunchDaemons/.sh.portless.proxy.plist.stage (same fs), rename to sh.portless.proxy.plist
3 trust: run [nodePath, cliPath, "trust"] with PORTLESS_STATE_DIR=<console user's ~/.portless>; nonzero → fail (code 71)
4 sudoers: write to /etc/sudoers.d/.mattstack-portless.stage; `visudo -c -f <stage>`; nonzero → remove stage, fail (code 65); rename to mattstack-portless (0440 root:wheel)
5 launchctl bootout system/sh.portless.proxy (ignore failure); launchctl bootstrap system /Library/LaunchDaemons/sh.portless.proxy.plist; nonzero → remove the plist just written, fail (code 71)
```

Every sub-step logs `Report.step("<name>: ok")`; `main.swift` `.install` case runs `Report.finish(InstallOp.run())`.
- [ ] **Step 4: Run** `swift test` → PASS (renderers + parse; the op body is exercised in the VM, not unit-mocked beyond the seams already covered).
- [ ] **Step 5: Commit** — `git commit -am "proxy-helper: install op (plist, trust, sudoers, bootstrap)"`.

### Task 5: remove op

**Files:**
- Create: `rt-tray/proxy-helper/Sources/ProxyInstall/RemoveOp.swift`
- Modify: `main.swift` (wire `.remove`)
- Test: extend `ReportTests.swift` parse cases already cover argv; remove-op is fixture-free (pure sequence of deletions), covered by the VM leg.

**Interfaces:**
- Produces: `RemoveOp.run() -> Int32`: `launchctl bootout system/sh.portless.proxy` (ignore absent), delete plist, delete `/etc/sudoers.d/mattstack-portless`, untrust the CA (`security delete-certificate -c "portless"` against `/Library/Keychains/System.keychain`; first `security find-certificate -c portless` to resolve the exact common name from the deployed state dir's CA — read the CN out of `<stateDir>/ca.crt` with `security` or openssl at remove time; a missing cert is not a failure), delete `/Library/Application Support/mattstack/proxy`. Each step logged; only unexpected errors fail (code 70); "already absent" is success.

- [ ] **Step 1: Implement + wire** (sequence above; idempotent by construction).
- [ ] **Step 2: Run** `swift test` → PASS; `swift run ProxyInstall remove` as non-root → the op's first privileged action fails cleanly with the trailer (manual smoke of the failure path).
- [ ] **Step 3: Commit** — `git commit -am "proxy-helper: remove op"`.

### Task 6: TS wiring — first-party gate + version-drift validator

**Files:**
- Modify: `lib/setup/steps/services.ts:50-62` (the gate), `lib/setup/validators/tools.ts` (proxy row), `lib/bundle-layout.ts` (add `firstPartyHelperPath` beside `bundledToolPath` if no first-party resolver exists — check how rt-ui is resolved first and reuse that mechanism)
- Test: `lib/setup/__tests__/steps-b.test.ts` (proxy gate cases), `lib/setup/__tests__/validators.test.ts` or the tools validator's existing test file (locate with `grep -rn "tool.fast-browser" lib/setup/__tests__ -l`)

**Interfaces:**
- Consumes: helper at `Contents/Helpers/mattstack-proxy-install` (Task 2), `/Library/Application Support/mattstack/proxy/VERSION` (Task 3), deps.lock `portless.version` (Task 1).
- Produces: gate logic — skip only when the resolved bundle exists AND lacks `Helpers/mattstack-proxy-install`; validator row `tool.proxy` (kind tool, required false): plist absent → `missing` with the install action; plist present + VERSION == pinned → `ready`; VERSION != pinned → `needs-you` detail "proxy runs portless <deployed>, bundle pins <pinned>" with an "Update proxy" action re-running the `proxy.install` need; VERSION unreadable → `error`.

- [ ] **Step 1: Write failing tests** (steps-b, mirroring the existing proxy tests around `proxyInstallStep`):

```ts
test("helper present first-party -> the need runs (no skip)", async () => {
  const p = bundledProbes({ overrides: { files: { [join(appRoot, "Contents/Helpers/mattstack-proxy-install")]: "bin" } } });
  const { ctx } = makeCtx(p, { need: needViaTray({ "GET /setup/need/proxy.install": () => ({ status: 200, json: { state: "done", detail: "installed" } }) }) });
  expect(await proxyInstallStep.run(ctx)).toEqual({ state: "done", detail: "installed" });
});
test("bundle without the helper file -> skipped with reason", async () => {
  const p = bundledProbes();
  const { ctx } = makeCtx(p);
  const out = await proxyInstallStep.run(ctx);
  expect(out.state).toBe("skipped");
});
```

Plus validator truth-table tests for the four row outcomes (fake probes seed the plist path, the VERSION file content, and the deps.lock pin via the real bundle fixture).
- [ ] **Step 2: Run** the two suites → new tests FAIL.
- [ ] **Step 3: Implement**: replace `!bundledToolPath(ctx.p, "mattstack-proxy-install")` with the first-party existence check (`!ctx.p.exists(join(appBundlePath(ctx.p)!, "Contents/Helpers/mattstack-proxy-install"))`), keeping the wording; add the validator row per the truth table, reading the pin from the bundle's deps.lock via the existing parse path used by other validators.
- [ ] **Step 4: Run** `bun test lib/setup` → PASS; `bunx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** — `git commit -am "setup: proxy gate goes first-party, tool.proxy drift row"`.

### Task 7: check-bundle first-party assertion

**Files:**
- Modify: `rt-tray/check-bundle.sh` (beside the rt-ui block, ~line 400)

**Interfaces:**
- Consumes: the built helper's `--version` line `mattstack-proxy-install <ver> protocol 1` (Task 2).

- [ ] **Step 1: Add the assertion block** (mirror rt-ui's):

First, the stowaway sweep: `check-bundle.sh:370` builds
`allowed=" rt-ui skills "` plus deps.lock bundlePath segments, and fails any
undeclared top-level Helpers entry — with the lock row gone the helper is a
stowaway, so extend that literal to `" rt-ui skills mattstack-proxy-install "`.
Then the assertion block, gated `[ "$exe" = mattstack ]` like rt-ui's
(the dev bundle ships without the helper per Task 2's embed gate):

```bash
local pxy="$app/Contents/Helpers/mattstack-proxy-install"
if [ -f "$pxy" ]; then
    pass "$exe ships Helpers/mattstack-proxy-install"
    assert_eq "$exe proxy-helper codesign identifier" "Identifier=com.mattstack.helper.mattstack-proxy-install" "$(codesign -dv "$pxy" 2>&1 | grep '^Identifier=' || true)"
    "$pxy" --version 2>/dev/null | grep -q '^mattstack-proxy-install .* protocol 1$' && pass "$exe proxy-helper answers --version" || fail "$exe proxy-helper --version failed"
    [ -d "$app/Contents/Helpers/portless-dist" ] && pass "$exe ships portless-dist" || fail "$exe missing Helpers/portless-dist"
else
    fail "$exe missing Helpers/mattstack-proxy-install"
fi
```

No signing work is needed: build.sh's `sign_helper_tree` pass derives every helper's identifier as `com.mattstack.helper.$(basename)`, so Task 2's `HELPER_ENTITLEMENTS` entry already yields `com.mattstack.helper.mattstack-proxy-install`.
- [ ] **Step 2: Run** `bash -n rt-tray/check-bundle.sh`; then the scratch-bundle check-bundle run → the new assertions PASS against the Task 2 build.
- [ ] **Step 3: Commit** — `git commit -am "check-bundle: assert the proxy helper and portless-dist ship and run"`.

### Task 8: VM proof

**Files:**
- Modify: `rt-tray/vm/run/guest/assert-installed.sh` (proxy assertions), `rt-tray/vm/run/guest/drive-setup.sh` ONLY if the admin prompt during Install is not already answered by the existing `ax_admin_auth_once` driver (verify first; the update leg proved SecurityAgent handling)

**Interfaces:**
- Consumes: `proxy.install: done` in `rt setup status --json`; `/Library/LaunchDaemons/sh.portless.proxy.plist`; an app domain resolving through the proxy.

- [ ] **Step 1: Add assertions** to assert-installed.sh (following its existing `ok`/`bad` helpers):

```bash
rt_status_json=$("$RT" setup status --json 2>/dev/null | tail -1)
printf '%s' "$rt_status_json" | jq -e '.steps[] | select(.id=="proxy.install") | select(.state=="done")' >/dev/null \
  && ok "proxy.install done" || bad "proxy.install not done"
[ -f /Library/LaunchDaemons/sh.portless.proxy.plist ] && ok "portless LaunchDaemon plist present" || bad "portless plist missing"
sudo -n launchctl print system/sh.portless.proxy >/dev/null 2>&1 && ok "portless daemon loaded" || bad "portless daemon not loaded"
curl -fsS --max-time 10 "https://deck.mattstack" >/dev/null 2>&1 && ok "deck answers on its .mattstack domain over https" || bad "deck.mattstack not answering through the proxy"
```

(`sudo -n` works in the guest via the harness's admin user; if the tester user lacks sudo, replace the loaded-check with `launchctl print system/sh.portless.proxy` run through the existing admin-exec path the harness uses elsewhere — check `install-app.sh` for the precedent.)
- [ ] **Step 2: Run the leg**: `bash rt-tray/vm/run/walkthrough.sh --ver 26 --dmg <scratch>/mattstack.dmg --scenario create --fresh-team-repo --no-graphics` where `<scratch>/mattstack.dmg` is a scratch-built DMG carrying Tasks 1-7 — never `--app rt-tray/mattstack.app`, the blessed bundle the repo rules forbid touching. Expected: `proxy.install: done` and all four new assertions `ok`. Iterate here until green; this is the release-gate proof (RT-106's verification section).
- [ ] **Step 3: Commit** — `git commit -am "vm: assert the proxy installs, loads, and serves .mattstack"`.

### Task 9: Docs + gates

**Files:**
- Modify: `docs/release-and-distribution.md` (§2 helper list + a proxy paragraph: first-party helper, pinned portless, root-copy home, prompt-per-update), `rt-tray/vm/README.md` (the proxy leg's expectations)

- [ ] **Step 1: Write the two doc passages** (state what ships and the update-needs-a-prompt rule; point at the spec for the security model).
- [ ] **Step 2: Run the full gate**: `bun run test:all && bunx tsc --noEmit && bun run docs:check && bun run picker:check && bash scripts/repo-purity.sh` → all green.
- [ ] **Step 3: Commit** — `git commit -am "docs: proxy helper ships; update rules"`.
