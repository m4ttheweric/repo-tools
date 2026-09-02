#!/bin/bash
# osascript/System Events helpers for driving mattstack.app in the guest.
# Source only. Requires Accessibility + Automation granted to sshd-keygen-wrapper (golden step).
GUEST_RUN="${GUEST_RUN:-/Volumes/My Shared Files/run}"
# Every ax_click/ax_set_field below drives whatever process is named $AX_APP, including a real
# mattstack.app if one happens to be running — refuse by default so a stray invocation on an
# operator's own Mac can't type a PAT or toggle permissions there. Host tests override GUEST_RUN
# to a real directory they made themselves.
[ -d "$GUEST_RUN" ] || { printf 'ax.sh: %s is not mounted -- this must run against a guest (pass an existing GUEST_RUN to override for host testing)\n' "$GUEST_RUN" >&2; return 1 2>/dev/null || exit 1; }
# Backslash-escape a value before it is spliced into an AppleScript string literal — a
# malformed PAT, admin password, or app/process name must not corrupt the -e argument
# osascript parses (which fails as a grammar error, not our own "not found" error).
ax_esc() { local v="$1"; v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; printf '%s' "$v"; }

AX_APP="${AX_APP:-mattstack}"; AX_APP="$(ax_esc "$AX_APP")"
: "${VM_ADMIN_USER:=admin}"; : "${VM_ADMIN_PASS:=admin}"
AX_LOG="$GUEST_RUN/logs/drive.log"; mkdir -p "$(dirname "$AX_LOG")" 2>/dev/null || true

ax_log()  { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$AX_LOG" >&2; }
ax_osa()  { osascript -e "$1" 2>>"$AX_LOG"; }

# Shared recursive descent used by every AXIdentifier lookup below; osascript runs each -e
# argument as its own process, so the handler is re-sent on every call rather than defined once.
# `using terms from` is load-bearing, not decorative: "attribute"/"UI elements" are System
# Events vocabulary, and a handler defined outside any `tell` block won't even compile without
# it -- it fails at parse time with an unrelated-looking "Expected ..." syntax error, before the
# calling `tell process` context (which only affects term resolution at *runtime*) ever applies.
AX_WALK_AS='
using terms from application "System Events"
  on walk(el, wanted)
    try
      if (value of attribute "AXIdentifier" of el) is wanted then return el
    end try
    try
      repeat with c in UI elements of el
        set r to my walk(c, wanted)
        if r is not missing value then return r
      end repeat
    end try
    return missing value
  end walk
end using terms from
'

# Host-side capture handshake: the host watches in/ for *.req files, and only runs the watcher
# loop when --graphics is on (walkthrough.sh) -- read that flag instead of always waiting it out.
ax_graphics() {
  local f="$GUEST_RUN/in/params.json"
  [ -f "$f" ] || { printf 1; return; }
  case "$(sed -n 's/.*"graphics":\([01]\).*/\1/p' "$f")" in
    0) printf 0 ;;
    *) printf 1 ;;
  esac
}

ax_shot() {
  local name="$1"
  if [ "$(ax_graphics)" = 0 ]; then
    ax_log "shot $name: skipped (--no-graphics)"
    return 0
  fi
  local req="$GUEST_RUN/in/shot-$name.req" done="$GUEST_RUN/in/shot-$name.done"
  rm -f "$done"; : > "$req"
  for _ in $(seq 1 40); do [ -f "$done" ] && { ax_log "shot $name"; return 0; }; sleep 0.5; done
  ax_log "shot $name: host did not respond within 20s"; return 0
}
ax_fail() { ax_log "FAIL: $*"; ax_shot "fail-$(date +%s)"; exit 1; }

ax_dump_ids() {  # every AXIdentifier currently present in window 1, one per line
  ax_osa "tell application \"System Events\" to tell process \"$AX_APP\" to get value of attribute \"AXIdentifier\" of every UI element of entire contents of window 1" 2>/dev/null | tr ',' '\n'
}

