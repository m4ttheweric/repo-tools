# mattstack.app: suite installer, onboarding, permissions, updater

Status: design, ratified decision-by-decision with Matt on 2026-08-20 (sixteen
forms; answers recorded in §2), then validated against every Linear ruling and
a full local setup survey the same day (rulings V1–V4 added; gaps folded in;
ticket amendments listed in §13.3). Supersedes the board wizard (MAT-382 r.5 face)
and the curl front door (MAT-360). Extends MAT-383 (phase 1 rebrand shipped
2026-08-20) into phase 2. Research records that ground this design live in
`research/2026-08-20-mattstack-app/` next to this file: Linear rulings, local
inventory, dependency inventory, macOS onboarding/permissions UX, Sparkle/
install/launchd conventions.

## 1. Purpose and scope

mattstack.app (the rebranded rt-tray, `com.mattstack.app`) becomes the one way
the suite is installed, set up, kept permitted, and updated. A person downloads
a DMG, opens the app, and a setup window walks them to a working machine: rt on
PATH and its daemon running, deck/board/gitq running as services, the mattstack
skills pack and their team's pack installed into Claude Code, the editor
extension installed, macOS permissions granted, accounts connected, team joined
or created, and `rt verify` green. From then on the app keeps itself and every
bundled tool current via Sparkle.

Audience, from day one: (a) Matt's teammates, invited by Matt, who never see a
git remote; (b) cold users with no team who create a team of one; (c) Matt in
dev mode. **One build target.** Team dogfood is a release gate, not a phase.
Public release follows dogfood without a rewrite.

In scope: the setup window and its five screens, the readiness checklist model
and its rt verbs, team create/join and the invite system, the dependency
bundling policy, launchd service registration, the permission rows, secrets via
RT-32, distribution (DMG + Sparkle), identity freeze, dev mode, clean-room
testing, uninstall, and the work lanes. Out of scope: redesigning the tray's
day-to-day UI (process panel, menu), the board/gitq/deck products themselves
beyond giving them releasable artifacts, and the peering relay's encryption
(recorded as a constraint on that lane).

## 2. Rulings (locked 2026-08-20)

