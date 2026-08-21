# Web research — macOS onboarding + permissions UX (2026-08-20 14:50)

## HIG
- Onboarding: fast, optional unless required; integrate permission requests into onboarding if the app needs them to function; postpone nonessential setup; no licensing text. No HIG "setup assistant" layout page.
- Privacy: request only when needed; purpose strings = brief active-voice sentence with period; pre-alert explanation screen: ONLY a Continue/Next button, no way to leave without viewing the system alert.
- Sheets: modal; avoid for prolonged flows; Back navigates steps, never dismisses; never Cancel+Done+Back together.
- Buttons: primary responds to Return; trailing ellipsis when opening another window/app ("Open System Settings…"); style not size distinguishes preferred; start label with verb.
- Menu bar extras: show a MENU not a popover; let people choose whether to show the extra — offer during setup; template images.
- Settings: Cmd-, ; toolbar panes; restore last pane.

## Exemplars
- Ice (SwiftUI, macOS 14+, GPL): dedicated Window scene at launch, hiddenTitleBar + contentSize resizability, no close/minimize; header icon+title 36pt; trust line; one box per permission (title, "needs this to:" bullets, Grant Permission → green Permission Granted; optional ones note "limited mode"); footer Quit / Continue (.large), Continue disabled until required granted; yellow "Continue in Limited Mode"; poll 1s.
- AltTab (AppKit, GPL): PermissionsWindow; per-row SF icon + bold title + one-line why + "Open X Settings…" + status "● Allowed/Not allowed/Skipped" tinted; checkbox to use without optional perm; poll 0.5s visible/5s pre-start/60s backstop + distributed notif; later menubar "Grant permission" callout only when a feature needs it.
- Rectangle (AppKit, MIT — borrowable): welcome window (choice), then single-permission Accessibility window, polls 0.3s, auto-closes on grant.
- Loop (SwiftUI, GPL): tccutil reset before prompting (stale signature); NSAlert then AX prompt; observes com.apple.accessibility.api distributed notif with 250ms delay; tintProminence .primary on macOS 26.
- Raycast: first-launch setup (hotkey, Accessibility), "Show Onboarding" + "Walkthrough" with progress; contextual re-asks per feature.
- CleanShot/Bartender: sequential prompts + public permission explainer pages + troubleshooting (re-grant).
- Shottr FAQ: moving the app after grant leaves stale TCC entry.
- Tailscale: explains sysext approval per OS version. Docker: one admin prompt, default vs advanced. OrbStack: admin prompt, graceful degrade switch. Warp: sign-in optional. Arc: 28-screen account-gated = anti-pattern.
- Pattern: dedicated fixed-size non-resizable window before main UI; one row per permission (icon, title, one-sentence why, status badge, button to exact pane); live re-check while visible; required vs optional with limited-mode path; Quit as only other exit.

## Technical per permission
- Notifications: requestAuthorization prompts once; status via notificationSettings().authorizationStatus; cannot re-prompt once denied; deep link x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=<bundleID>; .provisional = quiet, no prompt; needs real bundle + binary in Contents/MacOS; LSUIElement apps fine.
- FDA: no API, no prompt; deep link …security?Privacy_AllFiles; probe read of protected path (inket: ~/Library/Containers/com.apple.stocks on 12+; MacPaw: ~/Library/Safari/CloudTabs.db, Bookmarks.plist, TCC.db, /Library/Preferences/com.apple.TimeMachine.plist); the probe itself ADDS the app to the FDA list (user just flips toggle); System Settings says app won't have FDA until quit → Quit & Reopen; responsible-process attribution (Terminal's FDA covers CLI; app's FDA covers helpers); keyed to signing identity (+bundle id, path) → sign with stable identity (Apple Development for dev, Developer ID for dist), moving app leaves stale entry; tccutil reset <Service> <bundleID>.
- Accessibility: AXIsProcessTrustedWithOptions(prompt: true); deep link Privacy_Accessibility; poll; undocumented com.apple.accessibility.api notif (unreliable; fails for unsigned on 15+); stale value right after toggle on 13+ (Settings offers quit+relaunch).
- Automation: AEDeterminePermissionToAutomateTarget (target must be running), NSAppleEventsUsageDescription required, deep link Privacy_Automation.
- Login items/BTM: SMAppService.mainApp register/unregister/status (.requiresApproval) + openSystemSettingsLoginItems(); one BTM notification; macOS 26 may prompt re background tasks; "Allow in the Background" entries can't be removed programmatically; read status on appear + appearsActive.
- Screen recording: not needed.
- Re-check: timer 0.5–1s ONLY while window visible + NSApplication.didBecomeActiveNotification / appearsActive + AX notif as bonus. No push API for FDA/Notif/Automation.
- Deep links: FDA Privacy_AllFiles; Accessibility Privacy_Accessibility; Automation Privacy_Automation; Notifications-Settings.extension?id=; LoginItems-Settings.extension (prefer API).

