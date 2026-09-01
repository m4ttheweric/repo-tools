#!/usr/bin/env bash
# SessionEnd: best-effort sign-out so a closed terminal does not leave a
# presence row heartbeating after nothing is listening.
#
# SessionEnd fires for every session, and most never signed in, so the
# no-session-file check must run before anything else touches rt or the
# daemon. Always exits 0 -- a session shutdown must never fail on this.
set -u

home="${HOME:-}"
[ -n "$home" ] || exit 0

command -v jq >/dev/null 2>&1 || exit 0

input="$(cat 2>/dev/null)" || exit 0
session_id="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
[ -n "$session_id" ] || exit 0

session_file="$home/.mattstack/rt/chat/sessions/$session_id.json"
[ -f "$session_file" ] || exit 0

command -v rt >/dev/null 2>&1 || exit 0
rt chat sign-out --quiet --session "$session_id" >/dev/null 2>&1
exit 0
