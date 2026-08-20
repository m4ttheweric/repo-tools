# Linear sweep — distribution + mac app rulings (2026-08-20 14:41)

## Binding rulings (sources in parens)
- Front door = signed Mac app, not curl; rt-tray → mattstack = installer AND onboarding wizard (MAT-383). Board's onboarding role shrinks to "opens populated at the end" (MAT-382/383).
- Downloading mattstack.app installs the whole suite (rt + deck + board w/ switchboard peering + skills pack + fast-browser); invited teammate lands fully wired (roadmap doc 017c24a92fcf).
- Curl front door retired to internal bootstrap machinery; deck's separate installer door folds into the app (MAT-360 amendment).
- Homebrew retired; app installs AND updates rt from m4ttstack/rt GitHub releases; app self-updates via Sparkle (or equivalent); `rt update` thin (MAT-383 c.3; MAT-360). GitHub releases = single publish target, app = single consumer. Updater-drift rule: installer + updater read the SAME releases.
- Identity: com.mattstack.app, on-disk mattstack.app; daemon label ruled com.rt.daemon (SUPERSEDED by smoke: com.mattstack.daemon[.dev], ratified by form 2026-08-20). m4ttstack = GitHub org slug; brand = mattstack (mattstack.dev owned).
- Migration from old rt-tray in scope (quit, unregister stale SMAppService, remove, install+register).
- Dev mode: separate dev identity (mattstack-dev.app / com.mattstack.app.dev), dev daemon = source runner, `rt settings dev-mode` switches which app is registered; update checks off in dev. CLI wrapper at ~/.local/bin/rt unchanged.
- Implementer notes: delete cached AppIcon.icns; osascript/pkill names track CFBundleExecutable; x64 notarization leg is copy-not-submit.
- MAT-384: board + gitq = MANAGED deck apps (registry managedBy), board.mattstack / gitq.mattstack, no compat aliases; tray monitors deck (liveness + restart/notify), plumbing only; sequenced after RT-50.
- Suite install model: "rung ladder dead; install is suite-only (MAT-379 ruling 1, reaffirmed 2026-08-19); `rt install` internal machinery never user-facing; no a-la-carte install path" (roadmap, MAT-360). v1 suite = rt + deck + board + skills pack + fast-browser. "mattstack requires rt; rt always present."
- MAT-374 ruling 6: rt owns mechanics, Deck (now app) owns ceremony; catastrophe restore on bare machine = installer → rt → `rt restore`; RULE: every ceremony has a CLI equivalent.
- Team/invite: team definition lives in the team repo; switchboard relay-only; encrypted-blob registry cancelled; invite redemption first step = get forge access to team repo (MAT-379 phase C amended). Team's domain pack comes pre-installed and running for an invited member; pack must be a plugin a machine can install (MAT-382).
- MAT-382 r.3: personal credentials per user; team config eliminates team-level questions only; every declared integration runs its personal step (gitlab PAT, github token or borrowed gh auth, linear key, slack OAuth click). r.4: `rt setup` verb tree = setup → gitlab/github/linear/slack/team/home; each integration status + connect; bare `rt setup` = state-driven walk (headless fallback). r.5: wizard compiles step list from team's declared integration set and drives one `rt setup` leaf per step so CLI and wizard cannot drift; owner path = same wizard leading with create-a-team incl. slack create-app and inviting teammates. Invite accepted via prompt, not shell arg (key exposure).
- Settings/state: four stores one resolver; app reads/writes via `rt settings`; one state.db per app; RT-50: ~/.mattstack/rt = runtime only; RT-46 installer creates folded ~/.mattstack from day zero; RT-49 installer seeds rt.repoRoots (`rt settings set rt.repoRoots '["~/Documents/GitHub"]' --scope machine`). MAT-384: deck platform.json CF token is plaintext secret → secrets layer (RT-32).
- Release: v2.8.0 waits for rebrand; ships resolver+repoRoots+state.db+rebrand together.
- Process: consensus before execution; no mattstack work without a ticket in the product's team; matt-gated label for pushes/releases/DNS/accounts. MAT-374 r.8: config = defaults always user-overridable; binding lives in pack skill text.

