#!/usr/bin/env bash
# SessionStart (matcher resume|compact|fork): confirm the already-signed-in
# session is still active after Claude Code recreates the process.
# Never fires on startup/clear -- a session file existing is what makes this
# safe, and sign-in is the only thing allowed to create one.
set -u

home="${HOME:-}"
[ -n "$home" ] || exit 0

command -v jq >/dev/null 2>&1 || exit 0

input="$(cat 2>/dev/null)" || exit 0
session_id="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
[ -n "$session_id" ] || exit 0

session_file="$home/.mattstack/rt/chat/sessions/$session_id.json"
[ -f "$session_file" ] || exit 0

fields="$(jq -r '[(.handle // empty), (.room // empty)] | @tsv' < "$session_file" 2>/dev/null)"
[ -n "$fields" ] || exit 0
IFS=$'\t' read -r handle room <<< "$fields"
[ -n "$handle" ] || exit 0

if [ -n "$room" ]; then
  message="rt chat: you are signed in as ${handle} (room #${room}); chat messages arrive in your context automatically."
else
  message="rt chat: you are signed in as ${handle}; chat messages arrive in your context automatically."
fi

jq -nc --arg msg "$message" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $msg}}' 2>/dev/null
exit 0
