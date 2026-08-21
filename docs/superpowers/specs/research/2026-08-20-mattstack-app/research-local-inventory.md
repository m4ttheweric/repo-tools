# Local inventory — tray app + suite install mechanics (2026-08-20 14:44)

## mattstack.app today (repo-tools/rt-tray)
- ~4.5k lines Swift, AppKit shell (accessory app, NSStatusItem, NSPopover/NSWindow, NSMenu, NSOutlineView) hosting SwiftUI (ProcessPanelView, KeyboardConflictView). NO onboarding/permissions/wizard UI. Package.swift: tools 5.9, macOS 13+, no external deps, targets rt-tray + rt-daemon-shim.
- Files: main.swift (socket guard before SMAppService), AppDelegate (590: menu bar "m"+dev mark+health dot, polling 10s/30s, notifications setup, autoRegisterLoginItem, daemon start), TrayServer (352: unix-socket HTTP at ~/.mattstack/rt/tray.sock: POST /notify, GET /health, POST /daemon/start|stop|restart, POST /flavor/retire, GET /daemon/status), DaemonLifecycle (89: SMAppService.agent(plistName), kickstart), BundleFlavor (MSDaemonLabel/MSDevBuild, login-item opt-out), UpdateChecker (200: polls GitHub latest; alert "run rt update"; no self-update), TrayLog, NotificationManager (388: UN auth, categories, sounds via NSSound), DaemonClient (HTTP :9401 then rt.sock), TrayState, ProcessPanel{View,Controller,Data}, ProcessOutlineView (976), HerdrBridge, MissionControlCheck, KeyboardConflictView, shim main.swift (exit 0 unconfigured / 70 failure).
- build.sh (345): modes debug|release|dev|install; identity vars; swift build; icons via make-icon.swift (+amber dev); afconvert sounds; embed daemon (prod: RT_DAEMON_BIN ∥ dist/rt, rejects non-Mach-O; dev: shim); LaunchAgent plist templating (@@DAEMON_LABEL@@/@@BUNDLE_ID@@, KeepAlive prod true / dev SuccessfulExit=false); Info.plist templating + MSDevBuild + version from git describe; signing inside-out (Developer ID if present else ad-hoc; daemon w/ scripts/entitlements.plist = JIT, unsigned-exec-mem, disable-exec-page-protection, dyld-env, disable-library-validation); install mode pkill+cp+open. No notarization locally (CI only).
- Info.plist: LSUIElement true, LSMinimumSystemVersion 13.0, MSDaemonLabel, no usage-description keys. LaunchAgent: BundleProgram Contents/MacOS/rt-daemon --daemon, AssociatedBundleIdentifiers [bundle id] (FDA inheritance), RunAtLoad, ThrottleInterval 10, no Std paths (macOS 26 broke $(HOME) in SMAppService plists).
- check-bundle.sh (443) asserts identity templating + source-shape.
- CI release.yml: Dev ID p12 import, sign rt w/ entitlements, build.sh release per arch, vsix, notarize+staple app (notarytool), tarballs rt-darwin-{arm64,x64}-<tag>.tar.gz = rt + mattstack.app + rt-context.vsix, GH release, test-install from tarball.

## Permissions actually needed
- Full Disk Access on mattstack.app (daemon inherits via AssociatedBundleIdentifiers) — daemon reads repos under rt.repoRoots; `rt --grant-fda` deep link x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles; daemon `tcc:check` handler (readdir each repo → EPERM = blocked).
- Notifications (UNUserNotificationCenter requestAuthorization alert/sound/badge).
- Login Items / BTM: SMAppService.agent + mainApp; requiresApproval → open x-apple.systempreferences:com.apple.LoginItems-Settings.extension.
- Apple Events: osascript quit from CLI only (no NSAppleEventsUsageDescription).
- Keyboard: Mission Control Control+Up conflict check (reads symbolichotkeys) → Keyboard settings pane. No Accessibility/Input Monitoring.
- Bun JIT entitlements on daemon.

## rt verify checks (order): rt binary (critical) → legacy dirs → intercept shims + ~/.local/bin on PATH → fzf → mattstack.app active flavor exists (+legacy rt-tray warn) → rt-context extension (warn) → shell integration rtcd (warn) → daemon installed daemon.json (fail) → daemon launchd label listed (warn) → daemon running (fail; Login Items hint) → status detail → daemon api worktrees → tcc access (fail; rt --grant-fda).

