# MAT-383 Phase 1 Implementation Plan — rt-tray → mattstack.app

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rebrand rt-tray to mattstack.app (clean-break bundle id), add the dual-bundle dev mode, migrate existing installs, and fix the verify contract — per the rev-5 spec.

**Architecture:** TS-side constants and flavor logic land first (pure, testable); then the Swift/build-system identity change; then Swift runtime behavior; then the toggle rewrite and migration sweep that depend on both; CI/cosmetics trail.

**Spec:** `spec-mat383-phase1-rebrand.md` (same directory) — THE requirements, 5 review rounds. Copy to `docs/superpowers/specs/2026-08-20-mattstack-app-phase1.md` in Task 1's first commit. On conflict, the spec wins.

## Global Constraints (binding on every task)

- Bundle ids: prod `com.mattstack.app`, dev `com.mattstack.app.dev`. Daemon labels: prod `com.rt.daemon` (UNCHANGED), dev `com.rt.daemon.dev`. Never rename `com.rt.daemon` itself.
- On-disk names: `mattstack.app` / `mattstack-dev.app` in `~/Applications`; executables `mattstack` / `mattstack-dev`.
- All paths/names flow through the §2 rt-paths constants; `legacyTrayAppPaths()` is a function (call-time HOME).
- `currentMode()` (moved to `lib/dev-mode.ts`) is the ONLY flavor signal.
- The `-i rt-daemon` codesign override survives in the dev shim-signing step; `rt.sock`/`tray.sock`/log-surface/`com.rt.daemon` strings are correct as-is — no sed-blasting.
- Grep-gate (spec Verification): zero `rt-tray` literals in TS outside `legacyTrayAppPaths()`.
- Commit prefix `MAT-383:`; end commit bodies with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: TS foundations — constants, lib/dev-mode.ts, activeLaunchdLabel

**Files:** Modify `lib/rt-paths.ts` (spec §2 block verbatim: `TRAY_APP_NAME`, `DEV_TRAY_APP_NAME`, `TRAY_APP_BUNDLE`, `DEV_TRAY_APP_BUNDLE`, `trayAppPath()`, `devTrayAppPath()`, `legacyTrayAppPaths()`). Create `lib/dev-mode.ts` (move `currentMode()` from `commands/settings.ts:364`, logic unchanged; settings.ts imports it). Modify `lib/daemon-config.ts` (add `activeLaunchdLabel()` per spec §1; replace its own `rt-tray` literals with the constants). Tests: `lib/__tests__/rt-paths.test.ts` additions + `lib/__tests__/dev-mode.test.ts`.

**Produces:** the constants + `currentMode()` + `activeLaunchdLabel()` every later task imports.

- [ ] Failing tests: call-time HOME for all three path helpers; `activeLaunchdLabel()` per mode; currentMode behavior parity (existing tests keep passing from the new home).
- [ ] Implement; `bunx tsc --noEmit` clean (settings.ts import updated, nothing else changed yet).
- [ ] Full `bun test` green; commit.

### Task 2: verify contract + vsix presence check

**Files:** Modify `commands/verify.ts` (spec §5: active-flavor hard-fail rule, inactive informational, legacy warning, `activeLaunchdLabel()` for launchctl; vsix presence check — pure directory reads over `~/.vscode/extensions` + Cursor equivalent, pass/warn/skip verdicts, `brew --prefix` deleted). Update `e2e/tests/verify.test.ts:70` to the new contract. Unit test for the vsix check with fixture dirs (spec Verification).

- [ ] Failing tests → implement → full suite + e2e verify test green; tsc clean; commit.

### Task 3: bundle identity — build.sh + plists (prod AND dev variants build)

**Files:** Modify `rt-tray/build.sh` (spec §1: `PRODUCT_NAME="rt-tray"` vs `APP_NAME` split — source binary from `.build/release/$PRODUCT_NAME`, bundle copy to `Contents/MacOS/$APP_NAME`; Info.plist templating injecting `BUNDLE_ID`, `MSDaemonLabel`, `MSDevBuild`; LaunchAgent template injecting Label + AssociatedBundleIdentifiers + KeepAlive (prod `true`, dev `{SuccessfulExit:false}`); `build.sh dev` mode producing `mattstack-dev.app` with the dev values; dev signing = Developer ID cert when present, bundle-wide, ad-hoc fallback; prod path DROPS the shim compile/sign/embed steps; dev path keeps them with `-i rt-daemon`). Modify `rt-tray/Info.plist` + `rt-tray/LaunchAgent.plist` into templates.

