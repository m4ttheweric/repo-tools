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
  "team": { "slug": "assured", "name": "Assured", "mode": "join" | "create" | "restore" | "none" },
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
  "detail": "Not granted" | "git 2.50.1" | "token can't see group assured",
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
event arrives (ServicesRegistrar / PrivilegedInstaller), which then POSTs
`/setup/need/<id>` `{ ok, detail }` on tray.sock; rt blocks on that reply with
a 10-minute timeout. Steps are idempotent; `--from` resumes.

## Step ids (v1, in rt's order)

`home.init` | `home.restore` · `team.create` | `team.join` · `secrets.write` ·
`path.link` · `intercepts.install` · `settings.seed` · `repos.clone` ·
`services.register` (app) · `proxy.install` (privileged) · `deck.managed` ·
`skills.materialize` · `board.keys` · `cron.triage` · `plugins.install` ·
`fastbrowser.setup` · `herdr.integration` · `extension.install` ·
`services.start` · `snapshot.push` · `verify`

## tray.sock (app → rt callbacks and app-side truth)

`GET /permissions` → `{ "fda": {"status":"granted"|"denied"|"unknown","detail":"..."}, "notifications": {"status":"authorized"|"denied"|"notDetermined"|"provisional"}, "loginItems": {"status":"enabled"|"requiresApproval"|"notRegistered"|"notFound"} }`
`POST /permissions/request` `{ "which": "notifications" }` → `{ ok }`
`GET /services` → `{ "agents": [ { "label": "com.mattstack.daemon", "status": "enabled"|"requiresApproval"|"notRegistered"|"notFound" } ] }`
`POST /services/register` `{ "plists": [...] }` → `{ ok, results }` · `POST /services/restart` `{ "label" }`
`POST /privileged/proxy-install` → `{ ok, detail }` (raises the admin prompt)
`POST /setup/need/<id>` `{ ok, detail }` (reply to a `need` event)
`POST /update/check` → `{ ok }` · `GET /version` → `{ "version": "2.8.0", "build": 2080, "flavor": "prod"|"dev", "path": "/Applications/mattstack.app" }`

## `rt team join --json` (stdin: `{"code": "..."}`) / `--dry-run`

→ `{ "contract":1, "team": {"slug","name","owner"}, "access": "ok"|"denied"|"unreachable", "peering": "applied"|"idle"|"unavailable", "message": "..." }`

## `rt team invite --handle <h> --json`

→ `{ "contract":1, "code": "...", "expiresAt": "...", "pasteBlock": "Install mattstack from … then open mattstack://join/… or paste …", "forgeAccess": "granted"|"manual"|"skipped", "manualSteps": [...] }`

## `rt uninstall --json [--keep-data|--delete-data] [--dry-run]`

→ dry-run: `{ "contract":1, "actions": [ { "id":"services.unregister", "title":"Stop and remove the rt daemon and deck services" }, ... ] }`; real run: NDJSON like `apply`.

## Stub

`RT_STUB_SCENARIO=<name>` (DEBUG builds only) makes the app spawn
`rt-tray/Tests/stub-rt/stub.ts` instead of the bundled rt. Scenarios ship
canned responses for every verb above: `create-happy`, `join-happy`,
`join-no-access`, `perm-denied-then-granted`, `apply-fail-retry`, `restore`,
`uninstall`.
