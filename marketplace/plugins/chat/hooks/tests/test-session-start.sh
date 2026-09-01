#!/usr/bin/env bash
# Offline tests for session-start.sh (SessionStart, matcher resume|compact|fork).
#
# Every case asserts stdout, stderr, and exit code together: a hook that
# leaks a diagnostic to stderr is as much a bug here as one that injects the
# wrong context.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/../session-start.sh"

SANDBOX="$(mktemp -d)"; trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/home/.mattstack/rt/chat/sessions"
SESSIONS_DIR="$SANDBOX/home/.mattstack/rt/chat/sessions"
ERRFILE="$SANDBOX/stderr"

fails=0
check() { # name expected actual
  if [ "$3" = "$2" ]; then echo "ok   $1"
  else echo "FAIL $1"; echo "       want: $2"; echo "       got : $3"; fails=$((fails+1)); fi
}

# run PAYLOAD -- sets $out/$err/$rc from the hook's stdout/stderr/exit code
run() {
  out="$(printf '%s' "$1" | env HOME="$SANDBOX/home" "$HOOK" 2>"$ERRFILE")"
  rc=$?
  err="$(cat "$ERRFILE" 2>/dev/null)"
}

# ── no session file: silent ──────────────────────────────────────────────────
run '{"session_id":"never-signed-in","source":"resume"}'
check "no session file: no stdout" "" "$out"
check "no session file: no stderr" "" "$err"
check "no session file: exits 0" "0" "$rc"

# ── signed in, with a room: injects handle + room ───────────────────────────
echo '{"sessionId":"sess-a","handle":"rt-chat-wt-2","baseHandle":"rt-chat-wt","room":"repo-tools"}' \
  > "$SESSIONS_DIR/sess-a.json"
run '{"session_id":"sess-a","source":"resume"}'
want='{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"rt chat: you are signed in as rt-chat-wt-2 (room #repo-tools); chat messages arrive in your context automatically."}}'
check "signed in with room" "$want" "$out"
check "signed in with room: no stderr" "" "$err"
check "signed in with room: exits 0" "0" "$rc"

# ── signed in, no room ───────────────────────────────────────────────────────
echo '{"sessionId":"sess-b","handle":"deck-main","baseHandle":"deck-main"}' \
  > "$SESSIONS_DIR/sess-b.json"
run '{"session_id":"sess-b","source":"fork"}'
want='{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"rt chat: you are signed in as deck-main; chat messages arrive in your context automatically."}}'
check "signed in without room" "$want" "$out"
check "signed in without room: no stderr" "" "$err"
check "signed in without room: exits 0" "0" "$rc"

# ── no session_id: silent ────────────────────────────────────────────────────
run '{"source":"resume"}'
check "no session_id: no stdout" "" "$out"
check "no session_id: no stderr" "" "$err"
check "no session_id: exits 0" "0" "$rc"

# ── malformed payload: silent, never crashes ─────────────────────────────────
run 'not json at all'
check "malformed payload: no stdout" "" "$out"
check "malformed payload: no stderr" "" "$err"
check "malformed payload: exits 0" "0" "$rc"

run ''
check "empty payload: no stdout" "" "$out"
check "empty payload: no stderr" "" "$err"
check "empty payload: exits 0" "0" "$rc"

# ── a session file whose own handle field is missing/invalid: silent ────────
echo '{"sessionId":"sess-c"}' > "$SESSIONS_DIR/sess-c.json"
run '{"session_id":"sess-c","source":"resume"}'
check "session file with no handle: no stdout" "" "$out"
check "session file with no handle: no stderr" "" "$err"
check "session file with no handle: exits 0" "0" "$rc"

[ "$fails" -eq 0 ] && echo "all session-start tests passed" || echo "$fails failure(s)"
exit $((fails > 0))