**Interfaces produced:** Info.plist keys `MSDaemonLabel`, `MSDevBuild` (Task 4 reads them); the two flavor plist names `com.rt.daemon.plist` / `com.rt.daemon.dev.plist`.

- [ ] `build.sh release` produces mattstack.app with correct Info.plist/agent plist (assert via `plutil`/grep in a script check); `build.sh dev` produces mattstack-dev.app with dev values incl. KeepAlive dict.
- [ ] Commit. (Swift sources untouched this task; the app still runs because MSDaemonLabel defaults are added in Task 4 — build.sh templating and Swift reading land in ADJACENT commits, and the manual smoke gate only runs after Task 4.)

### Task 4: Swift runtime — label from bundle, socket guard, /flavor/retire, login item, shim exits, dev cosmetics

**Files:** Modify `rt-tray/Sources/DaemonLifecycle.swift` (plistName + every launchctl label from `Bundle.main` `MSDaemonLabel`, fallback `com.rt.daemon`); `rt-tray/Sources/TrayServer.swift` (startup connect-probe ping-guard completing BEFORE SMAppService registration, exit if a live tray answers; delete `/login-item/reset`; add `POST /flavor/retire` = daemon `service.unregister()` + `SMAppService.mainApp.unregister()`); `rt-tray/Sources/AppDelegate.swift` (idempotent `mainApp` auto-register at startup gated by a UserDefaults opt-out the panel toggle writes; dev menu-bar `dev` mark via `MSDevBuild`); `rt-tray/Sources/ProcessPanelView.swift` (toggle writes the opt-out default); `rt-tray/Sources/UpdateChecker.swift` (silent when `MSDevBuild`); `rt-tray/Sources-daemon-shim/main.swift` (ALL `die()` precondition paths → exit 0 + one log line; real crashes non-zero).

- [ ] Build both flavors; manual-style scripted assertions where possible (shim exit codes are unit-testable by running the binary against a temp HOME).
- [ ] Commit.

### Task 5: dev-mode toggle rewrite (TS)

**Files:** Modify `commands/settings.ts`: DELETE the swap machinery (`swapDaemonToShim`, `DAEMON_REAL_BACKUP`, `DAEMON_SHIM_PATH`, restore paths, LWCR comment block, `RT_TRAY_APP` literal family) and rewrite `dev-mode on|off` as the spec §3 handoff: precondition (incoming bundle exists, abort first) → `POST /flavor/retire` → flavor-aware quit (osascript display name + `pkill -x` executable name) → connect-probe + `launchctl list` poll until gone → launch incoming. CLI-half toggling (wrapper/preload) unchanged.

- [ ] Failing test: the spec's toggle test — PATH-faked `launchctl`/`osascript`/`pkill` + fake socket asserting order (precondition → retire → quit → wait → launch) and missing-incoming-bundle aborts before any retire/quit.
- [ ] Implement; grep-gate: zero swap-machinery symbols remain; full suite green; tsc clean; commit.

### Task 6: post-install migration sweep

**Files:** Modify `commands/post-install.ts`: the spec §4 guarded sweep (only when `legacyTrayAppPaths()` non-empty): quit old names → `launchctl bootout gui/$UID/com.rt.daemon` → `rm -rf` legacy paths → install + launch → daemon health ping with loud failure → one-time permissions note. NOT in `rt daemon install`.

- [ ] Failing tests: PATH-fake run asserting quit→bootout→rm before install; the sweep-guard test (no legacy bundle → zero quit/bootout/rm calls).
- [ ] Implement; full suite green; commit.

### Task 7: CI, icon, strings, gate

**Files:** Modify `.github/workflows/release.yml` (spec §6: path renames only, notarize order untouched, Formula installs `mattstack.app`, name/class/tap unchanged); `rt-tray/make-icon.swift` + regenerate AND COMMIT iconset + `AppIcon.icns` (+ dev tint); UI strings per spec §7 (grep-audited); final grep-gate run: zero `rt-tray` TS literals outside `legacyTrayAppPaths()`.

- [ ] Implement; full `bun test` + `bunx tsc --noEmit` + e2e green; commit.

---

## Final gate (orchestrator)

Whole-branch review (fable), fix wave, then the spec's manual smoke on Matt's machine (dev build runs daemon from source; toggle round-trips; release install migrates off rt-tray.app; permissions re-granted once; `rt verify` green incl. vsix). Merge per finishing-a-development-branch — coordinate the first real install with Matt since it touches the live tray.
