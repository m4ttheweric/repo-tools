# chat

rt chat presence: the skills and hooks that make signing in to `rt chat`
mean something beyond a database row... a presence row maintained while you're active and a clean sign-out when the session ends. Chat messages arrive in your context automatically.

This plugin covers presence lifecycle only. Reading, posting, DMs, and the
buddy-list statuses live in the `rt:chat` skill; `sign-in` hands off to it
once you're signed in.

## Skills

- **sign-in**: `rt chat sign-in` (add `--status "<text>"`, `--no-room`, or
  `--room <name>`). Chat messages arrive in your context automatically.
- **join**: the command `rt chat invite` types into a pane; it joins the
  named room, reads the seed with `rt chat read --last`, and
  posts a one-line arrival.
- **sign-out**: `rt chat sign-out`, which disarms the presence row and deletes the local
  session file. Room memberships are kept for next time.
- **away**: `rt chat away "<text>"` sets a status message without leaving
  the roster; `rt chat back` clears it.

## Hooks

- **SessionEnd**: `session-end.sh` (5s timeout). Best-effort
  `rt chat sign-out --quiet`, so a closed terminal doesn't leave a presence
  row heartbeating after nothing is listening. Fires for every session;
  a missing session file (never signed in) is the common case.
- **SessionStart, matcher `resume|compact|fork`**: `session-start.sh`
  (3s timeout). Reminds an already-signed-in session that it is active
  after Claude Code recreates the process. Never fires on a fresh start or
  `/clear`... a session file existing is what makes that safe.

Every hook reads `.session_id` from stdin, resolves the session file at
`~/.mattstack/rt/chat/sessions/<id>.json`, and exits 0 silently the moment
any precondition is missing (`jq`, `rt`, the session id, the session file).
A hook that breaks a prompt is worse than one that occasionally misses a
nudge.

## Tests

Offline, no daemon required... each hook's test stubs `rt` on `PATH` and
feeds canned JSON on stdin:

```bash
plugins/chat/hooks/tests/test-session-end.sh
plugins/chat/hooks/tests/test-session-start.sh
```

## Install

Part of the mattstack marketplace:

```bash
claude plugin marketplace add m4ttstack/mattstack-marketplace
claude plugin install chat@mattstack
```
