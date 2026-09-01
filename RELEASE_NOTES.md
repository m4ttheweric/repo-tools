the mattstack.app release. rt now ships inside a signed, notarized Mac app that installs the whole suite, keeps itself updated through Sparkle, and walks a new machine through everything macOS gates behind native prompts. standalone CLI downloads are retired. the clean-room proof runs the entire journey on a fresh VM: Gatekeeper accept, headless Command Line Tools install, 21-step post-install, daemon alive under launchd, verify green.

### mattstack.app

- rt-tray is rebranded and rebuilt as mattstack.app: signed, notarized, stapled, distributed as dmg + zip with a signed Sparkle appcast and per-release deltas
- onboarding wizard drives setup end to end: welcome, permissions (Full Disk Access, notifications, background items), team join or team-of-one, install progress with per-step retry
- flavor exclusivity: one registered flavor per machine (prod XOR dev), self-healing to the declared mode instead of racing for sockets
- `rt --post-install` refuses transient roots (DMG, translocation), sweeps legacy installs, and completes non-interactively on a fresh Mac with no git identity (a fallback identity covers the initial home-repo commit)
- headless Apple CLT install via the softwareupdate trigger-file flow, claimed done only after a green git re-probe; the app never invokes the git stub before CLT exists, so Apple's install dialog stays gone
- setup that must be driven by the app refuses fast from a bare terminal instead of hanging ten minutes on an unanswerable request
- `rt uninstall` reverses what the installer did, with a consent gate for ~/.mattstack; `rt update` asks the app

### The setup verb family

- `rt setup plan|status|apply`: a validator-driven plan, an NDJSON apply engine with resume and stop-on-fail, and an interactive walk; `--post-install` is headless apply
- `rt verify` IS the setup validators, one implementation; `--ci` is the machine-gate variant
- `rt tools install|setup`: brew, vendored, and CLT installs with tool-owned setup steps
- `rt services`: launchd facade with need-event waits over tray.sock
- `rt setup <integration> status|connect` (Slack app creation included); accounts and access validators with honest exit-2 error envelopes
- security hardening rounds throughout: exact-value secret redaction, team-declared data never picks a privileged target, vendor-install RCE closed

### Teams

- `rt team create|publish|invite|join|members|status`: a scaffolded team zone pushed at install, opaque invites (AES-256-GCM, AAD-bound codes) redeemed through the switchboard relay, reply-key exchange and peering, and roster-driven secret recipients
- team-scope secrets: N-recipient sops with `rotate --team`
- membership permission model and forge grants minted with the invite

### The bundle

- the app carries the whole suite under Contents/Helpers: deck, board, gitq, console, chat, fast-browser, cloudflared, and the tool floor (fzf, jq, gh, glab, bun, node, sops, age-keygen), every binary signed inside the sealed bundle
- a central bundle pipeline builds managed apps from source: a `repo` field on the deps.lock row marks an app buildable, the app repo's own `mattstack.deck.json` carries the recipe, and each dispatch publishes an immutable per-app release plus a deps.lock PR
- publishing lives in its own job so no app recipe ever runs beside a credential; pins come only from the trusted plan matrix, and the release job recomputes hashes from the uploaded artifact
- bun-compiled services get `allow-unsigned-executable-memory` beside `allow-jit`: bun's JIT emits into plain malloc pages, and without it a long-running daemon is codesigning-killed mid-run while every short smoke passes
- check-bundle asserts the full contract from inside the signed bundle, and the VM harness (golden image + walkthrough) proves the install on a machine stricter than any real Mac

### Skills

- `rt skills compile|check`: a pure compile core turning skill sources into compiled packs, with surface.jsonc enforcement, registered vs internal fill modes, and manifest IO
- `rt skills surface`: list, set, apply, with an fzf palette and a reviewed confirm on the accept path
- `rt skills link`: reconciles bundled skill trees into Claude Code; `--from <dir>` links an app's bundled skills and `.skillsignore` keeps maintainer-only skills off user machines
- bundled skills ride each app's release artifact and land under Contents/Helpers/skills

### Home repo and settings

- your settings become a local-first git repo at `~/.mattstack/user`: initialized offline, committed with history, backed up only when you add a remote; `rt home key import` brings an external age key into the keychain
- per-machine profiles under `user/local/<machine>` with a picker on fresh machines and safe adopt-on-reinstall; the materialize phase regenerates PATH shims, daemon registration, and tool setups as init's last step
- `rt.hooks` becomes a settings key with hooks.json as a self-healing derived cache
- the suite settings resolver (`@mattstack/rt-client`) is the one store every mattstack app reads through

### rt runner and the Go UI

- rt's prompts and step spinners render through a bundled Go helper (rt-ui) over NDJSON; Ink is gone and the TS CLI is UI-free by hard rule
- `rt runner`: a board of a repo's services in headless herdr panes, tmux-backed by default; `rt run` presets launch through the seeded board, detect and latch served URLs, and fan out with layout-smart pane placement
- fzf picker chrome: accent bar, left-edge pickers, footer keys, a patched fzf glyph, and resize-aware heights
- the omit-args convention is now enforced: every leaf that requires a positional shows a picker instead of erroring (gate + 24 leaf fixes)

### rt chat

- group chat and presence for the agents in the estate, over the daemon: rooms, DMs, mentions, away status, invites typed into panes, and a web viewer every post links into
- delivery hardened across five rounds: socket-first push, retry with pending sweep and backoff, cross-session envelopes, wake re-arm after daemon restarts
- sign-in/join/sign-out/away ship as a Claude Code plugin with session hooks, published in the mattstack marketplace and installed by setup

### Daemon

- stability audit and six-phase hardening: the API port retries on EADDRINUSE instead of crashing, sync-exec is banned from the daemon thread, honest supervision and trust boundaries, and an age-based log janitor with `rt.logRetentionDays`
- repo identity re-key: every store and daemon verb keys on a stable serialized identity with legacy heal; `rt repos locate` re-points the index, worktree registry, and git admin files in one pass, and `rt repos prune` carries a retired name's data forward instead of evicting it
- `rt cd` gets a daemon-served repo-list cache with a live fallback and ctrl-r refresh
- project-mrs learns section tags (codeowner sections, scope sections, demand backfill) with realtime tag healing
- run tracking: `/api/runs` REST surface, run-state round trips (CLI, REST, events), and a run-liveness staleness ladder

### Agent coordination

- `rt agent start|resume|show|list`: hand a workspace and tab to another session and resume it, daemon-optional
- `rt pane send`: drive a herdr pane from the CLI
- `rt events`: a small estate-wide event bus

### Release and estate machinery

- every release publishes the Claude Code plugin marketplace; the catalog carries the mattstack pack, fast-browser, and the chat plugin
- internal packages moved off vendored file: deps onto the npm registry (public and private under @mattstack), with self-hosted Renovate keeping the estate current
- CI gates typecheck, unit tests, and doc drift on every PR; the Homebrew tap machinery is retired — the app is the way in

**Full Changelog**: https://github.com/m4ttstack/rt/compare/v2.7.0...v2.8.0
