#!/usr/bin/env bash
# Offline tests for session-end.sh (SessionEnd).
#
# `rt` is stubbed on PATH and records every invocation, so each case asserts
# whether sign-out was actually called -- SessionEnd fires for every session,
# most of which never signed in, and the no-session-file short-circuit is the
# behavior that keeps those a silent no-op. Every case also asserts stdout,
# stderr, and exit code together: a hook that leaks a diagnostic to stderr or
# fails a shutdown is as much a bug here as one that prints the wrong thing.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/../session-end.sh"

SANDBOX="$(mktemp -d)"; trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/bin" "$SANDBOX/home/.mattstack/rt/chat/sessions"
cat > "$SANDBOX/bin/rt" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$RT_STUB_CALLS"
exit "${RT_STUB_EXIT:-0}"
STUB
chmod +x "$SANDBOX/bin/rt"
export PATH="$SANDBOX/bin:$PATH"
export RT_STUB_CALLS="$SANDBOX/rt-calls"

SESSIONS_DIR="$SANDBOX/home/.mattstack/rt/chat/sessions"
ERRFILE="$SANDBOX/stderr"

fails=0
check() { # name expected actual
  if [ "$3" = "$2" ]; then echo "ok   $1"
  else echo "FAIL $1"; echo "       want: $2"; echo "       got : $3"; fails=$((fails+1)); fi
}

# run PAYLOAD -- sets $out/$err/$rc from the hook's stdout/stderr/exit code
run() {
  : > "$RT_STUB_CALLS"
  out="$(printf '%s' "$1" | env HOME="$SANDBOX/home" "$HOOK" 2>"$ERRFILE")"
  rc=$?
  err="$(cat "$ERRFILE" 2>/dev/null)"
}

# ── no session file (the common case: most sessions never signed in) ────────
run '{"session_id":"never-signed-in"}'
check "no session file: no stdout" "" "$out"
check "no session file: no stderr" "" "$err"
check "no session file: exits 0" "0" "$rc"
check "no session file: sign-out never called" "" "$(cat "$RT_STUB_CALLS")"

# ── session file exists: sign-out runs with --quiet and the session id ──────
echo '{"sessionId":"sess-a","handle":"rt-chat-wt"}' > "$SESSIONS_DIR/sess-a.json"
run '{"session_id":"sess-a"}'
check "signed-in session: no stdout" "" "$out"
check "signed-in session: no stderr" "" "$err"
check "signed-in session: exits 0" "0" "$rc"
check "signed-in session: sign-out invoked" "chat sign-out --quiet --session sess-a" "$(cat "$RT_STUB_CALLS")"

# ── no session_id at all: silent, never calls rt ─────────────────────────────
run '{"hook_event_name":"SessionEnd"}'
check "no session_id: no stdout" "" "$out"
check "no session_id: no stderr" "" "$err"
check "no session_id: exits 0" "0" "$rc"
check "no session_id never calls rt" "" "$(cat "$RT_STUB_CALLS")"

# ── malformed payload: silent, never crashes ─────────────────────────────────
run 'not json at all'
check "malformed payload: no stdout" "" "$out"
check "malformed payload: no stderr" "" "$err"
check "malformed payload: exits 0" "0" "$rc"

run ''
check "empty payload: no stdout" "" "$out"
check "empty payload: no stderr" "" "$err"
check "empty payload: exits 0" "0" "$rc"

# ── the daemon call failing still exits 0 and prints nothing anywhere ───────
echo '{"sessionId":"sess-b","handle":"deck-main"}' > "$SESSIONS_DIR/sess-b.json"
out="$(printf '%s' '{"session_id":"sess-b"}' | env HOME="$SANDBOX/home" RT_STUB_EXIT=1 "$HOOK" 2>"$ERRFILE")"
rc=$?
err="$(cat "$ERRFILE" 2>/dev/null)"
check "rt failure: no stdout" "" "$out"
check "rt failure: no stderr" "" "$err"
check "rt failure still exits 0" "0" "$rc"

[ "$fails" -eq 0 ] && echo "all session-end tests passed" || echo "$fails failure(s)"
exit $((fails > 0))
