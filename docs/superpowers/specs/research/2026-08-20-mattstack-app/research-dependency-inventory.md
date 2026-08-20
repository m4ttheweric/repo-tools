# Suite external dependency inventory (2026-08-20 15:28) — distilled

## Hard, suite-core
- git: everything; /usr/bin/git via Xcode CLT (GPL) → CLT install.
- fzf ≥0.71: all rt pickers; brew today; MIT static → bundle.
- bun 1.3.x: RUNTIME for mr-board (bun run from checkout), gitq (#!/usr/bin/env bun), claimview rt-dev-hook.ts (pack script), rt-client consumers, rt dev-mode; build-only for rt/deck. MIT static → bundle (packs may ship bun scripts) + compile board/gitq.
- rt + mattstack.app: own.
- herdr ≥0.7.5: rt herdr-agent/launch, tray HerdrBridge, mr-board, gitq, shepherdr, claimview dev-servers; H for shepherdr/board launches, O elsewhere (guarded by socket/HERDR_ENV/command -v). ~/.local/bin/herdr 0.8.0 upstream release binary (Rust static); self-updates; installers: curl herdr.dev/install.sh | sh, brew, mise. → provision via its installer (not bundled: self-update would break bundle seal).
- Claude Code: every skill; plugin mgmt; native installer ~/.local/bin/claude; proprietary → provision via official installer (checklist row).
- jq: mattstack resolve-args.sh (15 copies), ci-*.sh, claimview gql/query, statusline; /usr/bin/jq on macOS 26 only; MIT static → bundle.
- shells/coreutils + macOS tools (open lsof ps launchctl xattr osascript pbcopy security plutil PlistBuddy mdfind afplay caffeinate sudo): system.
- node ≥24: fast-browser (MCP+CLI, Playwright fork), portless (deck), Linear MCP (npx mcp-remote), local-db-mcp, claimview token-capture.cjs; fnm today → bundle private pinned node for suite-internal use (fast-browser, portless); team dev needs its own node anyway.
- Google Chrome: fast-browser/claimview evidence (H there), rt sdm (O) → Tools row (optional unless team requires).
- fast-browser: plugin + CLI + pinned Playwright runtime (GH release tarball from m4ttheweric/playwright → ~/.fast-browser/runtime) + Chrome extension side-load + keychain token; CLI shim currently → dev checkout → needs published artifact (npm @mattstack/fast-browser exists).
- portless ≥0.15.5: deck H; npm-global under node 24; root LaunchDaemon sh.portless.proxy + local CA; deck proxy-restart needs /etc/sudoers.d/local-apps-proxy-restart.
- deck: ~/.local/bin/deck bun-compiled, built locally, no published release; supervises mrs/gitq/... plists.
- python3 stdlib: shepherdr (herd DB sqlite/JSON), hooks (guarded), claimview resolve-target.py + inline; brew python today; CLT provides python3 → fine once CLT installed; could port to bun.
- Claude plugins: mattstack@mattstack (directory marketplace = symlinks to checkouts!), claimview@assured (directory = team clone), fast-browser, current-time, superpowers. mr-board/gitq skills symlinked into ~/.claude/skills. → need published marketplace (MAT-360).

## Optional
- gh (GitHub flows; static) / glab (GitLab; T/H for GitLab teams; static) → bundle both, expose per team forge + auth rows.
- terminal-notifier MISSING (osascript fallback) → drop.
- lnav/logdy (log viewers), chafa/kitten/fd/bat/eza/delta (rt nav/commit previews), tmux/zellij (README stale, NO callers) → not installed; degrade.
- Editors (Cursor/VS Code) + CLIs → Tools row optional; extension install via app bundle CLIs.
- codex, Ollama, cloudflared (deck publish; needs tunnel login + CF token) → optional.
- cswap (Matt-only; uv tool install -e checkout), GitKraken gk hooks in ~/.claude/settings.json (Matt-only; would spray errors if copied).

## Team-specific (claimview/assured)
- doppler (brew + rt intercept shim; shim must precede /opt/homebrew/bin), sdm (cask + SAML), ldcli (brew tap), pnpm, Postgres local, Linear MCP, local-db-mcp, Figma/FullStory MCP. → pack declares; checklist rows with Install/Connect.

## Runtimes
bun: runtime for board/gitq/claimview hook → compile board/gitq; bundle bun for pack scripts + rt-client consumers. node: fast-browser, portless, MCPs → bundle private node. python3: CLT. Rust/zig: no (herdr release binary). Swift/Xcode: build only.

## Surprises / breakers on a clean Mac
1. Source-checkout coupling: ~/.local/bin/rt dev wrapper; fast-browser shim → checkout; directory marketplaces symlink checkouts; skills symlinks; cswap editable; gitq bun link; hand-edited ~/.claude.json MCPs. Need published artifacts: mattstack plugin, fast-browser, claimview pack, gitq (stale dist), mr-board (no package), deck (no release).
2. mr-board: file: deps tui-kit + rt-client; absolute paths in deck plists; triage via rt cron with absolute bun path.
3. rt verify/README stale (tmux/zellij); rt daemon install needs tray running.
4. launchd PATH capture (deck bakes PATH; rt daemon reconstructs via $SHELL -ilc); doppler shim shadowing.
5. Root pieces: portless daemon + CA; sudoers; keychain; FDA; Chrome ext side-load; xattr.
6. jq assumed system (26 only). 7. python3 brew (CLT stub prompts). 8. claimview pack stale paths (dev-ports.state.json never created post-RT-28 → get-bearer-token/query broken; feature-flags mentions @assured/dev-ports; mr-board-doctor-api ci-triage.sh path). gitq dist stale reads ~/.rt/secrets.json. 9. plugin version drift. 10. Matt-only hooks in global settings. 11. Auth no installer can bundle (GitLab token, glab/gh auth, doppler, sdm, cloudflared, Linear, fast-browser pairing, Slack, Chrome Auth0). 12. rt prod latent bun branches (lib/enrich.ts:540, bunx pino-pretty, commands/plugin.ts).