## rt install surface
- post-install: legacy sweep (if rt-tray.app) → installRtBinaryStep (→ ~/.local/bin/rt unless dev mode / not from release dir) → installTrayApp (quit, cp to ~/Applications, xattr -cr) → installExtensions (vsix via editor CLIs: Cursor, VS Code, Insiders, VSCodium, Antigravity, Windsurf) → open app + 2s → rt daemon install (tray /daemon/start, poll; requiresApproval → open Login Items) → shell integration (~/.zshrc/.bash_profile/fish conf.d: PATH ~/.local/bin, rt-cd/rtcd, history hook) → repair wrapper → tcc check → migration outcome.
- dev-mode: wrapper script at ~/.local/bin/rt (script = dev), dev-mode.json {sourcePath,bunPath}, preload; disableDevMode installs app's rt-daemon binary; handoff: precondition → /flavor/retire → quit → poll → open incoming.
- daemon-config: API_PORT 9401, tray.sock, rt.sock, daemon.json, labels com.mattstack.daemon[.dev].
- rt update (new): GH latest → tarball → extracted rt --post-install.

## deck (repo ~/Documents/GitHub/local-apps, product Deck, GitHub m4ttheweric/deck)
- Bun-compiled binary at ~/.local/bin/deck (63MB); `deck setup` registers platform (label com.mattstack.deck, serve, PORT 11007; gateway :7950; :7942); writes its own plists to ~/Library/LaunchAgents (RunAtLoad+KeepAlive+captured PATH+PORT). Prereqs: **Node 24+ and portless** (`npm i -g portless && portless trust && portless service install` → root LaunchDaemon /Library/LaunchDaemons/sh.portless.proxy.plist binding :443, local CA, routes ~/.portless/routes.json). curl installer scripts/install.sh (deck.mattstack.dev; downloads deck-darwin-<arch> to ~/.mattstack/deck/bin/deck, PATH, deck setup). `deck update` from GH latest. `deck uninstall` leaves portless + app plists.
- Verbs: status|list, add (--port external / --cmd --dir supervised), remove, restart, logs, override, publish, password, access, domain, migrate, serve|setup|uninstall|update.
- Config ~/.mattstack/deck: registry.json (apps.<name>: managedBy user|deck|registrar, port, kind, label, command, workingDirectory, env; remove refused unless caller==managedBy), settings.json, platform.json (publicDomain, tlds [localhost, mattstack], secrets.cfApiToken/cfZoneId PLAINTEXT), access.json, api.json.
- TLD: *.localhost native; .mattstack only partially wired (4 /etc/hosts hand entries; proxy.tlds empty). Public via cloudflared tunnel LaunchAgent com.matthewgoodwin.m4tthew-apps-tunnel.
- Registered: mrs 11006 (mr-board), gitq 11008, deck 11007, + 8 others; board 11997 external grandfathered DOWN.

## mr-board / gitq
- mr-board: Bun app run from checkout (`bun src/server.ts`, PORT 11006 via deck label com.mattstack.deck.mrs, caffeinate wrapper); config IN REPO (config.json, config.team.json, .env) + reads ~/.mattstack/rt/secrets.json, repos.json, ~/.mattstack/repos/<slug>; deps rt-client file:../repo-tools/packages/rt-client, tui-kit file:../tui-kit. No binary, no release artifact, no self-install.
- gitq: @mattstack/gitq 0.1.1 npm (bin/gitq.mjs), board `bun run serve` from checkout PORT 11008 (com.mattstack.deck.gitq); config.json in repo; state ~/.config/gitq; skills via symlink script (also in mattstack plugin). No release artifact for the board.

## skills/plugins
- Marketplaces: mattstack (directory ~/Documents/GitHub/mattstack-marketplace; plugins mattstack [symlink → mattstack-skills, 0.4.9], fast-browser, current-time), assured (directory ~/.mattstack/teams/claimview → packs/claimview 0.2.14). Installer must: ensure marketplace dirs (clone), `claude plugin marketplace add <dir>`, `claude plugin install <plugin>@<marketplace>` per CLAUDE_CONFIG_DIR (cswap: 4 accounts). Plugin state not declarative.

## Live machine
- macOS 26.6.1; Swift 6.3.1 via Command Line Tools ONLY (no xcodebuild); bun 1.3.13; node 24.19 (fnm).
- ~/Applications: mattstack.app (2.7.0, Dev ID signed team 5BF66B3X4V, NOT notarized locally; embedded rt-daemon prints "rt e2e-test"), mattstack-dev.app. Dev mode active (wrapper script), com.mattstack.daemon.dev running.
- GHOST: `com.rt.daemon` BTM record, exit 78 EX_CONFIG, parent bundle com.mattstack.app — stale; sweep only boots it out when rt-tray.app exists → needs unconditional cleanup.
- ~/.mattstack: ci-attendants deck repos rt shepherdr teams user work settings.local.jsonc skills.jsonc.

## Gaps for the design
No in-app onboarding/permissions; updater = CLI only; deck needs Node 24 + portless (npm global + root LaunchDaemon + local CA trust) — heavy external prereqs; mr-board/gitq have no distributable artifact (run from checkouts, config in repo); plugin install per account; stale com.rt.daemon record.
