# rt-tray/vm — clean-room testing (installer spec ruling 12, lane L7)

Golden macOS VM images, a scripted walkthrough of the mattstack.app installer,
a second-macOS-user smoke, and a local runner for the CI headless install.
Every run's deliverable is `artifacts/<run-id>/` (screenshots, logs,
`phases.jsonl`, `report.md`). Skipped phases are reported as skipped, never green.

## What this layer verifies — and cannot

| Layer | Verifies | Cannot verify / not automated |
|---|---|---|
| (a) `scripts/e2e-cleanroom.sh` (same recipe as the release workflow's `test-install` job) | artifact extracts; `rt --post-install` installs `~/.local/bin/rt`, the app, the daemon config; `rt verify --ci` exit 0 | anything needing a GUI session or approval (daemon boot is a warn under CI), Gatekeeper (no quarantine on CI downloads) |
| (b) `run/walkthrough.sh` (Tart clone of a golden image) | real DMG → /Applications → first launch under Gatekeeper; five setup screens; FDA + Login Items + Notifications dances; `rt verify --json` green; tray.sock `/version`; Sparkle vN→vN+1 and daemon restart; screenshots per screen | the **"Background Items Added" notification** (a banner, not a dialog — it is neither clicked nor asserted; the Login Items row is asserted through `GET /services` / `rt setup status` instead); the **FDA relaunch** is driven (the app's own "Relaunch" button) but the OS applying FDA is asserted only via the app's probe row; notarisation/stapling of Matt's signing (a locally built DMG is unnotarised → run with `--no-quarantine`, reported in the ledger) |
| (c) `run/second-user.sh` | layer (a) under a second real macOS user on Matt's Mac, with a live GUI session so SMAppService registration is real | nothing about the five screens; the user must be created and logged in once by Matt |

(rest of the README is written in Task 14)