| # | Decision | Ruling |
|---|---|---|
| 1 | Milestones | One build target, public-ready; dogfood = release gate. |
| 2 | Install shape | Suite-only (MAT-379 r.1 stands). Team settings decide what is *live*; no component checkboxes; unused services show as idle, not absent. |
| 3a | Invites | Shared mattstack switchboard (Railway) hosts **opaque** invites: client-encrypted team pointer, relay stores ciphertext + timestamps only; code = id + key; one-time, 7-day expiry, replace = revoke; static landing page `mattstack.dev/join#<code>`. |
| 3b | Git remotes | **Required up front** for both user and team repos, explained in the wizard: mattstack keeps your settings in git for safety and for a paper trail (skill edits and every change visible in history). `gh` one-click private repo when authenticated, else paste a URL. |
| 4 | Checklist | The readiness checklist is the wizard's spine: rt computes it (`rt setup plan --json`); every row has a real validator; Install is disabled until required rows are green; bare `rt setup` and `rt verify` run the same validators. |
| 5 | Architecture | Thin native shell over rt verbs. Swift owns menu bar, windows, Sparkle, SMAppService, tray-socket API; every mechanic is an rt verb; permission status flows back to rt over the socket. The relay is something rt's invite verbs talk to, never an app runtime dependency. |
| 6 | Build tooling | Xcode project generated from a committed `project.yml` (xcodegen); `build.sh` wraps `xcodebuild`; `check-bundle.sh` keeps asserting the bundle contract. Matt installs Xcode 26. |
| 7 | Distribution | The app IS the release (rt + helpers + suite binaries + extension inside). Notarized, stapled DMG for first install; zip enclosure + CI-signed appcast for Sparkle 2.9; `~/.local/bin/rt` is a symlink into the bundle; app re-registers + kickstarts agents when its version changes; `rt update` asks the app. **arm64-only** for now. |
| 8 | Dependencies | Four-way policy (§7): BUNDLE for internal use by absolute path; PATH exposure per tool opt-in, tagged, yields to the user's copy — **except the default-exposed set `rt`, `fast-browser`, `gitq`, `deck` (V2), linked by Install because shipped skills call them bare**; PROVISION herdr + Claude Code via brew-if-present else vendor installer, version floors only; SYSTEM git/python3 via Apple CLT; TEAM-DECLARED tools from the pack's requirements. Deck's proxy via **one admin prompt**. tmux/zellij/terminal-notifier dropped. |
| 9 | Services | SMAppService registers rt daemon + deck (one plist each in the bundle, one Login Items switch, FDA inherits); deck supervises board + gitq as managed deck apps (MAT-384); app monitors deck like the daemon; plist `EnvironmentVariables.PATH` is static (`/usr/bin:/bin:/usr/sbin:/sbin`; no hardcoded `/Applications/…`) and rt + deck prepend `<bundleRoot>/Contents/Helpers` (from their own execPath) and `$HOME/.local/bin` at process start; portless proxy is a root LaunchDaemon owned by the privileged step. |
| 10 | Permissions | Full Disk Access + Login Items required; Notifications optional. No Accessibility/Screen Recording/Automation. |
| 11 | Secrets | RT-32 as ruled: sops/age-encrypted in the user repo, age key generated at setup into the macOS Keychain, plaintext never in git; `secrets.json` is a one-time migration source; invitee's age public key is added as a recipient for team-scoped secrets. |
| 12 | Dev + testing | Dev identity stays (mattstack-dev.app). XCTest + XCUITest against a stub rt; rt verbs under bun test. Clean room = (a) GitHub Actions macOS runner headless install + `rt verify --ci`; (b) local Apple-Silicon VM (Tart/VirtualBuddy) golden image, restored per run, scripted walkthrough; (c) second macOS user account as daily smoke. Release gate = (a) + (b) green. |
| 13 | Identity | Frozen before the first teammate installs: `com.mattstack.app` / `.app.dev`; `com.mattstack.daemon` / `.dev`; `com.mattstack.deck`; embedded binary renamed `rt-daemon` → `rt` now; product name mattstack; TLD `.mattstack`; `~/.mattstack`; **macOS 14 floor**. |
| 14 | Uninstall | Settings → "Uninstall mattstack…" and `rt uninstall`, same rt code path; shows the list, reverses everything the installer did, asks about `~/.mattstack` (default keep), trashes the app. |
| 15 | UI | Five screens + Settings with four panes (§4). Stock macOS 26 controls, `Form(.grouped)` rows, Ice/AltTab shape. GPL sources are design reference only; Rectangle/inket (MIT) borrowable. |
| 16 | Lanes | Seven lanes (§13); start L7 + L3 + L1/L2 now; L4/L5/L6 next. |
| V1 | Auto-snapshot | **RT-30 joins lane L2**: rt commits every settings/secrets write to the user or team repo and pushes in the background (daemon timer + on-write); Team pane shows last push; conflicts surface as a needs-you row. The "paper trail" promise is backed by this. |
| V2 | PATH defaults | Default-exposed: `rt`, `fast-browser`, `gitq`, `deck` (tagged links, still yielding to a user copy). Everything else internal + opt-in. |
| V3 | App location | DMG target `/Applications`, fallback `~/Applications` when not writable; the app records its bundle path in the machine store (`mattstack.appPath`) at launch and rt reads that; legacy sweep covers `~/Applications/mattstack.app`; Matt's machine re-grants FDA once. |
| V4 | Schema home | Ruled by the settings lane (reply 2026-08-20 16:45, spec `2026-08-20-suite-settings-migration.md`): `mattstack.integrations` (team), `mattstack.tracking` (team, identity-keyed; merged under machine `rt.repoTracking`), pack-side `requirements.jsonc` (not a key), `claude.marketplaces`/`claude.plugins` (user+team), `mattstack.appPath` (machine), `rt.cron` (machine), full `deck.*`/`board.*`/`gitq.*` tables — all in ONE suite registry in `@mattstack/rt-client`; **apps read in-process via the shared module** (not through the daemon). Registry merged to main 2026-08-20 (PR #5). |
| V5 | Home repo (settings lane, ratified by Matt) | `~/.mattstack` **is** the git-backed home repo (`rt home init`, private `mattstack-home` via gh); mattstack-prefs folded in as `user/`; team clones nested and ignored; secrets at `user/secrets/<domain>.json` sops/age-encrypted to the Keychain-held age key; `rt home key export` → the user's password manager is the key-migration channel; `rt restore <org>/<repo>` = clone + key paste + materialize (RT-31); H2 snapshot daemon = RT-30. All live on Matt's machine as of 2026-08-20 evening. This supersedes this spec's earlier "container" wording. |

### Invariants (binding on every lane)

- **No user or employer data ever lands on mattstack-hosted infrastructure.**
  Team data lives on the team's own forge. The shared relay sees ciphertext and
  timestamps. Peering envelopes (which carry MR URLs) must be end-to-end
  encrypted before they may traverse a shared relay; until then teams run their
  own relay as today.
- rt owns mechanics, the app owns ceremony; every ceremony has a CLI equivalent
  (MAT-374 r.6). The wizard never does something `rt setup` cannot.
- Honesty over magic: every checklist row reports what was actually checked;
  nothing is marked ready on a guess.
- Settings are read and written only through the RT-47 stores via `rt settings`;
  state only through each app's state.db. The app has no config files of its
  own beyond UserDefaults for window/UI state.
- The installer never copies a user's `~/.claude/settings.json` or hooks; it
  adds marketplaces and plugins only.
- Pure canonical, no compat: `rt-tray.app`, `com.rt.daemon`, `~/.rt`, brew paths
  are swept, never honored.
- The **app owns ceremony — setup and restore**; Deck does not (supersedes the
  "Deck owns ceremony" wording of MAT-374 r.6, DECK-56's skin, MAT-372's
  framing; DECK-56's snapshot-timeline *view* may still live in Deck).
- `~/.mattstack` **is the home repo** (V5): the gitignore is the layer
  boundary — tracked = declarative (`user/`, `skills.jsonc`,
  `snapshot-owners.jsonc`), encrypted-tracked = `user/secrets/`, ignored =
  runtime (`rt/`, `deck/`, `repos/`, `teams/`, `user/local/`,
  `settings.local.jsonc`). "User repo" below means the home repo.
- Third-party tools may write their own Claude Code hooks (herdr's
  `integration install claude`); the installer itself never edits
  `settings.json`.

## 3. The flow

```
DMG → drag to Applications → open
  └─ app launches; menu-bar "m" appears; no daemon.json → Setup window opens
       1 Welcome ──► 2 Your team ──► 3 Readiness checklist ──► 4 Install ──► 5 Done
       (create or join)   (rt setup plan)       (rt setup apply)   (rt verify)
```

Re-entry: menu "Setup status…" reopens screen 3 as a health view; Settings (⌘,)
exposes Permissions, Team (Invite…), General, Uninstall. A `mattstack://join/<code>`
link opens the app on screen 2 with the code filled in; if setup is already
complete it opens Settings → Team → Join.

## 4. The screens

Window: one dedicated `NSWindow` hosting SwiftUI (AppKit lifecycle stays),
~560 pt wide, fixed, no close/minimize buttons while setup is incomplete (Quit
remains available from the menu), Back/Continue bottom-right, Continue bound to
Return, `.controlSize(.large)`, custom `enum Step` page model with push
transitions (not `NavigationStack`), a subtle "Step n of 5" indicator. Rows use
`Form(.grouped)` / `LabeledContent`. Stock macOS 26 controls; no custom design
system. Status glyphs: `checkmark.circle.fill` green ready · `xmark.circle` red
failed · `exclamationmark.triangle` yellow needs you · `circle.dotted` grey not
checked/optional-skipped · `ProgressView` small while checking. Buttons that
open System Settings end with an ellipsis.

### 4.1 Welcome

Brand mark, one sentence, then a plain list of what setup will do to this Mac
(install the `rt` command into `~/.local/bin` and add one PATH line to the
shell rc; run background services: rt daemon, deck, board, gitq; install the
mattstack skills into Claude Code; install the editor extension; ask for Full
Disk Access and background-item approval). One line that everything is
reversible from Settings → Uninstall. Continue.

### 4.2 Your team

Two cards.

**Create a team.** Fields: team name (slug preview shown), "Others will join
later" checkbox (default on). Remote: if `gh auth status` succeeds, a checked
box "Create a private GitHub repo `<owner>/mattstack-team-<slug>`" with the
owner selectable (user or an org the token can see); otherwise a URL field
("paste an empty repo's URL; GitHub, GitLab, anything git can push to"). A short
explainer under the fields: *mattstack keeps your team settings in git. That
keeps them safe and gives you a paper trail: skill edits and every change are
visible in history.* The same explainer covers the **home repo**, created by
the same step (`rt home init`: `~/.mattstack` becomes the clone of a private
`<owner>/mattstack-home`, the age key is generated into the Keychain, and
`rt home key export` is offered once so the user can store the key in their
password manager — the documented channel for a second machine).
Continue validates both remotes with `git ls-remote` using the user's
credentials and moves on; nothing is pushed until Install. Create scaffolds the
team repo as a proper mattstack zone: `mattstack/mattstack.jsonc` (`role:
team`, `namespace`, `org` — editable), `mattstack/settings.jsonc` seeded with
`mattstack.integrations` (forge from the remote) and the team-scope `board.*`
keys (`board.gitlabHost`, `board.projects`, `board.members` — the roster —
`board.title`; the team store IS the team layer, per the settings lane; there
is no `team.jsonc`/`config.team.json`), and a root `.claude-plugin/marketplace.json`
so the team repo *is* the team's marketplace. A team of one has no pack; `mattstack:*` skills are the default.
`rt home init` owns the home-repo layout (`user/mattstack.jsonc` role marker,
`prefs/`, `skills/`, `local/`, the boundary gitignore).

**Already have mattstack settings?** (third, smaller card — the restore path,
RT-31): paste the home repo (`<org>/<repo>`, or pick it via gh) and paste the
age key from your password manager. On Continue the app runs the real
`rt restore <org>/<repo> --json` (key on stdin), which clones it to
`~/.mattstack`, installs the key in the Keychain, and materializes, then
`rt setup intent restore <org>/<repo>`; Install's `home.restore` step only
verifies the clone and key. The team(s)
recorded in the home repo (`claude.marketplaces`/`claude.plugins`, tracking)
are cloned by Install and their packs replayed. This is Matt-on-a-new-Mac and
any reinstall.

**Join a team.** One field: invite code (prefilled from a deep link). Continue
redeems it through rt (`rt team join --dry-run`, code passed on stdin, never
as a process argument): decodes, fetches the
ciphertext from the relay, decrypts, and checks `git ls-remote` on the team
remote with the user's credentials. Success shows "Joining *<team>* (owner
*<handle>*)". Failure states are specific: *invite not recognized or expired:
ask <owner> for a new one*; *you don't have access yet: ask <owner> to grant you
access to <team>* (no git output, the remote URL is not shown); *code is for a
different forge account than you're signed into*. The user repo is created here
too, remote required, same explainer.

### 4.3 Readiness checklist ("Before we begin")

Rendered from `rt setup plan --json` (§5). Groups in order:

- **Your Mac** — macOS version ≥ 14; Apple command line tools (git, python3)
  → *Install…* runs `xcode-select --install` (Apple's dialog); `~/.local/bin`
  **first** on PATH, including non-interactive shells (informational, fixed by
  Install: rc block + `.zshenv` precedence block; `rt verify` checks order, not
  presence, so team intercept shims like `doppler` actually fire); **Full Disk
  Access** →
  *Open Full Disk Access Settings…*; **Background services** → *Open Login
  Items…* when `.requiresApproval`; **Notifications** (optional) → *Allow*
  (system prompt; if denied → *Open Notification Settings…*).
- **Accounts** — only what the team declares (team-of-one default: the forge
  of the team remote). GitHub: *Use gh* when `gh auth status` is good, else
  token field (also signs the bundled `gh` in); GitLab token (also signs the
  bundled `glab` in); Linear key (the team key comes from
  `mattstack.integrations.linear.teamKey`; `rt settings linear team` is deleted
  by the settings lane); Slack → *Connect*
  (per-user OAuth in the browser against the **team's** Slack app; the
  callback port is a team setting). For an **owner**, Slack shows the
  owner-once row first: *Create the team's Slack app* (`rt setup slack
  create-app`: app-config token → generated manifest from the declared scope
  needs → client id/secret into team-scoped secrets); the Collaborators
  question (MAT-382) stays open and is a §14 risk. Switchboard board token
  (when the team has a relay) is redeemed as part of Join, shown here as a
  status row. Team-declared connects (Doppler login, StrongDM email + login,
  ldcli auth) render from the pack's requirements. "Ready" means the validator
  called the API and confirmed the token can see the team's resources
  (group/org membership, the team repo).
- **Access** — team repo reachable; each repo the team lists is visible with
  those credentials; forge host reachable; switchboard (if the team has one)
  answers.
- **Tools** — herdr ≥ floor (present → version shown; missing → *Install*:
  brew if present else vendor installer) and its Claude integration
  (`herdr integration status`; herdr writes its own hook); Claude Code (same)
  and signed in; Fast Browser (runtime present, **unpacked extension loaded in
  Chrome** — a needs-you row with the exact steps, `fast-browser doctor --json`
  as validator; pairing token optional); an editor we can install the
  extension into (optional); Google Chrome (optional unless the team's pack
  requires it; a pack may add "signed into <team app>" as a needs-you row);
  Mission Control Control+Up unbound (optional, for `rt nav`); **team-declared tools** from the pack's requirements (doppler, sdm,
  ldcli, pnpm, Postgres…) each with *Install* / *Connect* and the pack's
  one-line why. MCP servers a pack needs ship inside the pack's plugin
  (`.mcp.json`) and arrive with the plugin install; the installer never edits
  `~/.claude.json`.

Row anatomy: symbol · title · one sentence why · status badge · one button.
Required vs optional is visible (optional rows say "works without this").
Permission rows re-check on a 1 s timer while the window is visible and on
`didBecomeActive`; other rows re-validate on change and on *Re-check*. Continue
(labelled **Install**) enables when every required row is ready. A *Continue
in limited mode* path exists only when all required rows are green and optional
ones are not. Permission status for the three permission rows is computed by
the app (§9) and merged into the plan by rt via `GET /permissions` on tray.sock,
so the terminal `rt setup` shows identical rows.

### 4.4 Install

A live list driven by `rt setup apply --json` (NDJSON stream): each step has
title, state (pending/running/done/failed/skipped), detail, and a log handle.
Steps (order is rt's; shown here for the reader): `rt home init` (home repo +
boundary + age key + push) — or `rt restore` (clone + key paste) for the
restore card; create team repo (scaffolded zone) + push / clone team repo;
write collected secrets with `rt secrets set <domain> <key>` (sops/age,
`user/secrets/`); link the
default-exposed tools (`rt`, `fast-browser`, `gitq`, `deck`) into
`~/.local/bin` (+ rc PATH block, `.zshenv` precedence block, shell integration
block); `rt intercept install` (team intercept shims); write machine settings
(`rt.repoRoots` seeded, detected roots offered; `mattstack.appPath`); clone the
team's repos into `<repoRoot>` (default on for every repo in
`mattstack.tracking`, each deselectable — tracking intent only activates for
repos the repo index can resolve locally, so this is what makes the board
populate);
register rt daemon + deck (app, via socket request from rt); privileged step:
install the private node+portless, write the proxy LaunchDaemon plist
ourselves (absolute `~/.mattstack/deck/` paths, `PORTLESS_TLD=localhost,mattstack`,
portless ≥ 0.15.5), CA trust, sudoers (one admin prompt, raised by the app);
register board + gitq as managed deck apps; materialize bindings
(`merge-manifests` → `~/.mattstack/repos/<slug>/skills.jsonc`); write the
machine-scope board/gitq keys the installer knows (`board.rtRepos`,
`board.cwds`, `gitq.board`, `gitq.workSlots`) — board/gitq read the stores
in-process, nothing is materialized into their checkouts; register the board's
triage trigger (`rt.cron`, machine) when the team enables triage; install
marketplaces + plugins (mattstack, fast-browser, team pack — MCPs arrive inside
the pack's plugin) per Claude config dir; run fast-browser's own setup from the
bundled artifact (runtime, extension unpack, macros); `herdr integration
install claude` per config dir; install editor extension; start services;
auto-snapshot push (RT-30); `rt verify`. A failed step stops
the list on that row with remediation text and *Show log*; *Retry* resumes from
the failed step (steps are idempotent). Nothing runs that was not listed.

### 4.5 Done

"Everything's working" with the verify summary (N checks), where things live
(the `m` in the menu bar; `rt` in a new terminal; `https://board.mattstack`),
buttons *Open the board*, *Invite teammates…* (owners), *Finish*. Closing the
window is now allowed.

### 4.6 Settings (⌘,)

- **General**: start at login (SMAppService.mainApp), automatic updates
  (Sparkle), check now, dev mode (prod/dev handoff as today), version.
- **Permissions**: the three rows from §4.3 plus *Reset & re-request* (runs
  `tccutil reset` for our bundle id and reprompts; for the stale-grant case).
- **Team**: name, remote (masked to host + repo, copy), backup status (last
  push), members with access (from the forge, when the token can see it),
  *Invite…* (§6), *Join another team…*.
- **Uninstall…** (§12).

## 5. Architecture and the rt contract

### 5.1 Components

- `mattstack.app` (Swift, Xcode project): `AppDelegate` (menu bar, health
  polling, notifications as today), `SetupWindowController` + SwiftUI
  `SetupView` (screens), `ReadinessModel` (renders plan JSON, owns timers),
  `PermissionsService` (§9), `ServicesRegistrar` (SMAppService for N plists,
  version-change restart), `PrivilegedInstaller` (AuthorizationServices admin
  prompt for the proxy step), `UpdaterController` (Sparkle), `TrayServer`
  (routes below), `RtClient` (spawns the bundled `rt` by absolute path with
  `--json`, streams NDJSON).
- `rt` (TypeScript): `commands/setup/*` verbs, `lib/setup/plan.ts`
  (requirements + validators), `lib/setup/apply.ts` (steps), `lib/team/*`
  (create/join/publish/invite), `lib/secrets/*` (RT-32), `lib/deps/*`
  (bundled-tool resolution, tagged PATH links), `commands/uninstall.ts`.
- The shared switchboard (mr-board repo `switchboard/`): opaque invite
  endpoints (§6.3).

### 5.2 rt verbs (the contract the app drives)

All JSON-emitting verbs accept `--json`; streaming verbs emit NDJSON lines of
`{event, ...}`. Exit codes: 0 ok, 2 user-actionable failure (payload says
what), 1 bug.

| Verb | Purpose |
|---|---|
| `rt setup plan [--team <name>] --json` | Compute the readiness plan for the current (or given) team. |
| `rt setup status --json` | Same rows, post-install, as health (used by "Setup status…" and `rt verify` reuses validators). |
| `rt setup <integration> status\|connect [--token-stdin] --json` | MAT-382 r.4 shape: `setup github\|gitlab\|linear\|slack\|switchboard\|sdm\|doppler …`; connect validates + stores the credential via RT-32; `--use-gh` borrows gh auth. |
| `rt setup slack create-app --config-token-stdin --json` | Owner-once: generated manifest from declared scope needs → app; client id/secret → team-scoped secrets; callback port recorded in team settings. |
| `rt setup pack --json` | Marketplace add + plugin install + enable, materialize bindings, then the pipeline-resolves check for the team's default work type (exit 2 `stage-unresolved`). |
| `rt setup apply [--from <stepId>] --json` | Run the install steps (NDJSON). |
| `rt setup` (TTY) | Interactive walk of the same plan; the headless/catastrophe path. |
| `rt team create <name> (--remote <url> \| --create-repo <owner>) [--others] --json` · `rt team status [--team <slug>] --json` | Init team repo with starter `mattstack/settings.jsonc`, set remote; push happens in apply. |
| `rt team join [--dry-run] --json` | Code on stdin (no-echo prompt when TTY; never a process argument). Redeem invite (relay fetch + decrypt), clone under `~/.mattstack/teams/<name>/`, apply the board-peering invite when the team has a relay, report the invitee's age public key back (§6.3). |
| `rt team invite --handle <forge-handle> --json` | Mint an invite: grant forge read access to the team repo (handle required when the repo is private), encrypt pointer, POST to relay, add roster entry; prints code + paste block. |
| `rt team members sync\|remove <handle> --json` | Roster = `board.members` (team scope). Sync: collect invitee keys and add them as recipients. Remove: forge ACL revoke + `rt secrets rotate --team` re-encrypt to the remaining keys. |
| `rt repos register <path…> / rt daemon track` | Register + track repos per team intent (existing `track` verb reused). |
| `rt skills materialize [--repo]` | Bindings merge → `~/.mattstack/repos/<slug>/skills.jsonc`. |
| `rt cron install <trigger>` | Register a trigger (board triage) with bundled binary paths. |
| `rt tools setup <tool>` | Tool-owned setup wrappers (fast-browser setup, herdr integration). |
| `rt team publish --remote <url> --json` | Push a team repo to a remote (also used when a remote must change). |
| `rt home init [--dry-run]` / `rt home key export` (exist, settings lane) | Home repo provisioning + boundary + age key; key export once to the password manager. |
| `rt restore <org>/<repo>` (settings lane R) | Clone home repo, key paste → Keychain, materialize (replays `claude.*`, tracking, packs). |
| `rt secrets set\|list\|rotate` (exist, settings lane) | Domains `rt`, `deck`, `board` (+ team-scope in L2); `setup <integration> connect` writes through this. |
| `rt secrets init/set/get/rotate` | RT-32 surface; `setup connect` uses it. |
| `rt deps resolve <tool> --json` | Absolute path of the bundled tool + whether a user copy exists; used by rt internally and by the Tools rows. |
| `rt deps link <tool> / unlink` | Opt-in PATH exposure (tagged symlink), auto-unlink when a user copy appears. |
| `rt services list/register/restart --json` | Facade over tray.sock for the app-registered agents + deck-managed apps. |
| `rt update [--json]` | `POST /update/check` on tray.sock; if the app is not running, exit 2 (`{error:{code:"app-not-running"}}` with `--json`) and prints where updates come from. |
| `rt uninstall [--keep-data|--delete-data] [--yes] --json` | §12; `--delete-data` needs `--yes` (the app's sheet is the consent). |
| `rt verify [--json]` | Existing command; its checks become the plan's validators (one implementation). |

`rt install` (MAT-360's "internal package mechanism") is absorbed by `rt setup
apply` steps + `rt deps`; no separate verb.

Plan JSON (abridged):

```json
{ "team": {"name":"acme","mode":"join"},
  "groups": [{ "id":"mac", "title":"Your Mac", "rows":[
     { "id":"perm.fda", "kind":"permission", "title":"Full Disk Access",
       "why":"Reads your repositories' git state so the daemon can show branch and MR status.",
       "required":true, "status":"needs-you", "detail":"Not granted",
       "action":{"type":"open-settings","target":"fda"} },
     { "id":"tool.clt", "kind":"tool", "title":"Apple command line tools", "required":true,
       "status":"ready", "detail":"git 2.50.1", "action":null } ]},
    { "id":"accounts", "title":"Accounts", "rows":[
     { "id":"account.gitlab", "kind":"account", "title":"GitLab",
       "why":"The team's merge requests live on gitlab.example.com.",
       "required":true, "status":"missing", "action":{"type":"connect","integration":"gitlab","fields":[{"name":"token","secret":true,"hint":"read_api, read_user"}]} } ]} ],
  "canInstall": false, "requiredMissing": ["perm.fda","account.gitlab"] }
```

`status` ∈ `ready | missing | invalid | needs-you | checking | skipped | error`;
`action.type` ∈ `open-settings | request-permission | connect | oauth |
owner-once | install | link-bundled | steps | open-url | run` (or `action: null`;
the contract file is authoritative — `use-gh` is a `connect` alternative, not
a type). The app never invents rows; it renders what rt sends
and calls the action's verb. Permission rows are the exception in *evaluation*
only: rt asks the app (`GET /permissions`) and folds the answer in, so one
plan serves wizard and terminal.

### 5.3 tray.sock routes (additions)

`GET /permissions` → `{fda, notifications, loginItems}` each
`{status, detail}`; `POST /permissions/request` `{which}`; `GET /services` →
registered agents + status; `POST /services/register` `{plist}` /
`/restart` `{label}`; `POST /privileged/proxy-install` (app raises the admin
prompt, runs the bundled installer helper, returns result); `GET /setup/need/<id>`
→ 200 `{state: pending|done|failed, detail}` always (rt polls until
done/failed); `POST /update/check`; `GET /version` (`build` = numeric
`CFBundleVersion`). Existing routes unchanged.

### 5.3b Settings and secrets substrate (settings lane)

Every read/write goes through `@mattstack/rt-client`'s settings module (the
RT-47 resolver + the one suite registry) and `lib/secrets` (sops/age over
`user/secrets/<domain>.json`). The app never parses a store file; it asks rt.
The home repo (`rt home init`), snapshot daemon (H2), and restore (R) are that
lane's; this spec's verbs sit on top of them.

### 5.4 Where logic lives

Validators, step logic, team/invite crypto, secrets, dependency resolution:
TypeScript, unit-tested with bun, no Swift. Swift holds view state, timers,
permission probes, SMAppService calls, the admin prompt, Sparkle, and the
socket server. The stub rt used by XCUITest is a tiny Bun script emitting
canned plan/apply JSON for named scenarios (`RT_STUB_SCENARIO=join-happy`),
selected by an env var the app honours only in DEBUG builds.

## 6. Team and invite model

### 6.1 Everyone has a team

`~/.mattstack/teams/<slug>/` is a git clone (nested inside the home repo,
ignored by it) with `mattstack/settings.jsonc` (team scope of the RT-47
resolver — `mattstack.integrations`, `mattstack.tracking`, team-scope `board.*`,
`claude.*`) and the team's pack(s). A team of one is the same shape. The home
repo `~/.mattstack` holds user-scope settings (`user/settings.jsonc`) and the
encrypted secrets (`user/secrets/`). Both have remotes from creation (ruling
3b); the wizard explains why in plain words and never asks the user to run git.

### 6.2 Create

`rt team create` writes the starter settings (forge host inferred from the
remote, integrations empty), sets the remote; `rt user init` likewise; Install
pushes both. If `gh` is authenticated, the app offers to create the private
repos in one click (owner = user or an org); otherwise URL fields. The team's
"declared integrations" start as what the remote implies (GitHub → github;
GitLab host → gitlab) and grow when the owner connects more in Settings → Team
or via the pack.

### 6.3 Invites (opaque, shared relay)

Owner side (`rt team invite`):

1. Pointer = `{v:1, team:<slug>, name, remote, owner:<forge handle>, forge:<host>, createdAt}`.
2. Generate 32-byte key; encrypt pointer (XChaCha20-Poly1305 or AES-256-GCM);
   `POST /v1/invites` to the relay with `{ciphertext, expiresAt}` → `{id}`.
   Relay stores `id`, ciphertext, created/expires/redeemed timestamps only.
3. Code = base32(id ‖ key) chunked for reading (~77 chars; Crockford base32 of
   16 + 32 bytes). Paste block: "Install
   mattstack from <download url>, then open `mattstack://join/<code>` or paste
   the code into Setup → Join a team."
4. Forge access is **granted at mint** (the handle is required when the team
   repo is private; `gh api` / GitLab API with the owner's token) and
   **verified at redeem** — MAT-379 phase C's "first step is forge access"
   maps to exactly this. The invitee is added to the roster (`board.members`,
   team scope) so the redeem can report back. Age recipient for team-scoped secrets is added when the invitee
   reports their public key (redeem posts it to the relay as a second opaque
   blob keyed by the same id, readable once by the owner's next
   `rt team members sync`).
5. Replace-on-mint: a new invite for the same handle replaces the old id (the
   relay deletes it). Expiry 7 days. Relay prunes hourly.

Teammate side (`rt team join`): decode → `GET /v1/invites/<id>` → decrypt → `git
ls-remote <remote>` with the user's credentials → clone → mark redeemed (`POST
/v1/invites/<id>/redeem`, one-time) → materialize (pack marketplace add +
install, bindings; settings now resolve at team scope; tracking activates as
team repos are cloned)
→ if the team settings carry a relay URL + team-scoped admin token, mint and
apply the board-peering invite for this member (peering row otherwise shows
idle) → post the member's age public key as the reply blob. Failure messages
in §4.2.

Relay (mr-board `switchboard/`, Railway, `mattstack` shared instance):
`POST /v1/invites` (any client; rate-limited), `GET /v1/invites/:id` (returns
ciphertext if unexpired and unredeemed), `POST /v1/invites/:id/redeem` (CAS),
`POST /v1/invites/:id/reply` (second opaque blob, once), `DELETE` by the
creator (holds a creator secret returned on create). No admin token needed for
team invites; board-peering invites keep today's admin-minted flow on a team's
own relay until peering envelopes are E2E encrypted. The invariant: no field on
the relay is ever plaintext employer data.

Landing page: `https://mattstack.dev/join#<code>` — static; reads the fragment
client-side, shows Download + "Open in mattstack" (`mattstack://join/<code>`).
The fragment never leaves the browser.

## 7. Dependencies

Policy (ruling 8), derived from the full inventory (research/dependency
inventory):

| Class | Tools | How |
|---|---|---|
| **Bundle** (Contents/Helpers, signed, pinned via `deps.lock` in CI with sha256) | rt (Contents/MacOS/rt), fzf, jq, bun, gh, glab, private node (for fast-browser + portless only), fast-browser, deck, board, gitq | Used by the suite **by absolute path**. `rt`, `fast-browser`, `gitq`, `deck` are linked into `~/.local/bin` by Install (V2; shipped skills call them bare); every other tool's PATH exposure is opt-in from the Tools row ("Use mattstack's"). Links are tagged symlinks that rt removes automatically when a non-ours copy appears on PATH (`rt deps` reconciles on `rt verify`, daemon start, app launch). Version floors apply to internal use only; the user's copies are never judged. |
| **Provision** | herdr (≥ floor), Claude Code | Present → floor check. Missing → *Install*: `brew install` if brew is on the machine, else the vendor installer (`herdr.dev/install.sh`, `claude.ai/install.sh`) into `~/.local/bin`. Their own updaters own them thereafter. Never bundled (self-updaters, proprietary). |
| **System** | git, python3 (stdlib only), shells, launchctl/osascript/security/etc. | Apple CLT; the row's *Install…* triggers `xcode-select --install`. |
| **Team-declared** | doppler, sdm, ldcli, pnpm, Postgres, Linear/local-db MCPs, Chrome-for-evidence… | The pack manifest declares `tools: [{name, floor, why, install:{brew, url}, connect?}]`; rows render from it; nothing of the team's is bundled. |
| **Dropped** | tmux, zellij (no callers), terminal-notifier (osascript fallback) | Removed from README/verify. |
| **Privileged** | portless ≥ 0.15.5 proxy: root LaunchDaemon on :443 + local CA trust + `/etc/sudoers.d/mattstack-proxy-restart` | One admin prompt (AuthorizationServices) raised by the app at the Install step; installs the bundled node+portless privately under `~/.mattstack/deck/`, **writes the LaunchDaemon plist itself** (absolute paths, `PORTLESS_TLD=localhost,mattstack`; closes DECK-55's note and DECK-58's fnm-path baking), trusts the CA, writes sudoers. A deck ticket evaluates absorbing the proxy later. |

Accounts-bearing tools (gh, glab, doppler) keep their auth in the user's
`~/.config`, so whether the bundled or the user's binary runs, login happens
once. Services' plists set a static `PATH=/usr/bin:/bin:/usr/sbin:/sbin`; rt
and deck prepend `<bundleRoot>/Contents/Helpers` (derived at process start
from their own execPath, so `/Applications`, `~/Applications` and the dev
bundle all work) and `$HOME/.local/bin` (for herdr/claude) to their own
`PATH` before spawning anything; nothing is captured from the user's shell.

Consequences for other repos (lane L5): board and gitq ship as `bun --compile`
binaries with published rt-client (no `file:` deps), read their config from
the stores in-process via rt-client's settings module (no `config.json`, no
`.env`; secrets via the shared secrets module; state in their own state.db —
the settings half is the settings lane's deck/board/gitq lanes), and their
skills move into
plugins (no `~/.claude/skills` symlinks); deck publishes releases and its
platform registration moves to the app's SMAppService plist (`deck setup`
narrows to registry/proxy; `deck uninstall` leaves the agent to the app);
fast-browser publishes its artifact and fixes its default marketplace source;
the mattstack marketplace becomes the MAT-360 public meta repo (pruned plugin
tree) instead of a directory of symlinks; the acme pack declares its
requirements, gets a writer for `dev-ports.state.json` (the path fix alone does
not restore bearer capture), and `local-db-mcp` either gets a distributable
home or leaves the pack; the rt-context extension reads secrets through the
daemon before RT-32 deletes `secrets.json`. rt's two latent `bun`-on-PATH
branches (`lib/enrich.ts`, `bunx pino-pretty`) switch to the bundled bun.

## 8. Services and launchd

- Bundle ships `Contents/Library/LaunchAgents/com.mattstack.daemon.plist` and
  `com.mattstack.deck.plist` (dev flavor: `.dev` labels), `BundleProgram` under
  `Contents/MacOS`/`Contents/Helpers`, `KeepAlive {SuccessfulExit:false}`,
  `ThrottleInterval 10`, static `EnvironmentVariables.PATH`
  (`/usr/bin:/bin:/usr/sbin:/sbin`; the programs prepend the bundle's Helpers
  dir and `~/.local/bin` themselves, §7), no stdout/err
  paths (macOS 26 `$(HOME)` breakage; logs go to `~/.mattstack/rt/logs` and
  `~/.mattstack/deck/logs` by the programs themselves). `AssociatedBundleIdentifiers`
  kept (harmless; needed only for legacy plists).
- `ServicesRegistrar` registers both on first run and on every launch
  (idempotent), surfaces `.requiresApproval` as the Background services row,
  and on a version change (UserDefaults `lastLaunchedVersion` ≠ bundle version)
  re-registers then `launchctl kickstart -k gui/$UID/<label>` for each, then
  asks deck to restart its managed apps (`deck restart --managed`).
- Deck registers board and gitq as managed apps (`managedBy: mattstack`) with
  their binaries' absolute paths inside the bundle and hostnames
  `board.mattstack` / `gitq.mattstack` (MAT-384). The app polls deck's API for
  liveness like the daemon and surfaces it in the menu (plumbing only).
- Labels, Team ID, and each helper's code-signing identifier stay stable across
  releases (launchd pins them). The embedded `rt-daemon` → `rt` rename happens
  once, now, before any teammate installs.
- The stale `com.rt.daemon` BTM record found on Matt's machine is booted out
  unconditionally by the one-shot legacy sweep (it currently only fires when
  `rt-tray.app` exists); the sweep also covers `~/Applications/mattstack.app`
  from phase 1 (V3: the app now lives in `/Applications`, with `~/Applications`
  as the non-writable fallback, and records `mattstack.appPath`).
- Dev flavor: the deck binary must not live under `~/Documents` (DECK-13 TCC
  wedge); the dev app points at `~/.mattstack/deck/bin/deck` or the dev
  bundle's copy.

## 9. Permissions

| Row | Required | Detect | Request | Re-check |
|---|---|---|---|---|
| Full Disk Access | yes | Probe read of `~/Library/Containers/com.apple.stocks` (macOS 12+; fallback list from MacPaw) — the probe itself lists the app in the FDA pane; `EPERM/EACCES` ⇒ not granted | *Open Full Disk Access Settings…* (`x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`); after the toggle, row says "Relaunch mattstack to apply" with a button (macOS applies FDA on next launch) | timer while visible + `didBecomeActive` |
| Background services | yes | `SMAppService.agent(...).status` for both plists | `register()`; `.requiresApproval` → *Open Login Items…* (`openSystemSettingsLoginItems()`); copy warns about the "Background Items Added" notification | same |
| Notifications | no | `UNUserNotificationCenter.notificationSettings().authorizationStatus` | `.notDetermined` → `requestAuthorization`; `.denied` → *Open Notification Settings…* (`…Notifications-Settings.extension?id=com.mattstack.app`) | same |

Pre-request explanation screens follow the HIG (single Continue). The app is
signed with a stable Developer ID (dev flavor with Apple Development) so grants
survive updates; Settings → Permissions → *Reset & re-request* runs `tccutil
reset All com.mattstack.app` for the moved-app/stale-signature case. The daemon
and deck inherit FDA through SMAppService attribution; board/gitq read through
rt and need none.

## 10. Secrets (RT-32)

`rt home init` generates the age key into the login Keychain (settings lane,
live today); setup writes every collected secret into `user/secrets/<domain>.json`
via `rt secrets set` (sops/age; domains `rt`, `deck`, `board`), and the
snapshot daemon commits + pushes. Readers use the shared secrets module
in-process; the daemon's grant-gated `secrets:forge-token` stays the
out-of-process path (gitq precedent). **Team-scoped secrets** (the team's
switchboard admin token, Slack client secret, shared service tokens the pack
declares) are this spec's addition: `teams/<slug>/mattstack/secrets/*.json`
encrypted to every member's public key (`.sops.yaml` in the team repo with N
recipients); invite redeem contributes the invitee's key (§6.3). The plaintext inventory (`~/.mattstack/rt/secrets.json`, board `.env`
Slack values, deck `platform.json` CF token/zone + session secret + password
hashes) is imported and retired by the settings lane (workstream S; `rt` domain
already live). Board/gitq/deck read through the shared module; key names stay. Member removal = forge ACL
revoke + `rt secrets rotate --team` (the residue — a removed member's old
copies — is documented, not hidden). Plaintext never touches git; lanes/pods
never receive the key. Auto-snapshot (RT-30, V1) commits and pushes these
writes in the background.

Deck's *publish* features (cloudflared tunnel, Cloudflare token/zone, CF
Access, public domains) are out of scope for the installer; their secrets'
home is the user-scope RT-32 layer, which is where MAT-384 moves them.

## 11. Distribution, update, identity

- **Release train** (m4ttstack/rt is public, so its Releases host the
  artifacts; the MAT-360 meta repo's role narrows to "the marketplace"): one
  tag on m4ttstack/rt builds rt (arm64), bundles helpers
  per `deps.lock`, builds the app (`xcodebuild build … CODE_SIGNING_ALLOWED=NO`
  then `build.sh`'s own inside-out Developer ID signing — not
  `archive/export`; hardened runtime, entitlements: `allow-jit` first; add
  `allow-unsigned-executable-memory` only if the bundled rt crashes), notarizes
  + staples, produces `mattstack-<ver>.dmg` (first install) and
  `mattstack-<ver>.zip` (`ditto --sequesterRsrc --keepParent`) for Sparkle,
  runs `generate_appcast` (EdDSA key from a CI secret, last 3 zips for deltas),
  uploads DMG + zip + `appcast.xml` (+ deltas, `SHA256SUMS`) as GitHub Release
  assets — the feed URL is
  `https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml`
  (not GitHub Pages) — then the headless clean-room job (§12.2 layer a).
- **Sparkle**: SPM dependency, `SUFeedURL`, `SUPublicEDKey`, numeric increasing
  `CFBundleVersion` = `major*1e6 + minor*1e3 + patch` (2.8.0 → 2008000),
  `SUScheduledCheckInterval 21600`, `SUEnableAutomaticChecks`, `SUAutomaticallyUpdate`,
  `SUVerifyUpdateBeforeExtraction`; no sandbox XPC keys; gentle reminders
  (menu item "Update available") since the app is `LSUIElement`; sign inside-out,
  never `--deep`; dev flavor disables checks.
- **Install on the user's machine**: DMG drag to `/Applications` (fallback
  `~/Applications`); first launch guard "running from a DMG/translocated path —
  please move me to Applications"; the app records `mattstack.appPath`.
  `~/.local/bin/rt` → `<appPath>/Contents/MacOS/rt` symlink (dev mode overwrites
  with the wrapper script as today; `currentMode()` reads through the link).
  `rt update` → `POST /update/check`.
- **Identity** (ruling 13): frozen; macOS 14 floor; arm64-only; Info.plist gains
  `LSMinimumSystemVersion 14.0`, `CFBundleURLTypes` for `mattstack://`,
  `NSUserNotificationAlertStyle` kept, no `LSFileQuarantineEnabled`.
- The `rt-darwin-*.tar.gz` is dropped; `mattstack-<ver>.zip` is the headless
  artifact (`ditto -x -k` + `<app>/Contents/MacOS/rt --post-install`);
  `rt --post-install` becomes the headless entry into `rt setup apply`
  (`--non-interactive --team-of-one`; a plain first `rt` run only prints a
  hint to run `rt setup`, it does not auto-install).

## 12. Dev mode, testing, uninstall

### 12.1 Dev mode
Unchanged from MAT-383: `mattstack-dev.app` / `com.mattstack.app.dev`,
source-runner daemon shim, `rt settings dev-mode` handoff. The Xcode project
has two schemes (mattstack, mattstack-dev) producing the two bundles; both
flavors build from `project.yml`. The dev app's setup window runs against the
real `rt` from the checkout or the stub (env).

### 12.2 Testing
- Swift: XCTest for `ReadinessModel` (plan JSON → rows → enablement), step
  stream rendering, version-change restart logic, permission status mapping.
  XCUITest flows against the stub rt: create-happy, join-happy, join-no-access,
  permission-denied-then-granted, install-step-failure-retry, uninstall.
- rt: bun tests for validators (network mocked), plan composition from team
  settings, team create/join/invite crypto, relay client, apply idempotency,
  deps resolution/link/unlink, uninstall plan.
- Clean room (ruling 12): (a) release workflow job on `macos-latest`: download
  the zip, `ditto`, `<app>/Contents/MacOS/rt --post-install --non-interactive
  --team-of-one`, `rt verify --ci`; (b) `rt-tray/vm/` holds the golden-image
  recipe (Tart or VirtualBuddy, macOS 14 and 26 images, no CLT/brew, a
  throwaway Apple ID-free user) and `walkthrough.sh` which restores the
  snapshot, mounts the DMG, launches the app with `RT_STUB_SCENARIO` unset and
  a test team on a throwaway forge org, drives the five screens by
  AppleScript UI scripting against the app's accessibility identifiers
  (XCUITest runner gated on Xcode being installed in the guest; including the
  real FDA/Login Items dance) and then Sparkle vN→vN+1 from a local appcast
  (`MATTSTACK_APPCAST_URL` + `--allow-appcast-override`); screenshots are
  archived per run; (c) a second macOS user on Matt's Mac for daily smoke.
  Release gate: (a) and (b) green on the candidate.

### 12.3 Uninstall
`rt uninstall` computes and shows the list, then: unregister daemon + deck
(SMAppService via socket), `deck remove --managed` board/gitq, privileged
removal of proxy daemon + CA + sudoers (admin prompt), remove tagged
`~/.local/bin` links and the shell-rc block, `--uninstall-extension` in each
editor, `claude plugin uninstall` + marketplace remove for what we added (per
config dir), ask about `~/.mattstack` (default keep), move the app to Trash,
print what stayed. The Settings menu item calls the same verb with a
confirmation sheet.

## 13. Lanes, sequencing, dependencies

| Lane | Team | Contents | Depends on |
|---|---|---|---|
| L1 rt setup verbs | RT | §5.2 verbs, validators, plan/apply, team create/join/invite/publish, deps resolve/link, uninstall, permissions merge, `--post-install` → apply | L2 for account rows; MAT-384 for deck managed-app steps (stubbed behind the contract until then); RT-50 keys the tray reads |
| L2 team secrets | RT | **Shrunk**: RT-32 core, RT-30 snapshot (V1) and RT-31 restore are the settings lane's (S, H2, R). L2 = team-scope recipients (`teams/<slug>/mattstack/secrets/`, N-recipient `.sops.yaml`), the invite-reply key exchange, `rt secrets rotate --team`, `rt team members sync\|remove` | settings lane S (merged) |
| L3 app | MAT | xcodegen project + schemes, Sparkle, setup window + 5 screens, Settings panes, PermissionsService, ServicesRegistrar, PrivilegedInstaller, tray.sock routes, RtClient, stub rt, XCTest/XCUITest | L1 contract (JSON shapes agreed first; stub carries it) |
| L4 release | RT/MAT | deps.lock + helper bundling, rt-daemon→rt rename, DMG, appcast, notarization, headless install job, thin `rt update`, README/verify sweep | L3 project |
| L5 suite artifacts | BOARD/GITQ/DECK/SKILLS/FB | board + gitq `bun --compile` binaries with published rt-client (their settings/secrets reads are the settings lane's deck/board/gitq lanes; their state.db adoption is a follow-on), skills as plugins (no `~/.claude/skills` symlinks), deck release + SMAppService-owned platform registration + private node/portless + privileged helper + our own proxy plist, fast-browser artifact + own setup + marketplace source fix, mattstack marketplace = MAT-360 meta repo, acme pack `requirements.jsonc` + `dev-ports.state.json` writer + local-db-mcp decision | MAT-384 for TLD/managed apps; settings lane's deck/board/gitq lanes for config reads |
| L6 relay invites | BOARD | `/v1/invites*` opaque endpoints on the shared Railway relay; rate limiting; prune | — (matt-gated deploy) |
| L7 clean room | MAT | `rt-tray/vm/` golden images + walkthrough, second-user smoke notes | — |

### 13.2 What the settings lane ruled and ships (V4/V5)

Reply file: `~/.mattstack/user/local/reply-2026-08-20-settings-lane-to-installer.md`;
program spec: `docs/superpowers/specs/2026-08-20-suite-settings-migration.md`.
Ruled and merged (PR #5, 2026-08-20): one suite registry in `@mattstack/rt-client`
with `mattstack.integrations` `{forge:{host,provider}, slack?:{appId,clientId,channel,callbackPort}, linear?:{teamKey}, switchboard?:{url}}` (team),
`mattstack.tracking` `{repos:{"<host/group/repo>":{caches}}}` (team, merged under machine
`rt.repoTracking`), `mattstack.appPath` (machine), `claude.marketplaces`/`claude.plugins`
(user+team), `deck.*`/`board.*`/`gitq.*`; pack requirements are pack-side
`requirements.jsonc`; apps read in-process; `rt home init`, `rt home key
export`, `rt secrets set|list|rotate` live. In flight overnight (their mandate:
run to completion, merge as green): rt keys wave (incl. `rt.cron` to machine,
legacy rung deletion, `rt settings llm` deletion), deck/board/gitq settings
lanes (incl. the rt-context extension off `secrets.json`), H2 snapshot daemon,
R restore. L1 reads these keys directly; nothing is stubbed.

### 13.3 Ticket amendments to file (superseded or refined by this spec)

MAT-382 (verb shape adopted as ruled; Slack create-app lives in the app's
owner path; wizard is the app), MAT-379 (r.3 hosted relay now *opaque-invite
only*, peering needs E2E first; phase C = forge access granted at mint,
verified at redeem; invite via stdin/prompt never argv), MAT-374 (r.2
container; r.6 app owns ceremony incl. restore), RT-30 (container wording;
auto-snapshot in L2), RT-31 (restore ceremony is the app's "already have
settings" path; materialize contract), RT-32 (team-scope recipients + reply
key exchange), MAT-383 (ruling 4 label superseded by `com.mattstack.daemon`;
x64 dropped; phase-1 spec gets a "superseded by" banner; `/Applications`),
MAT-360 (artifact host = m4ttstack/rt Releases; meta repo = marketplace;
`rt install` absorbed), MAT-384 (deck platform registration moves to the app;
CF secrets home), DECK-1/4/7/11/56 (no curl installer, no `deck update`, no
"declined" fallback, no installer hosting DNS; restore is the app's), DECK-13
(dev-flavor deck path), MAT-372 (close: superseded), MAT-331 (native app exempt
from the design system), FB-33 (satisfied by V2), SKILLS-39 (`onboard` retires
in favour of the wizard), working-agreement DoD (curl line).

### 13.4 Start order

Start now, in parallel: L7, L3, L1/L2 (worktrees; main belongs to the settings
migration lane). Then L4, L5, L6. The app ships to teammates only when L1–L7
are green and MAT-384 has landed (board/gitq reachable at their `.mattstack`
names). Tickets: one per lane in its product team, linked to MAT-383; releases,
DNS (`mattstack.dev/join`), Railway, and Apple steps carry `matt-gated`.

## 14. Risks and open items

- Bun hardened-runtime entitlement minimum must be verified on the first
  notarized build (start with `allow-jit`).
- `launchctl kickstart -k` against SMAppService agents on 14/15/26 must be
  verified in the VM layer; fallback is unregister/sleep/register.
- macOS 26's background-task prompt behaviour for SMAppService agents is not
  fully characterised; the Background services row copy may need a second
  state.
- Peering over the shared relay stays blocked on E2E envelope encryption
  (recorded for the board lane).
- Deck's proxy decision (absorb vs bundle portless) is deferred behind the one
  admin prompt; a deck ticket tracks it.
- `gh`-less GitHub users and GitLab-only teams exercise the URL path for repo
  creation; both must be in the XCUITest matrix.
- Product name "mattstack" is frozen by ruling 13; a rename after dogfood
  would reopen bundle ids, labels, TLD and directories.
- Slack app *Collaborators* (MAT-382 open question): whether the owner wizard
  needs a guided add-collaborators step is unresolved; the create-app row may
  gain a manual sub-step.
- Multi-team machines: `rt setup plan` needs a "current team" selector; the
  first implementation assumes one team per machine and surfaces a picker only
  when more exist.
- Team-scope secrets (N-recipient `.sops.yaml` in the team repo) extend the
  settings lane's single-recipient model; coordinate the file layout with that
  lane before L2 lands.
- `local-db-mcp` has no distributable source; capture-evidence/query flows in
  the acme pack depend on it.