ax_wait_window() {  # <title-substring> <timeout-s>
  local t="$1" n="${2:-30}"
  while [ "$n" -gt 0 ]; do
    ax_osa "tell application \"System Events\" to tell process \"$AX_APP\" to get name of every window" 2>/dev/null | grep -q "$t" && return 0
    sleep 1; n=$((n-1))
  done
  return 1
}

ax_wait_screen() {  # <welcome|team|checklist|install|done> <timeout-s> — waits for setup.<screen>.screen
  local n="${2:-30}"
  while [ "$n" -gt 0 ]; do
    ax_find "setup.$1.screen" >/dev/null 2>&1 && return 0
    sleep 1; n=$((n-1))
  done
  return 1
}

# Find a UI element by AXIdentifier anywhere under window 1; prints its AX class. A UI element
# reference cannot be coerced to text (-1700), so callers get existence + class, never a path.
ax_find() {  # <axid>
  local id; id=$(ax_esc "$1")
  ax_osa "$AX_WALK_AS
    tell application \"System Events\" to tell process \"$AX_APP\"
      set r to my walk(window 1, \"$id\")
      if r is missing value then error \"axid not found: $id\"
      return (class of r as text)
    end tell" 2>/dev/null
}

ax_click() {  # <axid>
  local id; id=$(ax_esc "$1")
  ax_osa "$AX_WALK_AS
    tell application \"System Events\" to tell process \"$AX_APP\"
      set frontmost to true
      set r to my walk(window 1, \"$id\")
      if r is missing value then error \"axid not found: $id\"
      click r
    end tell" || ax_fail "click $1"
  ax_log "clicked $1"
}

ax_click_button_named() {  # <name> [<process>]
  # $AX_APP is escaped once already (line 15); only an explicit $2 (raw) needs ax_esc here.
  local p="${2:-$AX_APP}" pe nm
  pe="$p"; [ -n "${2:-}" ] && pe=$(ax_esc "$p")
  nm=$(ax_esc "$1")
  ax_osa "tell application \"System Events\" to tell process \"$pe\" to click (first button of window 1 whose name is \"$nm\")" >/dev/null || return 1
  ax_log "clicked button '$1' in $p"
}

ax_set_field() {  # <axid> <text>   (text never logged)
  local id text; id=$(ax_esc "$1"); text=$(ax_esc "$2")
  ax_osa "$AX_WALK_AS
    tell application \"System Events\" to tell process \"$AX_APP\"
      set frontmost to true
      set r to my walk(window 1, \"$id\")
      if r is missing value then error \"axid not found: $id\"
      set focused of r to true
      keystroke \"a\" using command down
      keystroke \"$text\"
    end tell" || ax_fail "set field $1"
  ax_log "filled $1"
}

ax_status() {  # <rowId> → status string (the app exposes it as the row status element's value)
  local id; id=$(ax_esc "$1")
  ax_osa "$AX_WALK_AS
    tell application \"System Events\" to tell process \"$AX_APP\"
      set r to my walk(window 1, \"setup.checklist.row.$id.status\")
      if r is missing value then error \"axid not found: setup.checklist.row.$id.status\"
      try
        return value of r as text
      on error
        return description of r as text
      end try
    end tell" 2>/dev/null
}

ax_wait_status() {  # <rowId> <status> <timeout-s>
  local n="${3:-60}" s
  while [ "$n" -gt 0 ]; do
    s=$(ax_status "$1" || true)
    [ "$s" = "$2" ] && { ax_log "row $1 = $2"; return 0; }
    sleep 1; n=$((n-1))
  done
  ax_log "row $1 stuck at '${s:-?}' (wanted $2)"; return 1
}

# SecurityAgent admin prompt (privileged step, FDA/Login Items toggles by a standard user).
# One-shot, non-blocking: returns immediately when no dialog is up. A poll loop must use this
# form, not ax_admin_auth's own 30s wait-for-appearance — that form belongs only at call sites
# that just triggered a privileged action and expect the dialog imminently.
ax_admin_auth_once() {
  ax_osa 'tell application "System Events" to exists window 1 of process "SecurityAgent"' 2>/dev/null | grep -q true || return 1
  local u p; u=$(ax_esc "$VM_ADMIN_USER"); p=$(ax_esc "$VM_ADMIN_PASS")
  ax_osa "tell application \"System Events\" to tell process \"SecurityAgent\" to tell window 1
    set value of text field 1 to \"$u\"
    set value of text field 2 to \"$p\"
    click (first button whose name is \"OK\" or name is \"Unlock\" or name is \"Modify Settings\" or name is \"Install Helper\")
  end tell" >/dev/null && { ax_log "admin auth filled"; return 0; }
  return 1
}

ax_admin_auth() {
  local n=30
  while [ "$n" -gt 0 ]; do
    ax_admin_auth_once && return 0
    sleep 1; n=$((n-1))
  done
  return 1
}

ax_allow_notifications() {
  ax_osa 'tell application "System Events" to tell process "UserNotificationCenter" to click (first button of window 1 whose name is "Allow")' >/dev/null 2>&1 \
    && ax_log "notifications: Allow clicked" || ax_log "notifications: no prompt visible"
}


# The row's checkbox value (0/1) for a System Settings privacy list entry, optionally clicking it
# first. The pane's list loads well after window 1 exists, and the row layout (a group holding a
# static text and a checkbox, nesting varies by OS) is not addressable by a fixed path across
# 14/15/26: find the static text naming the app anywhere in the window, then climb AXParent until
# an ancestor holds a checkbox.
ax_settings_row_checkbox() {  # <row label> [click]
  local lbl; lbl=$(ax_esc "$1")
  local act="${2:-}"
  ax_osa "
using terms from application \"System Events\"
  on findText(el, lbl)
    try
      if class of el is static text then
        if (value of el as text) contains lbl or (name of el as text) contains lbl then return el
      end if
    end try
    try
      repeat with c in UI elements of el
        set r to my findText(c, lbl)
        if r is not missing value then return r
      end repeat
    end try
    return missing value
  end findText
  on findCheckbox(el)
    try
      if class of el is checkbox then return el
    end try
    try
      repeat with c in UI elements of el
        set r to my findCheckbox(c)
        if r is not missing value then return r
      end repeat
    end try
    return missing value
  end findCheckbox
end using terms from
tell application \"System Events\" to tell process \"System Settings\"
  set txt to missing value
  repeat 40 times
    if exists window 1 then set txt to my findText(window 1, \"$lbl\")
    if txt is not missing value then exit repeat
    delay 0.5
  end repeat
  if txt is missing value then error \"no row for $lbl in System Settings\"
  set anc to txt
  set cb to missing value
  repeat 5 times
    set anc to value of attribute \"AXParent\" of anc
    set cb to my findCheckbox(anc)
    if cb is not missing value then exit repeat
  end repeat
  if cb is missing value then error \"no checkbox near $lbl\"
  if \"$act\" is \"click\" and value of cb is 0 then click cb
  return value of cb
end tell"
}

ax_toggle_in_system_settings() {  # <row label e.g. mattstack>
  local before after
  before=$(ax_settings_row_checkbox "$1" click) || return 1
  ax_log "System Settings: $1 checkbox was $before, clicked"
  ax_admin_auth || true
  sleep 2
  after=$(ax_settings_row_checkbox "$1") || return 1
  ax_log "System Settings: $1 checkbox now $after"
  # On failure System Settings stays open so the caller's screenshot shows the pane.
  [ "$after" = 1 ] || return 1
  ax_osa 'tell application "System Settings" to quit' >/dev/null 2>&1 || true
}