## Libraries
- jaywcjlove/PermissionFlow (+SystemSettingsKit) MIT, v2.11.2 2026-08-16, macOS 13+, SPM, SwiftUI+AppKit; typed deep links useful; drag-panel UX non-standard; 4 months old → pin.
- MacPaw/PermissionsKit MIT ObjC, FDA probe reference only. inket/FullDiskAccess MIT ~150 lines, copy probe.
- sindresorhus/LaunchAtLogin-Modern MIT (2023) thin SMAppService wrapper; no requiresApproval → write 20 lines instead.
- sindresorhus/Settings: redundant on 13+ (Settings scene + TabView).
- Sparkle 2.9.6 MIT-style.
- CodeEdit WelcomeWindow (document launchpad, wrong shape); OnboardingKit / SwiftUI-Onboarding (iOS idiom, 15+) skip. Ice/Loop/AltTab = GPL design reference only; Rectangle MIT borrowable. Luminare skip.
- Bonus: KeyboardShortcuts, Defaults, MenuBarExtraAccess (MIT, control SwiftUI MenuBarExtra/NSStatusItem).
- Verdict: no macOS package gives a HIG-shaped native checklist; write ~200 lines (Permission model: title, why, isRequired, check(), request(), settingsURL; manager polls while visible; SwiftUI rows).

## Design-system bits
- SF Symbols: checkmark.circle.fill green / xmark.circle red / exclamationmark.triangle yellow / grey optional; Ice checkmark.shield.
- Form(.grouped) macOS 13+ for native grouped rows; LabeledContent rows.
- Settings scene + TabView with Tab(systemImage:); Window scene + openWindow(id:); .windowResizability(.contentSize); .windowStyle(.hiddenTitleBar); custom enum Step + switch + .transition(.push) instead of NavigationStack (toolbar chevron wrong idiom); bottom-trailing Back/Continue, Continue .keyboardShortcut(.defaultAction), .controlSize(.large); subtle step indicator.
- MenuBarExtra (13+) .menu|.window; auto-terminate if removed unless LSUIElement; gaps: can't dismiss .window programmatically; MenuBarExtraAccess patches; HIG: menu not popover.
- Liquid Glass/macOS 26: standard controls pick it up when built with Xcode 26 SDK; avoid overuse; template status icon; tintProminence.

## Recommendations (agent)
(a) One dedicated Window scene "onboarding" (re-openable "Show Onboarding…"), contentSize resizability, hiddenTitleBar or title-less, fixed width ~520–600pt; custom page model; 2–3 screens max; offer menu-bar-extra opt-in; pre-alert screens single Continue; allow closing but keep a menu-bar callout (AltTab) — degrade not nag.
(b) Checklist: header icon + "needs a few permissions" + trust line; rows ordered by necessity: symbol · Title · one sentence why · status badge · action button (ellipsis); optional rows "works without this"; per-permission behaviors above; FDA row: probe adds app to list, then "Relaunch" after toggle; login item: requiresApproval badge + openSystemSettingsLoginItems + copy warning about the BTM notification; re-check timer while visible + didBecomeActive; Continue enabled when required satisfied; "Continue in limited mode"; Quit; same rows in Settings → Permissions + "Reset & re-request".
(c) Take: Sparkle; maybe SystemSettingsKit (pin); MenuBarExtraAccess if SwiftUI MenuBarExtra; KeyboardShortcuts if hotkey. Write: Permission model + manager + rows (~200 lines; FDA probe from inket MIT). Skip the rest.
