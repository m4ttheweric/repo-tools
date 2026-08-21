# Cross-plan review — L1 / L3 / L4 / L7 (MAT-383 installer program)

Read-only review of the four plans written in parallel, against the spec
(`specs/2026-08-20-mattstack-app-installer-design.md`), the binding contract
(`specs/2026-08-21-rt-setup-contract.md`) and the settings-lane spec
(`specs/2026-08-20-suite-settings-migration.md`). Line numbers are into each
plan file as of 2026-08-21. Plans: **L1** `plans/2026-08-21-rt-setup-verbs.md`,
**L3** `plans/2026-08-21-mattstack-app-shell.md`, **L4**
`plans/2026-08-21-release-pipeline.md`, **L7** `plans/2026-08-21-clean-room-vm.md`.

Verdict in one line: no two plans can be executed as written without
collisions on ~20 files and ~25 interface mismatches; every one below has a
mechanical fix. Nothing requires a redesign. Five items need a ruling from
Matt (marked **RULING NEEDED**).

---

## 0. Top findings (ordered by blast radius)

1. **`need` reply protocol is incompatible between L1 and L3.** L1 T22 polls
   `GET /setup/need/<id>` expecting "404 = not yet" and a body `{ok, detail}`
   (L1:955-959, test L1:963 "returns 404 twice then 200 {ok:true,…}"). L3 T9 (and
   the contract) serve **200 `{state:"pending"|"done"|"failed", detail}` for every
   id, never 404** (L3:2769 "unknown/unstarted id is pending — rt keeps polling",
   L3:2850-2855). As written L1 treats the first 200 `pending` as a reply with
   `ok` undefined → step fails instantly. Fix L1 T22 (§5 #1).
2. **L1's uninstall `need` types and action ids are not understood by L3.** L1
   emits `{type:"app-unregister-services"}` and `{type:"app-privileged", op:"proxy-remove"}`
   (L1:143-145, 1124); L3's NeedBroker handles only `app-register-services` and
   `app-privileged/proxy-install`, everything else → `failed: unknown need type`
   (L3:2879-2891); `PrivilegedInstalling` has no `proxyRemove()` (L3:2549-2551).
   L3's stub uses action ids `deck.managed`, `plugins.remove` and lacks
   `shell.remove`, `extension.uninstall`, `data` (L3:1471-1477) vs L1's
   `UninstallActionId` (L1:147). Fix L3 T8/T9/T4 + contract (§5 #12-14).
3. **`~/.local/bin/rt`, `mattstack.appPath`, legacy sweep and the vsix path are
   implemented twice** — L4 T9 rewrites `commands/post-install.ts`
   (`recordAppPath`, `installRtBinaryStep(root)`, `runLegacySweep(root)`,
   `runPostInstall(opts:{bundleRoot})`, L4:1991-2127) while L1 T27 rewrites the
   same file into "sweep → `setupApply([...])`" with `runPostInstall(args)`
   (L1:1065, 1080) and L1 T24 `settings.seed`/`path.link` re-implement appPath +
   link. Same file, same functions, different signatures. Ruling §1 row 1.
4. **`commands/update.ts`, `commands/verify.ts`, `cli.ts`, `README.md` are each
   rewritten by both L1 and L4** with different semantics (`rt update` exit 1 vs
   exit 2 + `--json`; verify = new ad-hoc checks vs verify = validator rows).
   Rulings §1 rows 2-5.
5. **rt-tray build surface is split three ways with contradictory values.**
   `Package.swift`, `build.sh`, `check-bundle.sh`, `Info.plist`, `LaunchAgent.plist`
   are edited by L3 T1/T2/T10 and L4 T3/T4/T5. Concrete contradictions:
   `SUFeedURL` `https://m4ttstack.github.io/rt/appcast.xml` (L3:633-634, 735) vs
   `https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml` (L4:947,
   1348); `SUScheduledCheckInterval` 86400 (L3:643) vs 21600 (L4:24, 1127);
   `CFBundleURLName` `@@BUNDLE_ID@@.join` (L3:622-632) vs `@@BUNDLE_ID@@.url`
   (L4:637-650); prod `KeepAlive` `{SuccessfulExit:false}` (L3:557-558, spec §8) vs
   `bool true` (L4:1098, check-bundle L4:789); agent `EnvironmentVariables.PATH`
   `/usr/bin:/bin:/usr/sbin:/sbin` (L3:574) vs
   `/Applications/$APP_NAME.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin`
   (L4:1102-1103, asserted L4:1251) vs spec §7 "`PATH=<app>/Contents/Helpers:/usr/bin:/bin`
   plus `~/.local/bin`". L4's build.sh `PlistBuddy Add :SU*`/`Add :EnvironmentVariables`
   fails if L3's templates already contain the keys. L4 ships **only the daemon
   plist** (L4:55, 2550, OQ8); L3 ships daemon + deck via `scripts/render-launchagents.sh`
   (L3:561-562); L1 `servicePlists` asks the app to register **both**
   (L1:951) and L3 reports `ok` only when every plist registers → `services.register`
   fails on every L4-built bundle. Rulings §1 rows 12-19, drift §2 #8-#11.
6. **Bundle-resolution contract is duplicated and disagrees on layout.** L4 T1
   `lib/bundle-layout.ts` (`appBundleRoot`, `bundledHelperPath`, `bundledExec`,
   deps.lock-driven; `node` is a dir `Helpers/node/bin/node`, fast-browser is
   `[node, Helpers/fast-browser/bin/fast-browser.mjs]`, L4:52-53, 168, 317) vs L1
   T5 `lib/deps/resolve.ts` (`HELPER_TOOLS` flat `Contents/Helpers/<tool>` incl.
   `node`, `fast-browser`; `bundledToolPath`; `link()` = symlink only, L1:389-407).
   L4 explicitly says "L1's `rt deps link` renders the wrapper in `~/.local/bin`
   from `exec`" (L4:41) — L1 has no wrapper rendering. Fix L1 T5/T8/T21 to consume
   bundle-layout (§5 #4-#6).
7. **L7's accessibility identifiers do not exist in L3.** L7 drives
   `setup.window`, `setup.continue`, `setup.install`, `setup.finish`,
   `setup.card.create|join`, `setup.field.teamName|inviteCode`, `row.<id>`,
   `row.<id>.action|.status`, `connect.field.token`, `connect.submit`,
   `row.install.failedStep.status` (L7:55, 1164-1244); L3 defines
   `setup.welcome.screen`, `setup.<screen>.continue`, `setup.team.card.create|join`,
   `setup.team.create.name`, `setup.team.join.code`, `setup.checklist.row.<id>[.action|.status]`,
   `setup.checklist.connect.field.<name>`, `setup.checklist.connect.submit`,
   `setup.install.retry`, `setup.done.continue`, `setup.checklist.relaunch`
   (L3:3714-3779). L7 itself says "not yet in the L3 plan" (L7:55) — it was written
   before L3's AXID file. Fix L7 T6 (§5 #30).
8. **Restore card performs no restore.** L3 T13 runs only
   `rt restore <repo> --dry-run --json` with stdin `{"ageKey"}` (L3:4286-4287)
   and never `rt setup intent restore`; L1 `home.restore` "never runs restore
   itself" and fails with remedy "Run `rt restore …`" (L1:1009). Nobody clones the
   home repo. **RULING NEEDED** on owner (§5 #17).
9. **`scripts/e2e-cleanroom.sh` CLI disagrees with its only CI caller.** L4 T8
   calls `scripts/e2e-cleanroom.sh "<zip>"` positionally (L4:1781, 1784); L7 T12
   requires `--artifact <tar.gz|zip> | --tag | --app` (L7:1872), its `--tag` path
   downloads `rt-darwin-arm64-*.tar.gz` (L7:1901-1902) which L4 no longer publishes
   (L4:19, Decision 2), it runs `rt daemon install` after `--post-install`
   (L7:1927) and passes no `--no-launch` (only via `--post-install-args`, L7:1925).
   Fix L7 T12 (§5 #34).
10. **`rt team create`, `rt setup github status`, `rt team status`,
    `rt uninstall --yes`, `rt settings dev-mode`, `rt setup slack create-app`
    argv drift between L3 and L1/rt.** L3: `--remote gh:<owner>/<repo>` (L3:4270-4272)
    vs L1 `--create-repo <owner>` (L1:762); L3 expects `setup github status` →
    `{status, handle, owners}` (L3:4253) vs L1 `{integration,status,detail,scopesSeen}`
    (L1:618); L3 `team status --json` → `{name,slug,remote,lastPush,members}`
    (L3:5069) — no such verb in L1 or the contract; L3 `uninstall --delete-data --json`
    without `--yes` (L3:5091) → L1 exits 2 `confirm-required` on non-TTY (L1:1126);
    L3 `settings dev-mode on|off` (L3:5201) vs the real verb `dev-mode <dev|prod>`
    with `requiresTTY: true` (lib/command-tree-def.ts:682-689); L3 sends
    `--config-token-stdin` **and** JSON `{configToken}` (L3:4509, 4526) while L1
    reads a raw token line when the flag is present (L1:629). §5 #15-#21.

Cross-cutting: **none of the four plans states a rebase/merge order relative
to the others** (L1 only rebases onto `origin/main`; L3/L4/L7 have no statement).
The order in §3 is mandatory, not advisory.

---

## 1. File-ownership conflict matrix

Legend: **Owner** = the lane whose edit stands; others **drop**, **consume**
(use the owner's API, no edit), or **rebase-after** (keep a disjoint edit but
apply it on top of the owner's). Task numbers are the ones to amend.

| # | File | L1 | L3 | L4 | L7 | Overlap | RULING |
|---|---|---|---|---|---|---|---|
| 1 | `commands/post-install.ts` | T8 (import `detectEditors` from `lib/editors.ts`), **T27** (entry only: sweep + `setupApply([...])`; deletes `installRtBinaryStep/installTrayApp/installExtensions/installDaemon`; `runPostInstall(args)`) | — | **T9** (replace `installRtBinaryStep`+`installTrayApp` with `recordAppPath(root)`+`installRtBinaryStep(root)`, `findVsix(root)`, `runLegacySweep(root)`, `runPostInstall(opts:{bundleRoot})`, keeps `installDaemon`, `open`) | — | **Overlapping** (same functions, incompatible signatures) | **L1 owns.** L4 T9 drops `commands/post-install.ts` and `lib/__tests__/post-install-sweep.test.ts` from its Files; keeps `lib/dev-mode.ts`, `lib/rt-paths.ts` + their tests. L1 T27 absorbs verbatim: L4's `appPathIsTransient`/exit-2 refusal (L4:1993-2006, 2107), L4's `runLegacySweep(root)` body (L4:2064-2092) and its new test case (L4:1928-1937), and a `bundleRoot` override: `runPostInstall(args: string[], opts: { bundleRoot?: string \| null } = {})`. L1 T24 `settings.seed` derives `appPath` via `bundleRootFromExec()` (L4 T1), not its own regex. |
| 2 | `commands/update.ts` | **T30** (rewrite: `POST /update/check` via `trayRequest`; exit 2 + `--json` envelope `{error:{code:"app-not-running"}}`; tree description) | — | **T10** (rewrite: `trayQuery`; exit 1; no `--json`; `deps` injectable) | — | **Overlapping** (both full rewrites) | **L1 owns** (contract exit codes: `2` user-actionable, `--json`). L4 T10 **dropped** (update.ts, its test, the cli.ts comment). L1 T30 adopts L4's injectable `deps` shape + the `res.ok === false` "app predates CLI-triggered updates" branch (L4:2244-2247) and the `RELEASES_URL` constant. L4 T12 regenerates `website/docs/reference/update.mdx` **after** L1 T30 lands (rebase-after). |
| 3 | `commands/verify.ts` | T7 (move `checkRtContextExtension`), **T11** (replace `runChecks` with `rowsToChecks(composePlan)`; delete old check bodies) | — | **T11** (replace fzf block; add `"rt link"` + `"bundled extension"` checks after the tray block, L4:2361-2398) | — | **Overlapping** (L1 deletes the block L4 edits) | **L1 owns.** L4 T11 drops the `commands/verify.ts` edit (keeps `lib/fzf.ts`, `lib/notifier.ts` + tests). L1 T7 adds two rows to the rt-health table so nothing is lost: `tool.rt-link` (required:false; prod only; `readlink(~/.local/bin/rt) === join(appBundlePath, "Contents/MacOS/rt")` → ready, else needs-you "run: rt setup apply --from path.link") and `tool.vsix` (required:false; `<app>/Contents/Resources/rt-context.vsix` exists); `tool.fzf` detail uses L4's `resolveFzf()` ("bundled \| PATH"). |
| 4 | `cli.ts` | **T10** (first-run hook: hint instead of auto-setup; skip list), **T27** (`--post-install` passes `args.slice(1)`) | — | T10 (lines 118-122 comment only) | — | Overlapping (L1 rewrites the block) | **L1 owns.** L4 T10 drops (already dropped by row 2). |
| 5 | `README.md` | T31 ("replace the brew/tmux/zellij/terminal-notifier lines with 'Install mattstack.app from the DMG; rt is inside'") | — | **T12** (rewrites `## Install`, `### What Gets Installed`, `### Upgrade`, `## Requirements`, `### Testing the installer`, `### rt-tray`, `### Release process`) | — | **Overlapping** (same sections) | **L4 owns.** L1 T31 drops its README edit; L1 T31 only regenerates reference pages (`bun run docs:gen`/`docs:check`) and **rebases after L4 T12**; L1's grep for `tmux\|zellij\|terminal-notifier\|brew install fzf` becomes an assertion that L4 already removed them. |
| 6 | `website/docs/**` | T31 (regenerate reference pages for new verbs) | — | T12 (`getting-started/install.mdx`; regenerate `reference/update.mdx`) | — | Disjoint files; both run `docs:gen` | Whoever merges second re-runs `bun run docs:gen && bun run docs:check` (rebase-after). No ruling needed. |
| 7 | `scripts/README.md` | — | — | T6 (document `scripts/release/*` + `fetch-deps.sh`) | T12 (append `## e2e-cleanroom.sh`) | Disjoint appends | Both append; second to merge rebases. L7 T12's text must say "zip" not "tarball" (see §2 #25). |
| 8 | `.gitignore` (root) | — | T1 (`rt-tray/*.xcodeproj/`, `rt-tray/Generated/`, `rt-tray/Tests/stub-rt/.state/`) | T2 (`rt-tray/deps/`, `rt-tray/out/`, `rt-tray/.build-xcode/`, and again `rt-tray/*.xcodeproj/` at L4:585-591) | — | One duplicate line | **L3 owns** `rt-tray/*.xcodeproj/`; L4 T2 drops that line (L4 OQ7 resolved: L3 regenerates the project). Rest disjoint, rebase-after. |
| 9 | `lib/rt-paths.ts` | consumes (`installedTrayAppPath`, `TRAY_APP_BUNDLE`) | — | **T9** (`trayAppPath(exists?)`/`devTrayAppPath(exists?)` → `installedTrayAppPath(...) ?? /Applications/...`; `legacyUserAppPath()`) | — | None (L1 consumes) | **L4 owns.** L1 T5 `appBundlePath()` must be `appBundleRoot()` from `lib/bundle-layout.ts` (which already calls `installedTrayAppPath`, which already reads `mattstack.appPath` — verified in `lib/rt-paths.ts:144-158` on main). L1 T5 **after** L4 T1+T9. |
| 10 | `lib/dev-mode.ts` | consumes (`currentMode`, `rtBinaryPath`) | — | **T9** (`installRtBinary(src)` → atomic symlink) | — | None | **L4 owns.** L1 T5 `link(p,"rt")` calls `installRtBinary(target)` (atomic link-then-rename) instead of a bare `p.symlink`; `isOurLink` unchanged. |
| 11 | `lib/fzf.ts`, `lib/notifier.ts` | — | — | **T11** | — | None | L4 owns. L1 T7 `tool.fzf` uses `resolveFzf()`. |
| 12 | `rt-tray/Package.swift` | — | **T1** (full rewrite: tools 5.9, `.macOS(.v14)`, MattstackCore/checks/XCTest targets), **T10** (Sparkle `from: "2.9.6"`, rpaths, `Package.resolved`) | T3 (`.macOS(.v13)`→`.v14` one-liner), T5 (Sparkle dep + rpath, `Package.resolved`; "skip if L3 has already added") | — | **Overlapping** | **L3 owns.** L4 T3 drops the Package.swift edit; L4 T5 drops the Package.swift/Package.resolved edit unconditionally and becomes "requires L3 T10 merged" (its `check_sparkle` assertions stay). **Mandatory order:** L3 T1 + T10 merged before L4 T4/T5 run. |
| 13 | `rt-tray/build.sh` | — | T10 ("fenced stopgap": Sparkle copy+sign, **plus** `render-launchagents.sh` call replacing the sed/KeepAlive block, L3:3243-3271) | T3 (minimal: `rt-daemon`→`rt`, `-i rt`, `numeric_build`), **T4** (full rewrite) | — | **Overlapping** (L4 T4 deletes L3's stopgap) | **L4 owns.** L3 T10's stopgap is permitted only while L4 T4 has not merged and must be fenced exactly as L3 writes it; L4 T4's rewrite **must** (a) call `"$SCRIPT_DIR/scripts/render-launchagents.sh" <prod\|dev> "$CONTENTS/Library/LaunchAgents"` instead of its own `sed`+`PlistBuddy` block (L4:1093-1104), (b) keep `embed_sparkle` + inside-out Sparkle signing, (c) use `PlistBuddy Set` (not `Add`) for every key L3's Info.plist template already declares. |
| 14 | `rt-tray/check-bundle.sh` | — | T10 (UpdateChecker awk → `UpdatePolicy.shouldStartUpdater` grep; `assert_bin_has "silent dev updater"`; `KA_PRINT` both flavors expect `SuccessfulExit`, L3:3229-3273) | **T3** (full rewrite), T4 (Helpers section), T5 (Sparkle section) | — | **Overlapping** | **L4 owns.** L4 T3's rewrite must carry L3's three assertions and flip L4:789 (prod `KeepAlive=true`) to `KeepAlive:SuccessfulExit=false` for both flavors; add a deck-plist assertion (`Contents/Library/LaunchAgents/com.mattstack.deck[.dev].plist`, Label, `BundleProgram Contents/Helpers/deck`); change the PATH assertion (L4:1251) to whatever §2 #9 rules. L3 T10 drops its check-bundle edit **if** L4 T3 has merged; otherwise L4 absorbs at rebase. L4's Swift source gates (L4:856-866: `forInfoDictionaryKey: "MSDaemonLabel"`, `defaultDaemonLabel = "com.mattstack.daemon"`, literal `path == "/flavor/retire"`, socket guard before `AppDelegate()` in `main.swift`) become explicit requirements of L3 T9 (TrayServer refactor) and T18 (main.swift). |
| 15 | `rt-tray/Info.plist` (template) | — | **T2** (`LSMinimumSystemVersion 14.0`, `CFBundleURLTypes` name `@@BUNDLE_ID@@.join`, `SUFeedURL`, `SUPublicEDKey` placeholder `REPLACE_WITH_RELEASE_PUBLIC_ED_KEY`, `SUEnableAutomaticChecks`, `SUAutomaticallyUpdate`, `SUVerifyUpdateBeforeExtraction`, `SUScheduledCheckInterval 86400`, `NSAppTransportSecurity.NSAllowsLocalNetworking`) | T3 (`LSMinimumSystemVersion 14.0`, `CFBundleURLTypes` name `@@BUNDLE_ID@@.url`); T4 build.sh `PlistBuddy Add :SU*` | — | **Overlapping, contradictory values** | **L3 owns the template** (and `project.yml` `info.properties` — one source). L4 T3 drops its Info.plist edit. Values in L3 T2 are corrected to L4's canon: `SUFeedURL = https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml`, `SUScheduledCheckInterval = 21600` (pending §4 #1 ruling on the host). L4 T4 build.sh writes `SUFeedURL`, `SUPublicEDKey`, `SUEnableAutomaticChecks` with `Set` (create-if-missing helper), dev flavor `Set :SUEnableAutomaticChecks false`. |
| 16 | `rt-tray/LaunchAgent.plist` (template) | — | **T2** (`EnvironmentVariables.PATH`, KeepAlive via render script; "keep everything else as is") | T3 (`BundleProgram`/`ProgramArguments` → `Contents/MacOS/rt`; Label comment); T4 build.sh `Add :EnvironmentVariables:PATH`, KeepAlive by flavor | — | **Overlapping** | **L3 owns.** L3 T2 additionally applies L4 T3's rename in the template (`BundleProgram Contents/MacOS/rt`, `ProgramArguments [Contents/MacOS/rt, --daemon]`, comment "Label: com.mattstack.daemon (prod) / com.mattstack.daemon.dev (dev)"). L4 T3 drops the LaunchAgent.plist edit; L4 T4 renders via the script (row 13). PATH value: §2 #9. |
| 17 | `rt-tray/LaunchAgent-deck.plist`, `rt-tray/scripts/render-launchagents.sh`, `rt-tray/project.yml`, `rt-tray/entitlements/mattstack.entitlements` | — | **T2** create | consumes `project.yml` (T4 `xcodegen generate --spec`, schemes `mattstack`/`mattstack-dev` — names match L3:937-941/L3 targets) | — | None | L3 owns; L4 T4 consumes `render-launchagents.sh` (row 13) and bundles **both** plists; L4 OQ8 ("deck plist is L3/L5's") is closed: L3 ships it, L4 copies it. |
| 18 | `rt-tray/Sources/AppDelegate.swift` | — | **T10**, **T18** (major) | T3 (`:331` `rt-daemon`→`rt`) | — | Overlapping | **L3 owns `rt-tray/Sources/**`.** L4 T3 drops all four Swift edits; L3 T3 already resolves `Contents/MacOS/rt` first (L3:1215) — L3 T18 adds the `AppDelegate.swift:331` string change; `DaemonLifecycle.swift:8,17-18` and `Sources-daemon-shim/main.swift:4,26` comment edits move to L3 T18 (or L3 T3). |
| 19 | `rt-tray/Sources/UpdateChecker.swift` | — | **T10** deletes | T3 modifies `:164` | — | Delete vs modify | L3 deletes; L4 T3 drops. |
| 20 | `rt-tray/Sources/TrayServer.swift`, `main.swift`, `TrayState.swift`, `ProcessPanelView.swift` | — | T9, T18 | (check-bundle source gates only) | — | None | L3 owns; see row 14 for the gates L3 must preserve. |
| 21 | `commands/settings.ts:462-471`, `lib/__tests__/dev-mode-handoff.test.ts`, `scripts/entitlements.plist` | — | — | T3, T9 | — | None | L4 owns. (L3 T2 creates a second entitlements file `rt-tray/entitlements/mattstack.entitlements` for xcodebuild; L4 build.sh signs the outer app with an inline plist — same content `app-sandbox=false`; fine, note only.) |
| 22 | `lib/command-tree-def.ts`, `lib/module-registry.ts`, `lib/daemon-client.ts`, `lib/daemon.ts`, `lib/shell-integration.ts`, `lib/secrets/*`, `lib/home/age-key.ts`, `commands/secrets.ts`, `commands/extension.ts`, `lib/editors.ts`, `e2e/tests/setup.test.ts` | L1 (many tasks) | — | — (L4 T10 consumed `trayQuery`, now dropped) | — | None | L1 owns. |
| 23 | `lib/bundle-layout.ts` (L4 T1) vs `lib/deps/resolve.ts`, `lib/deps/links.ts` (L1 T5) | T5 | — | T1 | — | Different files, **same responsibility** | **L4 T1 is the substrate; L1 T5 consumes it** (§5 #4-#6). L1 T5 runs after L4 T1 merges. |
| 24 | `.github/workflows/release.yml` | — | — | **T8** | consumes (`scripts/e2e-cleanroom.sh`) | None | L4 owns; L7 T12's script must accept L4's call shape (§5 #34). |
| 25 | `scripts/e2e-cleanroom.sh` | — | — | calls | **T12** | Interface only | L7 owns; interface fixed in §5 #34. |
| 26 | `rt-tray/vm/run/make-dmg.sh`, `make-appcast.sh` (L7 T3) vs `scripts/release/make-zip.sh`, `make-dmg.sh`, `appcast.sh` (L4 T6) | — | — | T6 | T3 | Duplicate recipes (different files) | Both stand (L7 needs a pre-L4 path and a loopback appcast). L7 T3 must call `scripts/release/make-zip.sh`/`make-dmg.sh` when they exist (§5 #33) so the DMG under test is L4's recipe. |
| 27 | `docs/superpowers/specs/2026-08-21-rt-setup-contract.md` (+ spec, research dir) | **T13** ("the only spec edit this plan makes": team-scope secrets layout heading) | **T0** (copies spec + contract + research into the L3 branch) | — | — | Docs branch collision | **Neither lane commits spec files in its branch.** Merge `docs/mattstack-app-installer-spec` (from `repo-tools-appspec-wt`) into `main` before execution; L3 T0 Step 2 is dropped; L1 T13's layout note is applied to the contract in the appspec branch (as one of the amendments in §5) and L1 only references it. |
| 28 | `rt-tray/vm/golden/{build-golden,provision-guest,verify-golden}.sh` | — | — | — | T2 create; **T13 edits all three** but lists only `run/xcuitest.sh` | Within-lane only | L7 T13 Files block must list the three golden scripts (plan hygiene; no cross-lane effect). |

No other file appears in two plans' Files blocks. (`lib/__tests__/post-install-sweep.test.ts`: L1 T27 "keep green" + L4 T9 new case → covered by row 1.)

---

## 2. Interface drift (producer → consumer)

Each item: what A produces, what B consumes, mismatch, fix (which plan/task).

1. **`GET /setup/need/<id>` reply.** L3 T9 / contract: 200 `{state:"pending"|"done"|"failed", detail}`, `POST` → 405, empty id → 400 (L3:2765-2782, 2850-2855). L1 T22 `awaitNeed`: 404 = not yet; 200 body `{ok, detail}` (L1:953-959, 963). **Fix L1 T22:** poll until `state !== "pending"`; `done` → `{ok:true, detail}`, `failed` → `{ok:false, detail}`; treat 404 as pending too (tolerant); keep "status 0 ×3 → app-gone". Contract already says this; L1 OQ1 is resolved by L3's implementation.
2. **Need types.** L1 emits `app-register-services`, `app-unregister-services`, `app-privileged {op: proxy-install | proxy-remove}` (L1:143-145); L3 handles `app-register-services`, `app-privileged/proxy-install` only (L3:2879-2891); `PrivilegedInstalling` lacks `proxyRemove` (L3:2549). **Fix L3 T8/T9**: add `proxyRemove()` (helper arg `remove`) and `app-unregister-services` → `services.unregister(plists:)` (SMAppService `unregister()`); **contract**: add both types to the `need` list.
3. **Uninstall event ids.** L1 `UninstallActionId` = `services.unregister | deck.managed-remove | proxy.remove | path.unlink | shell.remove | extension.uninstall | plugins.uninstall | data | app.trash` (L1:147); L3 stub `deck.managed`, `plugins.remove`, no `shell.remove/extension.uninstall/data` (L3:1471-1481). **Fix L3 T4** stub to L1's ids; **contract**: list the ids under `rt uninstall`.
4. **`rt uninstall` confirmation.** L1 T29: "`--delete-data` without `--yes` on non-TTY → exit 2 `confirm-required`" (L1:1126); L3 T17 streams `uninstall --keep-data|--delete-data --json` without `--yes` (L3:5091). **Fix L3 T17:** append `--yes` (the app's sheet is the confirmation). L1 T29: non-TTY + `--keep-data` needs no `--yes` (already implied; state it).
5. **`rt team create` remote spelling.** L3 T13: `["team","create",name,"--remote", useGhRepo ? "gh:\(ghRepoPreview)" : remoteURL, ("--others"), "--json"]` (L3:4270-4272); L1 T16: `--remote <url> | --create-repo <owner> [--others] [--json]` (L1:762). **Fix L3 T13** to `--create-repo <owner>` (repo name `mattstack-team-<slug>` is L1's, matches L3's preview L3:4237). L3 OQ3 closed.
6. **`rt setup github status --json` shape.** L3 T13 decodes `{status, handle, owners}` (L3:4253); L1 T12 prints `{integration, status, detail, scopesSeen}` (L1:618). **Fix L1 T12:** github status adds `handle` (`gh api user` login) and `owners` (`[handle, …gh api user/orgs[].login]`) when gh is authenticated; **contract** adds them.
7. **`rt team status --json`.** L3 T17 runs it (L3:5069) expecting `{name, slug, remote, lastPush, members}`; absent from L1 and contract. **Fix L1 T19** (add `teamStatus` in `commands/team.ts`: slug/name from `readTeamSnapshot`, remote masked is L3's job, `lastPush` = `git -C teams/<slug> log -1 --format=%cI origin/main` or null, `members` = `board.members` usernames); **contract** adds the verb.
8. **`rt settings dev-mode`.** L3 T17 `["settings","dev-mode", isDev ? "off" : "on"]` (L3:5201); real verb takes `dev|prod` and is `requiresTTY: true` (tree L682-689). **Fix L3 T17** → `["settings","dev-mode", isDevBuild ? "prod" : "dev"]`; **L1 (new micro-step in T31):** drop `requiresTTY` when a Target arg is given (prompt only when omitted).
9. **`rt setup slack create-app` stdin.** L3 T14 passes `--config-token-stdin` **and** stdin JSON `{configToken}` (L3:4509, 4526); L1 T12: flag ⇒ raw token line, no flag ⇒ JSON (L1:629). **Fix L3 T14:** drop the flag when sending JSON. (L1 may additionally accept JSON under the flag when the line parses as an object — optional hardening.)
10. **`rt team join --dry-run` failure shape.** L1 T18 returns exit 0 result `{access:"denied"|"unreachable", message}` per contract (L1:819-823); L3 stub `join-no-access` exits 2 `{error:{code:"no-access"}}` (L3:1465) and TeamChoiceModel renders the user error. **Fix L3 T4 + T13:** stub returns exit 0 `{access:"denied", message:"You don't have access yet: ask matt …"}`; model renders `access != "ok"` from the result (keep exit-2 handling for `invite-unknown`/`invite-malformed`, which L1 does throw).
11. **`mattstack.appPath` key write.** L3 T18 `rt settings set mattstack.appPath "<json string>" --scope machine` — matches the real tree (`set <Key> <Value> --scope`). ✓ No change. (Both the app and L1 `settings.seed`/L4 write the same value; harmless.)
12. **`GET /version.build` type.** Contract: `"build": 2080` (number); L4: CFBundleVersion = `major*1e6+minor*1e3+patch` → `2008000` (L4:23, OQ2); L3 T9/T18 emits `build: CFBundleVersion ?? "0"` as a **string** (L3:5759); stub `"build": "0"` (L3:1485). L7 asserts only `version` (L7:1329). **Fix contract** example → `"build": 2008000`; **L3 T9/T18**: `build: Int(CFBundleVersion) ?? 0`; stub `build: 0`.
13. **Sparkle feed URL / interval.** L3 `https://m4ttstack.github.io/rt/appcast.xml`, 86400 (L3:633-644, 735-742); L4 `…/releases/latest/download/appcast.xml`, 21600 (L4:947, 1127; check-bundle L4:1348). **Fix L3 T2** (Info.plist + project.yml) to L4's values, subject to §4 #1.
14. **`MATTSTACK_APPCAST_URL`.** L3 honours it only when `MSDevBuild` is true **or** launched with `--allow-appcast-override` (L3:3028, 3074-3086); L7 launches the **prod** app with `open --env MATTSTACK_APPCAST_URL=…` and no arg (L7:899-901, 1606) → ignored. Also the FDA step relaunches the app (L7:1204-1208) and the env may not survive. **Fix L7 T5/T8:** `open --env MATTSTACK_APPCAST_URL=… --args --allow-appcast-override` and re-apply on every launch the driver performs; **L3 T18:** the self-relaunch after FDA re-execs with the current `ProcessInfo.arguments` + environment (state it).
15. **Agent plist set.** L1 `servicePlists(mode)` = `[com.mattstack.daemon[.dev].plist, com.mattstack.deck[.dev].plist]` (L1:951-952); L3 registers whatever is in `Contents/Library/LaunchAgents` and `services.register` is `ok` only if **every** requested plist registers (L3:2879-2891, 2946-2950); L4 bundles only the daemon plist (L4:55) and `deck` is `pending` (L4:54) → deck plist (L3) registers a missing `Contents/Helpers/deck` → `.notFound`/error → step fails. **Fix:** L4 T4 bundles both plists (row 13/17); **L1 T22/T25**: request the deck plist only when `resolveTool(p,"deck").chosen` is non-null (log "deck not bundled yet — not registered"); **L3 T7**: a plist whose `BundleProgram` does not exist registers as `notFound` and is reported `ok:false, status:"notFound"` — L1 then decides; keep.
16. **Bundle layout / helper exec.** L4 T1: `Helpers/node/bin/node`, `Helpers/fast-browser/bin/fast-browser.mjs`, `bundledExec("fast-browser") = [node, mjs]`, `bundledHelperPath(name)` from deps.lock (L4:52-53, 297-318); L1 T5: `HELPER_TOOLS` flat files incl. `node`, `fast-browser`; `bundledToolPath`; `link()` symlink only; T8 `tool.fast-browser` execs `<chosen> doctor --json`; T21 `setupTool("fast-browser")` execs `[chosen, "setup"]`. **Fix L1 T5/T8/T21** (§5 #4-#6): `ToolResolution.exec: string[] | null`; symlink for single-file tools, **tagged wrapper** for multi-argv tools; `isOurLink` recognises both; rows/steps spawn `[...exec, "doctor","--json"]`.
17. **`~/.local/bin/rt` install.** L4 T9 `installRtBinary(src)` = atomic symlink (L4:1953-1961); L1 T5 `link(p,"rt")` = `p.symlink` + "dev-mode-owns-rt" refusal (L1:404-405). **Fix L1 T5:** `link("rt")` calls `installRtBinary(target)`.
18. **AX identifiers** (L7 → L3): see Top #7. **Fix L7 T6** with the mapping in §5 #30. Row ids used by L7: `perm.loginItems` → L1's `perm.login-items` (L1:433); `account.github`, `perm.fda`, `perm.notifications`, `tool.clt` ✓.
19. **Stub row ids vs real ids.** L3 stub `perm.loginItems`, `access.teamRepo`, `tool.fastbrowser`, `info.path` (L3:1368-1393) vs L1 `perm.login-items`, `access.team-repo`, `tool.fast-browser`, `tool.path` (L1:433-444, 492, 532). **Fix L3 T4** (XCUITest uses only `perm.fda`, unaffected).
20. **Stub env.** Contract names only `RT_STUB_SCENARIO`; L3 requires `RT_STUB_PATH` (absolute path to `stub.ts`), optional `RT_STUB_BUN` (default `~/.bun/bin/bun`), `RT_STUB_STATE_DIR` (L3:1203-1207, 1247); L7 knows PATH/BUN (L7:55). **Fix contract** §Stub: list all four.
21. **`--post-install` flags.** L1 T27: `runPostInstall(args)` = sweep → `setupApply(["--non-interactive","--team-of-one", ...args])`; `--no-launch` implied by `--ci`/`CI=true` (L1:1073-1080); L4 T8 (via L7) passes `--post-install --non-interactive --team-of-one --no-launch` (L4:30, 1784) ✓; L7 T12 passes only `--post-install $PIA` with `--post-install-args` (L7:1925) and `CI=true` (L7:1921). Works (CI implies no-launch) but **fix L7 T12** to default `PIA="--non-interactive --team-of-one --no-launch"`.
22. **`scripts/e2e-cleanroom.sh` invocation.** L4 T8: `scripts/e2e-cleanroom.sh "$(ls … mattstack-*.zip | head -1)"` positional (L4:1781); L7 T12 usage `(--artifact <tar.gz|zip> | --tag <vX.Y.Z> | --app <app>)` (L7:1872); `--tag` downloads `rt-darwin-arm64-*.tar.gz` (L7:1901-1902, dropped by L4); extracts a bare `rt` or `Contents/MacOS/rt-daemon` fallbacks (L7:1914-1917). **Fix L7 T12:** accept a single positional path as `--artifact`; `--tag` downloads `mattstack-*.zip`; drop tarball/`rt-daemon` branches; after `ditto -x -k` the app root is `<work>/release/mattstack.app` and rt is `…/Contents/MacOS/rt`; also run `rt-tray/check-bundle.sh --app` only if present (L4's sparse checkout is `scripts` only — L4 T8 may widen to `scripts rt-tray`).
23. **`rt daemon install` in the headless recipe.** L7 T12 runs it after `--post-install` (L7:1927); under L1, `services.register` is skipped honestly when no app is reachable (`no-app` + non-interactive, L1:1030), so `daemon.json` is absent and `rt daemon install` (existing verb) is what writes it. Consistent; keep, but L7 must not assert daemon running in CI (it doesn't: `rt verify --ci` warns).
24. **`rt verify --json` shape.** L7 greps `"passed": *true` and per-check `"status"`/`"name"` (L7:1317-1321); L1 T11 keeps `{passed, summary, checks}` and adds `plan` (L1:600) ✓.
25. **Artifact names.** L4 `mattstack-<version>.dmg/.zip`, `appcast.xml`, `*.delta`, `SHA256SUMS` (L4:19, 1578); L7 expects `mattstack-<ver>.dmg/.zip` ✓ but its README/usage still say `rt-darwin-arm64-*.tar.gz` (L7:1840, 1942-1943, 1779). **Fix L7 T11/T12/T14** wording → zip.
26. **`SPARKLE_PUBLIC_ED_KEY` override**: L4 build.sh honours it (L4:897, 1122-1136) ✓ L7 (L7:54, 718) ✓.
27. **CFBundleVersion bump in L7 `make-appcast.sh`** takes an arbitrary `<new-build>` (L7:586, 734); must follow L4's numeric scheme to stay monotonic for Sparkle. **Fix L7 T3:** compute `new-build` from `<new-version>` with L4's formula (drop the arg).
28. **`mattstack-proxy-install` helper.** L3 T8 runs `Contents/Helpers/mattstack-proxy-install install`, expects `MATTSTACK_EXIT=<n>` trailer (L3:2558, 2585, 2645); L4 deps.lock has no row and no build step (L4 bundle contract L4:45-59); L1 `proxy.install` only waits (L1:1031). **Gap:** nobody builds it. **Fix L4 T2:** add a `status:"pending"` deps.lock row `mattstack-proxy-install` (`bundlePath: Contents/Helpers/mattstack-proxy-install`, `exec` likewise) so check-bundle tolerates absence and L3 reports "helper not bundled" honestly until L5 ships it; record in L5's handoff.
29. **Agent plist `EnvironmentVariables.PATH`.** L3 template `/usr/bin:/bin:/usr/sbin:/sbin` + "rt and deck prepend their own bundle" (L3:574-577); L4 build.sh `/Applications/$APP_NAME.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin` (L4:1102-1103; asserted L4:1251) — wrong under `~/Applications` and wrong for the dev bundle; L4:1215 "`~/.local/bin` for herdr/claude is appended by L1's service plists" — L1 has no such plists. Spec §7: `PATH=<app>/Contents/Helpers:/usr/bin:/bin` + `~/.local/bin`. **RULING NEEDED** (§4 #3). Recommended: plist PATH stays static (`/usr/bin:/bin:/usr/sbin:/sbin`), and the daemon (L1, `lib/daemon.ts` boot) and deck prepend `<appBundleRoot()>/Contents/Helpers` and `$HOME/.local/bin` to `process.env.PATH` at boot (Bun PATH-snapshot gotcha: children spawned with `env: process.env` inherit it). L4 check-bundle then asserts the static value.
30. **KeepAlive prod.** L3 render script: dict `SuccessfulExit=false` both flavors (L3:557-558) = spec §8; L4 build.sh prod `bool true` (L4:1098) + check-bundle (L4:789). **Fix L4 T3/T4** to the dict.
31. **`rt home init` / `rt restore` flags** (settings lane → L3/L1): L3 T13 runs `home init --dry-run --json` (L3:4297) and `restore <repo> --dry-run --json` with stdin `{"ageKey"}` (L3:4286-4287); L1 T24 `home.init` runs `rt home init` (gh only; OQ6 asks for `--remote <url>`); L1 T25 `home.restore` never runs restore. The settings-lane verbs (`rt home init [--dry-run]`, `rt restore <org>/<repo>`) have no documented `--json`, no `--remote`, no stdin key. **Dependency to confirm when main lands**; see §5 #17 for the restore ownership ruling.

---

## 3. Execution order

Four worktrees, each off `origin/main` **after** (a) the settings lane's
overnight merge and (b) the appspec docs branch is merged (row 27). Concurrency
below is safe because the file sets are disjoint after the §1 rulings.

**Phase A — substrate (parallel, no cross-file overlap):**
- L4 T1 (`lib/bundle-layout.ts`), T2 (`deps.lock`, `fetch-deps.sh`, `.gitignore` minus the xcodeproj line), T6 (`scripts/release/*`), T7 (MATT key), T9-trimmed (`lib/dev-mode.ts`, `lib/rt-paths.ts` + tests only), T11-trimmed (`lib/fzf.ts`, `lib/notifier.ts` + tests), T3-trimmed (`commands/settings.ts`, `dev-mode-handoff.test.ts`, `scripts/entitlements.plist`, `check-bundle.sh` rewrite carrying L3's assertions).
- L3 T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11 (all inside `rt-tray/`, `Sources-core/`, `Tests/`), with T4 stub ids/shapes corrected per §5.
- L1 T1, T2, T3, T4, T6, T9, T13, T14, T15, T16(ex-`--create-repo` unchanged), T17, T18, T19 (pure new files + tree/registry).
- L7 T1, T2, T4, T5, T7, T9, T10, T11, T14 (all `rt-tray/vm/`), T3 (own recipes; re-point later).

**Phase B — dependent (mandatory rebases):**
- **L1 T5** after L4 T1 + T9 merged (consume `appBundleRoot`, `bundledHelperPath`, `bundledExec`, `installRtBinary`, `installedTrayAppPath`).
- **L1 T7, T8, T10, T11, T21** after L1 T5 and L4 T11 (`resolveFzf`); L1 T11 (verify rewrite) after L4's verify.ts edit is **dropped** (row 3) — no rebase then.
- **L1 T22** after the contract amendment for `/setup/need` (§5 #1) — or simply implement per L3 T9 now.
- **L1 T24, T27** after L4 T9-trimmed (for `bundleRootFromExec`, `installRtBinary`, `legacyUserAppPath`) — L1 T27 absorbs L4's post-install bodies (row 1).
- **L1 T30** (update.ts) independent once L4 T10 is dropped.
- **L4 T4, T5** after **L3 T1 + T2 + T10 merged** (Package.swift/Sparkle/templates/render script are L3's) — mandatory; L4 T5's "skip if L3 has" becomes "requires".
- **L4 T8** any time (calls L7's script by contract); green only after L7 T12 and the §5 #34 CLI fix.
- **L4 T12** (README/docs) after L1 T30/T31 for `update.mdx`; L1 T31 after L4 T12 (row 5). Sequence: L4 T12 → L1 T31.
- **L3 T12–T18** (screens, Settings, AppDelegate) after L3 T1–T11; **L3 T13/T14/T17** implement the §5 argv fixes (#15-#21); **L3 T18** carries L4's Swift string edits (row 18).
- **L7 T6** after L3 T12–T16 (AXIDs exist) — or edit ids now from L3:3714-3779 (§5 #30) and keep "fail fast on missing id"; **L7 T8** after L3 T10 (`--allow-appcast-override`) ; **L7 T3** re-point after L4 T6; **L7 T12** after agreeing the CLI with L4 T8; **L7 T13** after Xcode (and L3 T19).

**Phase C — orchestrator/MATT gates:** L4 T13 (entitlements), T14 (Xcode cutover, after L3 T2 `project.yml`), L3 T20, L1 T33, L7 goldens/real runs, L4 T15 (dry run → tag; clean-room green requires L7 T12 + L1 T27's `--no-launch`).

**Merge order to main (recommended):** L4-phase-A → L3 (T1–T11) → L1 (T1–T4, T6, T9, T13–T19) → L4 T4/T5/T8 → L1 T5, T7–T12, T20–T30 → L3 T12–T19 → L7 (all) → L4 T12 → L1 T31–T32 → MATT gates. Every lane rebases onto `origin/main` before each merge (only L1 states this today; add the rule to L3/L4/L7 headers).

**Settings-lane dependencies (flag; not yet on main at plan time):**
- `rt.cron` machine key migration — L1 T20 `installCronTrigger` guards `isMigrated` ✓ (honest `written:false`).
- `rt home init --remote <url>` (L1 OQ6) — wizard's "paste a URL" home-repo path has no verb; L3 T13 only dry-runs `home init`. Needs the settings lane (or L1 T24 passes `--remote` when the tree has it).
- `rt restore <org>/<repo>` with `--json` + key on stdin (`{"ageKey"}` per L3:4287 or `--key-stdin`) — L3 T13 and the §5 #17 ruling depend on it.
- `rt home snapshot push` — L1 T26 falls back to `git add/commit/push` when absent ✓.
- `board.triage` key — L1 T25 guards `getDef` ✓; `board.members` entry shape (L1 OQ7).
- `claude.marketplaces`/`claude.plugins`, `mattstack.appPath`, `mattstack.integrations`, `mattstack.tracking` — landed (registry PR #5); L1 T9/T26 read them ✓; `installedTrayAppPath` already reads `mattstack.appPath` ✓.
- `rt settings dev-mode` `requiresTTY` (§2 #8) — small rt change, assign to L1 T31.

---

## 4. Spec drift (plan vs spec/contract)

1. **Appcast host.** Spec §11: "publishes the appcast to GitHub Pages". L4 Decision 1: GitHub Release asset at `…/releases/latest/download/appcast.xml` (L4:36, 947) with gh-pages as fallback (OQ1). L3 still encodes github.io. **RULING NEEDED** (recommend accept L4; amend spec §11 + L3 T2).
2. **`rt-darwin-*.tar.gz`.** Spec §11: "remains as the internal headless artifact (a zip of the app is equivalent…)". L4 Decision 2 drops it (zip is the headless artifact). Acceptable; L7 T12/T11/T14 must switch to the zip (§2 #22, #25).
3. **Agent plist PATH.** Spec §7/§8: explicit `<app>/Contents/Helpers:/usr/bin:/bin` + `~/.local/bin`; L3 ships a static PATH and defers to the programs; L4 hardcodes `/Applications`; neither adds `~/.local/bin`. **RULING NEEDED** (§2 #29 recommendation).
4. **KeepAlive.** Spec §8 `{SuccessfulExit:false}`; L4 prod `true` (L4:1098, 789). Fix L4.
5. **`xcodebuild archive/export`.** Spec §11; L4 Decision 3 uses `xcodebuild build … CODE_SIGNING_ALLOWED=NO` + own inside-out signing. Acceptable; note in spec.
6. **Restore ceremony.** Spec §4.2: the restore card "`rt restore <org>/<repo>` clones it to `~/.mattstack`, installs the key in the Keychain, and materializes". L3 only dry-runs; L1 `home.restore` only verifies. Gap (Top #8). **RULING NEEDED**: recommend L3 runs the real `rt restore` at Continue (key on stdin) then `rt setup intent restore <org>/<repo>`; L1 `home.restore` stays a verifier.
7. **First-run auto-setup.** Spec §11: `rt --post-install` is the headless entry; spec is silent on `cli.ts` auto-running it. L1 T10 replaces the silent auto-install with a one-line hint (L1 OQ9) because the new apply creates GitHub repos. Behaviour change for `rt verify`-after-install; accept and note in docs (L4 T12 README "Testing the installer" must not promise auto-setup).
8. **Invite code length.** Spec §6.3 "~40 chars"; contract + L1 77 chars (16-byte id ‖ 32-byte key). Contract wins; fix spec §6.3 wording (L1 OQ2 stays a UX question for Matt).
9. **`GET /version.build`.** Contract example `2080` vs L4's scheme `2008000` (L4 OQ2). Fix contract example (§5 #11).
10. **Clean-room layer (b) driver.** Spec §12.2 "drives XCUITest for the five screens"; L7 drives AppleScript UI scripting first, XCUITest gated on Xcode (L7 T6/T13). Acceptable deviation; note in spec §12.2.
11. **Team-of-one headless defaults** (L1 OQ11: `RT_TEAM_NAME`/`RT_TEAM_REMOTE`, gh-created `<login>/mattstack-team-personal`) — spec silent; the clean-room runner has no gh auth, so L1 T24 `team.create` will fail `remote-required` in CI unless `--team-of-one` tolerates "no remote yet" (skip team.create with detail) — **amend L1 T24** (§5 #10).
12. **Contract `action.type` list** in spec §5.2 (`use-gh`, `none`) differs from the contract file (`link-bundled`, `oauth`, `owner-once`, `steps`, `run`); L1/L3 follow the contract ✓; fix spec §5.2 text.
13. **L3 `SUScheduledCheckInterval` 86400 vs L4 21600** — spec silent; take L4's (check-bundle asserts it).
14. **Dev flavor bundles Helpers** (L4 OQ5) — spec silent; fine.
15. **L3 Done screen** shows the `verify` step's detail rather than running `rt verify` (L3:4953-4957) — spec §4.5 "verify summary (N checks)" satisfied by the step detail "N checks passed" (L1:1055) ✓.

---

## 5. Concrete amendments (apply mechanically; plan + task + change)

**L1 — `plans/2026-08-21-rt-setup-verbs.md`**
1. **T22** `awaitNeed`: replace "(404 = not yet)" and `NeedReply` polling with: GET returns 200 `{state, detail}`; `pending` (or 404) → keep polling; `done` → `{ok:true, detail}`; `failed` → `{ok:false, detail}`; test: "200 `{state:"pending"}` twice then `{state:"done", detail:"registered"}` → reply". Update the docblock at L1:954-957.
2. **T22** `servicePlists` / **T25** `services.register`: request `com.mattstack.deck[.dev].plist` only when `resolveTool(p,"deck").chosen` is non-null; else log "deck not bundled yet — only the daemon is registered".
3. **T1** `NeedRequest`: keep both uninstall types; add a sentence "L3 NeedBroker must handle `app-unregister-services` and `op:"proxy-remove"`" (tracked in §5 #12-13).
4. **T5** `lib/deps/resolve.ts`: drop `HELPER_TOOLS`; `appBundlePath(p)` → returns `appBundleRoot()` (`lib/bundle-layout.ts`); `bundledToolPath(p,tool)` → `tool === "rt" ? join(root, RT_BUNDLE_PATH) : bundledHelperPath(tool, root, p.exists)`; add `bundledToolExec(p,tool): string[]|null` → `bundledExec(tool, root, p.exists)`; `ToolResolution` gains `exec: string[] | null` (`bundled` stays the first exec entry/path for display). Mark T5 "after L4 T1 + T9".
5. **T5** `lib/deps/links.ts`: `link()` — if `exec.length === 1` symlink (for `rt` via `installRtBinary(target)`); else write a tagged wrapper `#!/bin/sh\n# mattstack-link: <tool>\nexec "<exec0>" "<exec1…>" "$@"\n` (0755); `isOurLink` = symlink into the bundle **or** regular file whose second line starts with `# mattstack-link:`; `unlink`/`reconcile` honour both. Tests: fast-browser link writes the wrapper; `isOurLink` true for it.
6. **T8** `tool.fast-browser` and **T21** `setupTool("fast-browser")` / **T26** `fastbrowser.setup`: spawn `[...resolveTool(p,"fast-browser").exec, "doctor","--json"]` / `[..., "setup"]` (no `chosen` as argv0).
7. **T7** rt-health table: add rows `tool.rt-link` (required:false, prod only: `p.readlink(~/.local/bin/rt) === join(appBundlePath,"Contents/MacOS/rt")` → ready "linked into the bundle"; else needs-you "not a link into mattstack.app — run: rt setup apply --from path.link") and `tool.vsix` (required:false: `<app>/Contents/Resources/rt-context.vsix` exists → ready; missing → skipped "extension not bundled (pre-bundle build)"); `tool.fzf` detail from `resolveFzf()` → "fzf <v> (bundled|PATH)".
8. **T12** github `integrationStatus`: when gh is authenticated add `handle` (`gh api user` → `.login`) and `owners: [handle, ...(gh api user/orgs → .login)]` to the envelope; doc in the contract.
9. **T19** (or T16): add `teamStatus(args)` → `rt team status [--team <slug>] --json` → `envelope({slug, name, remote, lastPush, members:[{username}]})`; tree node `team.status`.
10. **T24** `team.create` under `teamOfOne` with no gh auth and no `RT_TEAM_REMOTE`: skipped "no git remote available (set RT_TEAM_REMOTE or run gh auth login)" instead of failed, so the headless clean-room job passes `verify`.
11. **T24** `settings.seed`: derive `appPath` with `bundleRootFromExec()` (L4 T1); refuse `/Volumes/`/`AppTranslocation` paths (exit 2 in `--post-install`, failed step with remedy in apply) — port L4:1993-2006.
12. **T27** `commands/post-install.ts`: signature `runPostInstall(args: string[], opts: { bundleRoot?: string | null } = {})`; adopt L4's `runLegacySweep(root)` body (L4:2064-2092) and the new sweep test case (L4:1928-1937); `recordAppPath`/`installRtBinaryStep` are NOT re-implemented here (they are `settings.seed`/`path.link` steps) — note that `rt --post-install` on a non-bundle `dist/rt` takes the "not running from inside the app" branches.
13. **T29** `commands/uninstall.ts`: state "non-TTY + `--keep-data` needs no `--yes`; `--delete-data` needs `--yes` (the app passes it)".
14. **T30** `runUpdate`: adopt L4's injectable `deps` (`tray`, `currentMode`, `log`, `exit`) and add the `res.ok === false` branch ("this mattstack.app can't be asked from the CLI — use the menu bar"); exit codes stay 2/`--json` per contract; `RELEASES_URL = https://github.com/m4ttstack/rt/releases/latest`.
15. **T31**: remove the README edit; add: `rt settings dev-mode <dev|prod>` drops `requiresTTY` when Target is given; regenerate docs **after** L4 T12 merges.
16. **T13**: the contract paragraph ("Team-scope secrets layout") is applied in the appspec branch, not committed from the L1 worktree; T13 references it.
17. **T25** `home.restore` — keep as verifier; add: "L3 runs the real `rt restore` (key on stdin) at screen 2 and then `rt setup intent restore <org>/<repo>`; this step verifies clone + key" (**pending Matt's ruling**, §4 #6).
18. **Global constraints**: add "rebase onto `origin/main` after L4 T1/T9/T11 merge before starting T5/T7/T24/T27" and "do not edit `commands/verify.ts`/`update.ts`/`cli.ts`/`README.md` from any other lane" (mirrors §1).
19. **T10** cli.ts skip-list: also skip the first-run hint when `args[0] === "--post-install"` (it is already, via the earlier branch) — no change; state it.

**L3 — `plans/2026-08-21-mattstack-app-shell.md`**
20. **T0 Step 2**: drop (spec/contract are merged to main first).
21. **T2** Info.plist + project.yml: `SUFeedURL = https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml`; `SUScheduledCheckInterval = 21600`; keep `CFBundleURLName @@BUNDLE_ID@@.join` (L4 drops `.url`); note "build.sh (L4) overwrites SU* values with `Set`".
22. **T2** LaunchAgent.plist template: also apply `BundleProgram Contents/MacOS/rt`, `ProgramArguments [Contents/MacOS/rt, --daemon]`, Label comment (from L4 T3 L4:624-635). PATH value per §4 #3 ruling.
23. **T4** stub: uninstall ids → `services.unregister, deck.managed-remove, proxy.remove, path.unlink, shell.remove, extension.uninstall, plugins.uninstall, data (only with --delete-data), app.trash`; row ids `perm.login-items`, `access.team-repo`, `tool.fast-browser`, `tool.path` (kind `info`); `team join --dry-run` no-access → exit 0 `{access:"denied", message}`; `version` → `build: 0` (number); `team status --json` and `setup github status --json` (`{status, handle, owners}`) canned answers; `uninstall` requires `--yes` with `--delete-data`.
24. **T8**: `PrivilegedInstalling` gains `proxyRemove()` (helper arg `remove`); **T9** NeedBroker: `app-unregister-services` → `services.unregister(plists:)`; `app-privileged op:"proxy-remove"` → `privileged.proxyRemove()`; `GET /version` → `build: Int(CFBundleVersion) ?? 0`.
25. **T9/T18**: preserve L4's check-bundle source gates (`forInfoDictionaryKey: "MSDaemonLabel"`, `defaultDaemonLabel = "com.mattstack.daemon"`, literal `path == "/flavor/retire"` in TrayServer, socket guard before `AppDelegate()` in `main.swift`).
26. **T10**: label the build.sh stopgap "deleted by L4 T4's rewrite; L4 T4 must call `scripts/render-launchagents.sh`"; drop the check-bundle edit if L4 T3 has merged (else L4 absorbs); **UpdaterController**: the post-FDA self-relaunch re-execs with current arguments + environment (so `--allow-appcast-override`/`MATTSTACK_APPCAST_URL` survive).
27. **T13**: create → `["team","create",name] + (useGhRepo ? ["--create-repo", owner] : ["--remote", remoteURL]) + (others ? ["--others"] : []) + ["--json"]`; restore → real `["restore", repo, "--json"]` with stdin `{"ageKey"}` then `["setup","intent","restore", repo, "--json"]` (pending §4 #6; dry-run only if the settings lane ships `--dry-run --json`).
28. **T14**: owner-once → `["setup", integration, "create-app", "--json"]` with stdin `{"configToken"}` (drop `--config-token-stdin`).
29. **T17**: uninstall stream → `["uninstall", keepData ? "--keep-data" : "--delete-data", "--yes", "--json"]`; dev-mode → `["settings","dev-mode", isDevBuild ? "prod" : "dev"]`; Team pane uses `rt team status --json` (now defined, §5 #9).
30. **T18**: add L4 T3's Swift edits (`AppDelegate.swift:331` → `Contents/MacOS/rt`; `DaemonLifecycle.swift:8,17-18`; `Sources-daemon-shim/main.swift:4,26`). 
31. **Header**: add "rebase onto `origin/main` before each merge; `build.sh`/`check-bundle.sh` are L4's after T10; `Package.swift`, templates, `project.yml`, `Sources/**` are L3's".

**L4 — `plans/2026-08-21-release-pipeline.md`**
32. **T2**: `.gitignore` — drop `rt-tray/*.xcodeproj/` (L3 T1 adds it); add a `status:"pending"` deps.lock row `mattstack-proxy-install` (`bundlePath`/`exec` `Contents/Helpers/mattstack-proxy-install`, `entitlements:"none"`, `exposeByDefault:false`).
33. **T3**: drop edits to `rt-tray/Package.swift`, `rt-tray/Info.plist`, `rt-tray/LaunchAgent.plist`, the four Swift files; keep `commands/settings.ts`, `dev-mode-handoff.test.ts`, `scripts/entitlements.plist`, `build.sh` minimal, `check-bundle.sh` rewrite — and in the rewrite: KeepAlive `SuccessfulExit=false` both flavors (replace L4:789-790), add the L3 assertions (`UpdatePolicy.shouldStartUpdater(isDevBuild: isDevBuild` grep in `Sources/Updates/UpdaterController.swift`; `assert_bin_has "silent dev updater" "update check skipped (dev build)"`), add a deck-plist assertion, make the PATH assertion match §4 #3.
34. **T4** build.sh: replace L4:1093-1104 with `"$SCRIPT_DIR/scripts/render-launchagents.sh" "$([ "$IS_DEV" = true ] && echo dev || echo prod)" "$CONTENTS/Library/LaunchAgents"` (both plists, KeepAlive from the script); Info.plist SU*/`LSMinimumSystemVersion`/`CFBundleURLTypes` writes use `Set` (with create-if-missing); `SU_FEED_URL` unchanged; state "requires L3 T1/T2/T10 merged".
35. **T5**: drop the Package.swift/Package.resolved edit; keep `check_sparkle`; "requires L3 T10 merged".
36. **T8**: `scripts/e2e-cleanroom.sh --artifact "<zip>"` (or keep positional and L7 accepts it — pick one; recommended: L7 accepts positional); optionally `sparse-checkout: scripts rt-tray` so the script can run `check-bundle.sh --app`.
37. **T9**: drop `commands/post-install.ts` and `lib/__tests__/post-install-sweep.test.ts` from Files (bodies move to L1 T24/T27 per §5 #11-12); keep `lib/dev-mode.ts`, `lib/rt-paths.ts` + tests; "Produces: post-install exit 2 on DMG path" moves to L1.
38. **T10**: drop entirely (L1 T30 owns `commands/update.ts`; L1 T10 owns `cli.ts`).
39. **T11**: drop the `commands/verify.ts` edit (L1 T7 carries the rows); keep `lib/fzf.ts`, `lib/notifier.ts`; note `e2e/tests/verify.test.ts` unaffected.
40. **T12**: README "Testing the installer" must describe `rt --post-install` = headless `rt setup apply --non-interactive --team-of-one` (no auto-setup on first `rt` run); regenerate `update.mdx` after L1 T30; `release-workflow.test.ts` — add `yaml` to devDependencies (or parse with Bun's YAML) — state it.
41. **OQ2/OQ7/OQ8**: close per above (contract example → 2008000; L3 regenerates the project; L3 ships the deck plist, L4 copies it).
42. **Header**: add "rebase onto `origin/main` before each merge; T4/T5 after L3 T1/T2/T10".

**L7 — `plans/2026-08-21-clean-room-vm.md`**
43. **T6** `ax.sh`/`drive-setup.sh` id mapping (L3 `AccessibilityIDs.swift`, L3:3714-3779): `setup.window` → `setup.welcome.screen` (and per-screen `setup.<screen>.screen` for waits); `setup.continue` → `setup.<screen>.continue` (`welcome|team|checklist|install|done`); `setup.install` → `setup.checklist.continue`; `setup.finish` → `setup.done.continue`; `setup.card.create|join` → `setup.team.card.create|join`; `setup.field.teamName` → `setup.team.create.name`; `setup.field.inviteCode` → `setup.team.join.code`; `row.<id>` / `.action` / `.status` → `setup.checklist.row.<id>[.action|.status]`; `connect.field.token` → `setup.checklist.connect.field.token`; `connect.submit` → `setup.checklist.connect.submit`; FDA relaunch button → `setup.checklist.relaunch`; install failure → presence of `setup.install.retry` (+ `setup.install.step.<id>.status`); row ids: `perm.loginItems` → `perm.login-items`. Update the L55 table accordingly.
44. **T5/T8**: launch the prod app with `open --env MATTSTACK_APPCAST_URL=http://127.0.0.1:8765/appcast.xml --args --allow-appcast-override "$APP"` and repeat the env/arg on any driver-initiated relaunch; `trigger-update.sh` asserts `/version.version` (as today) and may also assert `build` equals L4's numeric value.
45. **T3** `make-appcast.sh`: compute `<new-build>` from `<new-version>` with `major*1000000+minor*1000+patch` (drop the arg); when `scripts/release/make-zip.sh`/`make-dmg.sh` exist, call them for the zip/DMG (keep the loopback `generate_appcast` call local).
46. **T12** `scripts/e2e-cleanroom.sh`: accept a positional `<zip|dmg|app>` as `--artifact`; `--tag` downloads `mattstack-*.zip` (`gh release download <tag> -R m4ttstack/rt -p 'mattstack-*.zip'`); `ditto -x -k` → `<work>/release/mattstack.app/Contents/MacOS/rt`; delete the tarball and `rt-daemon` branches; default `--post-install-args "--non-interactive --team-of-one --no-launch"`; keep `CI=true`, `rt daemon install`, `rt verify --ci`; README section and `second-user.sh` usage text say zip.
47. **T13** Files: list `golden/build-golden.sh`, `golden/provision-guest.sh`, `golden/verify-golden.sh`.
48. **T7** `assert-installed.sh`: add `curl --unix-socket … /services` (daemon + deck status) and `/permissions` (the plan's L24/L322 promise), and `rt settings get mattstack.appPath --scope machine` equals `/Applications/mattstack.app`.
49. **Header/OQ1**: replace "not yet in the L3 plan" with the L3 AXID list; rebase statement.

**Contract — `specs/2026-08-21-rt-setup-contract.md`** (apply in the appspec branch)
50. `GET /setup/need/<id>` → state it is always 200 `{state, detail}` (`pending` for unknown ids), POST → 405; rt polls until `done|failed`.
51. `need.request.type` list: add `app-unregister-services {plists}` and `app-privileged {op: "proxy-install" | "proxy-remove"}`.
52. `rt uninstall`: list action ids (`services.unregister, deck.managed-remove, proxy.remove, path.unlink, shell.remove, extension.uninstall, plugins.uninstall, data, app.trash`); add `--yes`.
53. `GET /version` example `"build": 2008000` (numeric CFBundleVersion = `major*1e6+minor*1e3+patch`).
54. Add `rt team status --json` → `{contract, slug, name, remote, lastPush, members:[{username}]}` and `rt setup github status --json` extra fields `handle`, `owners`.
55. `rt team create` flags: `--remote <url> | --create-repo <owner> [--others]`; `rt setup intent restore <org>/<repo>`; `rt restore` key on stdin `{"ageKey"}` (pending settings lane).
56. Stub: `RT_STUB_SCENARIO`, `RT_STUB_PATH` (required), `RT_STUB_BUN`, `RT_STUB_STATE_DIR`.
57. Team-scope secrets layout paragraph from L1 T13 (`teams/<slug>/.sops.yaml`, `teams/<slug>/mattstack/secrets/<domain>.json`, domains `board`/`rt`).
58. Apply step `services.register` plists: "daemon always; deck when bundled".

**Spec — `specs/2026-08-20-mattstack-app-installer-design.md`** (after Matt's rulings)
59. §11 appcast host; §7/§8 plist PATH; §6.3 code length; §5.2 `action.type` list; §12.2(b) UI-scripting driver; §11 tarball sentence.

---

## Rulings needed from Matt (blocking the corresponding amendments)

- **R1** Appcast host: GitHub Release asset (L4) vs GitHub Pages (spec). → affects #21, #34, spec §11.
- **R2** Agent plist PATH: static + programs prepend (L3) vs hardcoded Helpers dir (L4) vs spec wording; who adds `~/.local/bin`. → #22, #33, #34.
- **R3** Restore ownership: the app runs the real `rt restore` at screen 2 (recommended) vs L1 apply step. → #17, #27.
- **R4** `rt update` exit code: 2 + `--json` (contract, L1) vs 1 (L4). Recommended L1. → #14, #38.
- **R5** Invite code length 77 (contract/L1) vs "~40" (spec §6.3 UX). Recommended keep 77.
