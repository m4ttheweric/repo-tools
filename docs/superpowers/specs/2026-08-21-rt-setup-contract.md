# rt ↔ mattstack.app setup contract (v1)

The JSON the app renders and the verbs it drives. Companion to
`2026-08-20-mattstack-app-installer-design.md` §5.2–5.3. L1 (rt) implements
it; L3 (app) renders it; the XCUITest stub emits it. Changes bump `contract`.

## Invocation

The app spawns the bundled `rt` by absolute path with `--json` and reads
stdout. Streaming verbs emit NDJSON (one JSON object per line). Exit codes:
`0` ok · `2` user-actionable failure (stdout carries `{ "error": {...} }`) ·
`1` bug. The app passes `RT_APP_SOCKET=<tray.sock>` so rt can call back for
permission status; rt passes nothing back on argv that is secret (codes and
tokens travel on stdin).

Common envelope on every JSON result: `{ "contract": 1, "at": "<ISO-8601>", ... }`.

## `rt setup plan --json` → Plan

```jsonc
{
  "contract": 1,
  "at": "2026-08-21T04:00:00Z",
  "team": { "slug": "acme", "name": "Acme", "mode": "join" | "create" | "restore" | "none" },
  "groups": [
    { "id": "mac" | "accounts" | "access" | "tools",
      "title": "Your Mac",
      "rows": [ Row, ... ] }
  ],
  "canInstall": false,
  "requiredMissing": ["perm.fda", "account.gitlab"]
}
```

Row:

```jsonc
{
  "id": "perm.fda",                       // stable, dotted; namespaces: perm.*, tool.*, account.*, access.*, pack.*
  "kind": "permission" | "tool" | "account" | "access" | "info",
  "title": "Full Disk Access",
  "why": "Reads your repositories' git state so the daemon can show branch and MR status.",
  "required": true,
  "optionalNote": null | "Works without this; you'll see menu-bar badges instead.",
  "status": "ready" | "missing" | "invalid" | "needs-you" | "checking" | "skipped" | "error",
  "detail": "Not granted" | "git 2.50.1" | "token can't see group acme",
  "action": null | Action,
  "recheck": "on-activate" | "on-change" | "manual"   // how the app refreshes this row
}
```

Action (exactly one shape, discriminated by `type`):

```jsonc
{ "type": "open-settings", "label": "Open Full Disk Access Settings…", "target": "fda" | "login-items" | "notifications" | "keyboard" }
{ "type": "request-permission", "label": "Allow", "which": "notifications" }
{ "type": "connect", "label": "Connect", "integration": "gitlab" | "github" | "linear" | "slack" | "switchboard" | "sdm" | "doppler" | "ldcli",
  "fields": [ { "name": "token", "label": "Personal access token", "secret": true, "hint": "scopes: read_api, read_user" } ],
  "alternatives": [ { "id": "use-gh", "label": "Use gh login" } ] }
{ "type": "oauth", "label": "Connect", "integration": "slack", "verb": ["setup","slack","connect"] }   // rt opens the browser and completes the flow
{ "type": "owner-once", "label": "Create the team's Slack app…", "integration": "slack", "fields": [ { "name": "configToken", "label": "App configuration token", "secret": true } ] }
{ "type": "install", "label": "Install", "tool": "herdr", "via": "brew" | "vendor" | "apple-clt" | "bundled-link" }
{ "type": "link-bundled", "label": "Use mattstack's", "tool": "gh" }
{ "type": "steps", "label": "Show steps…", "steps": ["Open chrome://extensions", "Turn on Developer mode", "Load unpacked → ~/.fast-browser/extension/current/unpacked"] }
{ "type": "open-url", "label": "Download", "url": "https://claude.ai/download" }
{ "type": "run", "label": "Re-check", "verb": ["setup","status"] }
```

The app maps actions to behaviour: `open-settings`/`request-permission` are
handled natively (PermissionsService); every other action spawns the named rt
verb (`connect` → `rt setup <integration> connect` with fields on stdin as
JSON; `install` → `rt tools install <tool>`; `link-bundled` → `rt deps link
<tool>`; `run` → the given verb) and then re-requests the plan.

## `rt setup status --json` → Plan

Same shape; `team.mode` reflects the installed state; used post-install and by
`rt verify`.