## Requirements (installer scope)
rt binary + daemon + registration; deck; board + gitq as managed deck apps; skills: mattstack@mattstack plugin + team's domain pack via Claude marketplaces (`claude plugin marketplace add` + `claude plugin install`); fast-browser command on PATH (FB-33); folded ~/.mattstack layout; seed rt.repoRoots; shell integration blocks, ~/.local/bin shims, Claude marketplaces/enabledPlugins (settings-inventory doc). VSIX install not ruled anywhere in Linear (rt verify's brew vsix check deleted rather than fixed).
Installer flow (MAT-383): fresh download → bootstrap suite → permission walkthrough → invite redemption → hand off to populated board.
Permissions named: notifications, login items, security/privacy grants, Full Disk Access; dev bundle id gets own grants. DECK-13: binaries under ~/Documents wedge launchd agents (TCC/dyld) → install to ~/.local/bin.
RT-31 pattern to generalize: doctor → remediation table → interview → verify every claim.
rt verify must be green: legacy-dir canary, shim installed, PATH precedence of ~/.local/bin (known minor: presence not order).

## Deck/board/gitq today
Deck: compiled bun binary at ~/.local/bin/deck; `deck setup` installs platform LaunchAgent; labels com.mattstack.deck.*; state ~/.mattstack/deck (settings/access/platform/registry/api .json); ports 11000-11999; platform at deck.mattstack; edge via portless (root LaunchDaemon sh.portless.proxy binding 443, --tld localhost --tld mattstack, local CA certs, /etc/hosts sync); cloudflared tunnel + CF Access for public; installer curl deck.mattstack.dev|sh (DECK-7 unshipped; DECK-11 ceremony matt-gated). Landmines: DECK-10 kickstart doesn't re-read plist (bootout+bootstrap), DECK-13 TCC wedge, DECK-57 stale interpreter path, DECK-58 portless bakes fnm path, DECK-9 allocator bind-probe, DECK-14/15/12.
mr-board: deck entry mrs port 11006 label com.mattstack.deck.mrs at mrs.localhost; rt-client (socket + relay 9401); team config from team repo team.jsonc on boot; Slack per-user OAuth via `bun run setup`.
gitq: gitq.localhost; rt-client; secrets via rt daemon; state ~/.cache/gitq/work.

## Dependencies
RT-47/48/49 DONE. RT-50 (other agent): notifications.json/panel-columns.json → settings keys (tray reads panel-columns + notification settings). MAT-384 after RT-50. RT-32 secrets backlog (tokens to ~/.mattstack/rt/secrets.json 644 meanwhile). MAT-382 `rt setup` tree NOT BUILT. MAT-379 phase C not started. MAT-360 meta repo/marketplace not started. DECK-11/DECK-7 deck release artifact needed. SKILLS-39 last.

## Open questions flagged
container-vs-clone for ~/.mattstack (MAT-374; RT-30); ~40 personal items outside ~/.mattstack; Slack collaborators spike; invite exposure; app-config-token ergonomics; MAT-372 deck-vs-rt front door (superseded by MAT-383 but not closed); mr-board name call; RT-50 rt hooks/rt plugin; events.db merge; Sparkle not pinned; DECK-13 deck dev-mode; design system unscheduled.

## Phase plan (roadmap)
1a rt house DONE. 1b front door NOT STARTED (MAT-360 meta repo/marketplace/one release; app = front door; folded layout day zero; org housekeeping). 2 onboarding NOT STARTED (MAT-382 rt setup tree; app wizard MAT-383; invite flow MAT-379 C). 3 safety net (RT-30/32/31, SKILLS-34). 4 pipeline depth. Last: SKILLS-39.
MAT-383 phase 1 = rebrand (done today); phase 2 = installer/updater duties + wizard (inferred).
