---
name: rt-sdm-connect
description: Use when the user asks to log into an environment via StrongDM/sdm, connect to a database tunnel, or get database access for an environment. Examples include "log into staging via sdm", "connect me to the QA database", "get me a tunnel to production", "sdm connect". Drives rt's sdm JSON verbs; never calls the sdm CLI directly.
---

# rt sdm connect (agent orchestration)

Connect the user to a StrongDM-backed database environment using rt's JSON
primitives. rt owns the mechanics (app launch, login flow, access request,
tunnel, verification); this skill owns sequencing, matching, and the human
gates. All commands are non-interactive and safe to run without a TTY.

Never invent values: durations come from the envelope's `durations` list,
the reason comes from `defaultReason` (omit `--reason` to use it), and
production requires an explicit human yes.

## Sequence

1. **Preflight.** `rt sdm status --json`
   - `ok: true` and authenticated: continue.
   - `health: "not-authenticated"`: run `rt sdm login` (silent browser flow;
     no TTY needed). If it exits non-zero telling you to run
     `rt sdm login --manual`, STOP and give the user that exact command to
     run in a terminal; you cannot complete the SAML hop for them.
   - `health: "not-installed"`: STOP; the sdm CLI is missing. Relay the
     install message.
   - `appRunning: false` alone is fine: connect launches the app itself.

2. **Discover.** `rt sdm connections --json`
   - Match the user's request against `label`, `tier`, and `key`.
     "staging" should match a connection whose tier or label says staging.
   - Exactly one plausible match: proceed.
   - Multiple plausible matches: ask the user which one, showing labels.
     Never guess between two environments.
   - No match: show the user the available labels and ask.
   - `ok: false`: relay `error` and stop (after the login step above, this
     should not happen; do not retry more than once).

3. **Production gate.** If the chosen connection has `production: true`,
   ask the user explicitly ("This is production: <label>. Connect?") and
   only on a clear yes add `--confirm-production` to the connect command.
   Never pass that flag without a human yes in this conversation.

4. **Connect.** `rt sdm connect <key> --json`
   - Omit `--duration` and `--reason` (rt defaults to 8h and the
     enrichment-authored reason). Pass `--duration` only if the user asked
     for a specific one; it must be a value from the envelope's `durations`.
   - Exit 0: report success (below).
   - Exit 1: read the envelope. `stage: "login"` means the session expired
     mid-flow: run `rt sdm login` once and retry the connect once.
     `stage: "confirm"` means the production gate (step 3). Anything else:
     relay `error` and `hint` verbatim and stop.

5. **Report.** From the success envelope, tell the user: the label they
   asked for, `address`, `url`, `database`/`schema`, and whether the tunnel
   was `verified` (if `verified: false`, say the tunnel is up but the test
   query did not confirm; suggest retrying their query). Do not paste the
   whole envelope.

## Contract notes

- JSON is on stdout; progress lines are on stderr. Parse stdout only.
- `connected: true` in the connections envelope means a tunnel is already
  live at `address`: report it directly instead of reconnecting, unless the
  user asked to reconnect.
- These verbs are rt's stable agent surface. If a field seems missing, the
  fix belongs in rt (repo-tools), not in ad-hoc `sdm` CLI calls here.