## `rt setup <integration> connect --json` (stdin: `{"token": "..."}` or `{"useGh": true}`)

→ `{ "contract":1, "integration":"gitlab", "status":"ready"|"invalid", "detail":"...", "scopesSeen":["read_api"] }`

## `rt setup <integration> status --json`

Same envelope as `connect`. For `github`, when gh is authenticated the
envelope also carries `"handle": "<gh login>"` and `"owners": ["<handle>",
"<org>", ...]` (the handle plus `gh api user/orgs[].login`) — the app's
team-create card offers them as `--create-repo` owners.

## `rt setup <integration> create-app --json` (owner-once; stdin: `{"configToken": "..."}`)

The app sends the token as JSON on stdin (no `--config-token-stdin` flag).

## `rt setup apply [--from <stepId>] --json` → NDJSON stream

```jsonc
{ "event": "plan",  "steps": [ { "id": "home.init", "title": "Create your settings home repo", "kind": "rt" | "app" | "privileged" } , ... ] }
{ "event": "step",  "id": "home.init", "state": "running" }
{ "event": "log",   "id": "home.init", "line": "gh repo create m4ttheweric/mattstack-home --private" }
{ "event": "step",  "id": "home.init", "state": "done", "detail": "pushed main" }
{ "event": "need",  "id": "services.register", "request": { "type": "app-register-services", "plists": ["com.mattstack.daemon.plist","com.mattstack.deck.plist"] } }   // rt asks the app to do a native thing; app replies via tray.sock and rt continues
{ "event": "need",  "id": "proxy.install", "request": { "type": "app-privileged", "op": "proxy-install" } }
{ "event": "step",  "id": "pack.install", "state": "failed", "detail": "claude plugin install exited 1", "remedy": "Open Claude Code once so it finishes first-run, then Retry." }
{ "event": "done",  "ok": false, "failedStep": "pack.install" }
```

`kind: "app"` and `"privileged"` steps are executed by the app when the `need`
event arrives (ServicesRegistrar / PrivilegedInstaller). The app records the
outcome and serves it at `GET /setup/need/<id>` on tray.sock as
`{ "state": "pending" | "done" | "failed", "detail": "..." }`. That route
always answers 200 with that body — an unknown or not-yet-started id is
`pending`, never 404 (rt tolerates a 404 as `pending` anyway); `POST` → 405,
empty id → 400. rt polls (1 s) until `done`/`failed`, with a 10-minute
timeout; `done` → the step succeeds with `detail`, `failed` → the step fails
with `detail`. Steps are idempotent; `--from` resumes.

`need.request.type` (v1): `app-register-services { plists }` ·
`app-unregister-services { plists }` · `app-privileged { op: "proxy-install" |
"proxy-remove" }`. The app's NeedBroker must handle all three; anything else
is recorded `failed: unknown need type`.

`services.register` plists: `com.mattstack.daemon[.dev].plist` always;
`com.mattstack.deck[.dev].plist` only when `deck` is bundled (rt checks
`Contents/Helpers/deck` and logs "deck not bundled yet — only the daemon is
registered" otherwise). The app reports a plist whose `BundleProgram` is
missing as `ok:false, status:"notFound"`; rt decides.

Invite codes are copy-paste/deep-link only (16-byte id ‖ 32-byte key,
Crockford base32, ~77 chars, chunked for display). Relay base URL defaults to
`https://switchboard.mattstack.dev` (matt-gated DNS; `RT_INVITE_RELAY_URL`
overrides).

Team-scope secrets layout (in the home repo): `teams/<slug>/.sops.yaml` and
`teams/<slug>/mattstack/secrets/<domain>.json`, domains `board` and `rt`
(`secrets.write` writes them; `rt team join` materializes them).

## Step ids (v1, in rt's order)

`home.init` | `home.restore` · `team.create` | `team.join` · `secrets.write` ·
`git.identity` · `path.link` · `intercepts.install` · `settings.seed` · `repos.clone` ·
`services.register` (app) · `proxy.install` (privileged) · `deck.managed` ·
`skills.materialize` · `skills.link` · `board.keys` · `cron.triage` · `plugins.install` ·
`linear.mcp` · `fastbrowser.setup` · `herdr.integration` · `extension.install` ·
`services.start` · `snapshot.push` · `verify`

## tray.sock (app → rt callbacks and app-side truth)

`GET /permissions` → `{ "fda": {"status":"granted"|"denied"|"unknown","detail":"..."}, "notifications": {"status":"authorized"|"denied"|"notDetermined"|"provisional"}, "loginItems": {"status":"enabled"|"requiresApproval"|"notRegistered"|"notFound"} }`
`POST /permissions/request` `{ "which": "notifications" }` → `{ ok }`
`GET /services` → `{ "agents": [ { "label": "com.mattstack.daemon", "status": "enabled"|"requiresApproval"|"notRegistered"|"notFound" } ] }`
`POST /services/register` `{ "plists": [...] }` → `{ ok, results }` · `POST /services/restart` `{ "label" }`
`POST /privileged/proxy-install` → `{ ok, detail }` (raises the admin prompt)
`GET /setup/need/<id>` → 200 `{ state, detail }` always (`pending` for unknown ids; app-recorded outcome of a `need` event; rt polls until `done`|`failed`) · `POST` → 405
`POST /update/check` → `{ ok }` · `GET /version` → `{ "version": "2.8.0", "build": 2008000, "flavor": "prod"|"dev", "path": "/Applications/mattstack.app" }` — `build` is the numeric `CFBundleVersion` = `major*1e6 + minor*1e3 + patch` (2.8.0 → 2008000)

## `rt team create <name> (--remote <url> | --create-repo <owner>) [--others] --json`

→ `{ "contract":1, "slug", "name", "remote", "created": true|false }`
(`created:false` when the team zone already exists for that remote).
`--create-repo <owner>` creates `<owner>/mattstack-team-<slug>` with gh and
uses its URL as the remote; `--remote <url>` uses an existing empty repo.
`--others` marks the team as having members beyond the creator. Missing both
→ exit 2 `remote-required`.

## `rt team status [--team <slug>] --json`

→ `{ "contract":1, "slug", "name", "remote", "lastPush": "<ISO-8601>"|null, "members": [ { "username" } ] }`

## `rt setup intent restore <org>/<repo> --json`

Records the restore intent after the app has run the real `rt restore
<org>/<repo> --json` (age key on stdin as `{"ageKey": "..."}`; the settings
lane owns that verb). `rt setup apply`'s `home.restore` step then only
verifies the clone and the Keychain key.

## `rt team join --json` (stdin: `{"code": "..."}`) / `--dry-run`

→ `{ "contract":1, "team": {"slug","name","owner"}, "access": "ok"|"denied"|"unreachable", "peering": "applied"|"idle"|"unavailable", "message": "..." }`
(exit 0 even when `access` is `denied`/`unreachable`; exit 2 only for
`invite-unknown`/`invite-malformed`).

## `rt team invite --handle <h> --json`

→ `{ "contract":1, "code": "...", "expiresAt": "...", "pasteBlock": "Install mattstack from … then open mattstack://join/… or paste …", "forgeAccess": "granted"|"manual"|"skipped", "manualSteps": [...] }`

## `rt uninstall --json [--keep-data|--delete-data] [--yes] [--dry-run]`

→ dry-run: `{ "contract":1, "actions": [ { "id":"services.unregister", "title":"Stop and remove the rt daemon and deck services" }, ... ] }`; real run: NDJSON like `apply`.

Action ids (v1, in order): `services.unregister` · `deck.managed-remove` ·
`proxy.remove` · `path.unlink` · `shell.remove` · `extension.uninstall` ·
`plugins.uninstall` · `data` (only with `--delete-data`) · `app.trash`.
`--delete-data` requires `--yes` (non-TTY without it → exit 2
`confirm-required`; the app's confirmation sheet is the consent, so the app
always passes `--yes`). `--keep-data` needs no `--yes`.

## Stub

`RT_STUB_SCENARIO=<name>` (DEBUG builds only) makes the app spawn
`rt-tray/Tests/stub-rt/stub.ts` instead of the bundled rt. Companion env:
`RT_STUB_PATH` (required; absolute path to `stub.ts`), `RT_STUB_BUN`
(optional; default `~/.bun/bin/bun`), `RT_STUB_STATE_DIR` (optional; where
scenario state such as "granted after first check" persists). Scenarios ship
canned responses for every verb above: `create-happy`, `join-happy`,
`join-no-access`, `perm-denied-then-granted`, `apply-fail-retry`, `restore`,
`uninstall`.
