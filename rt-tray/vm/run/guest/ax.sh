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
ax_fail() {
  ax_log "FAIL: $*"
  # Screenshots are host-side and can fail on their own; the identifiers on
  # screen are the evidence that survives that.
  ax_log "windows: $(ax_osa "tell application \"System Events\" to tell process \"$AX_APP\" to get name of every window" 2>/dev/null)"
  ax_log "axids on screen: $(ax_dump_ids | tr '\n' ' ')"
  ax_shot "fail-$(date +%s)"
  exit 1
}

# Every AXIdentifier currently present in window 1, one per line. Walked
# recursively: `every UI element of entire contents` is not coercible to a
# specifier on every OS, so it is never used here.
ax_dump_ids() {
  ax_osa "
using terms from application \"System Events\"
  on walkIds(el, acc)
    try
      set i to value of attribute \"AXIdentifier\" of el
      if i is not missing value and (i as text) is not \"\" then set end of acc to (i as text)
    end try
    try
      repeat with c in UI elements of el
        my walkIds(c, acc)
      end repeat
    end try
  end walkIds
end using terms from
tell application \"System Events\" to tell process \"$AX_APP\"
  set acc to {}
  if exists window 1 then my walkIds(window 1, acc)
  set AppleScript's text item delimiters to linefeed
  return acc as text
end tell" 2>/dev/null
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

# Each ax_status is an osascript round trip of a few seconds, so the bound
# is wall-clock, not iterations.
ax_wait_status() {  # <rowId> <status> <timeout-s>
  local deadline=$((SECONDS + ${3:-60})) s
  while [ "$SECONDS" -lt "$deadline" ]; do
    s=$(ax_status "$1" || true)
    [ "$s" = "$2" ] && { ax_log "row $1 = $2"; return 0; }
    sleep 1
  done
  ax_log "row $1 stuck at '${s:-?}' (wanted $2)"; return 1
}

ax_wait_status_not() {  # <rowId> <status-to-leave> <timeout-s>
  local deadline=$((SECONDS + ${3:-60})) s
  while [ "$SECONDS" -lt "$deadline" ]; do
    s=$(ax_status "$1" || true)
    [ -n "$s" ] && [ "$s" != "$2" ] && { ax_log "row $1 = $s"; return 0; }
    sleep 1
  done
  ax_log "row $1 still '${s:-?}'"; return 1
}

# SecurityAgent admin prompt (privileged step, FDA/Login Items toggles by a standard user).
# One-shot, non-blocking: returns immediately when no dialog is up. A poll loop must use this
# form, not ax_admin_auth's own 30s wait-for-appearance — that form belongs only at call sites
# that just triggered a privileged action and expect the dialog imminently.
ax_admin_auth_once() {
  local u p; u=$(ax_esc "$VM_ADMIN_USER"); p=$(ax_esc "$VM_ADMIN_PASS")
  if ax_osa 'tell application "System Events" to exists window 1 of process "SecurityAgent"' 2>/dev/null | grep -q true; then
    ax_osa "tell application \"System Events\" to tell process \"SecurityAgent\" to tell window 1
      set value of text field 1 to \"$u\"
      set value of text field 2 to \"$p\"
      click (first button whose name is \"OK\" or name is \"Unlock\" or name is \"Modify Settings\" or name is \"Install Helper\")
    end tell" >/dev/null && { ax_log "admin auth filled (SecurityAgent)"; return 0; }
  fi
  # macOS 26 asks inside System Settings itself: a sheet titled "Privacy &
  # Security is trying to modify your system settings" with name/password
  # fields and a Modify Settings button — no SecurityAgent process at all.
  if ax_osa 'tell application "System Events" to tell process "System Settings" to exists (first button of sheet 1 of window 1 whose name is "Modify Settings")' 2>/dev/null | grep -q true; then
    ax_osa "tell application \"System Events\" to tell process \"System Settings\" to tell sheet 1 of window 1
      set value of text field 1 to \"$u\"
      set value of text field 2 to \"$p\"
      click (first button whose name is \"Modify Settings\")
    end tell" >/dev/null && { ax_log "admin auth filled (System Settings sheet)"; return 0; }
  fi
  return 1
}

# After a granted privacy toggle macOS offers to relaunch the app itself
# ("… will not have full disk access until it is quit": Quit & Reopen /
# Later). Later keeps the relaunch with the driver, which replays the app's
# launch env and args; Quit & Reopen would drop them.
ax_settings_dismiss_relaunch_sheet() {
  ax_osa 'tell application "System Events" to tell process "System Settings" to click (first button of sheet 1 of window 1 whose name is "Later")' >/dev/null 2>&1 \
    && ax_log "System Settings: dismissed the Quit & Reopen sheet with Later" || true
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


# The value (0/1) of a privacy-list row's switch in System Settings, optionally clicking it first.
# The list loads well after window 1 exists, and on 14/15/26 alike the switch is a checkbox
# (AXSwitch) NAMED after the app, a sibling of its label — so it is found by name, never by path.
ax_settings_row_checkbox() {  # <row label> [click]
  local lbl; lbl=$(ax_esc "$1")
  local act="${2:-}"
  ax_osa "
using terms from application \"System Events\"
  on findSwitch(el, lbl, exact)
    try
      if class of el is checkbox then
        set n to name of el as text
        if (exact and n is lbl) or ((not exact) and n contains lbl) then return el
      end if
    end try
    try
      repeat with c in UI elements of el
        set r to my findSwitch(c, lbl, exact)
        if r is not missing value then return r
      end repeat
    end try
    return missing value
  end findSwitch
end using terms from
tell application \"System Events\" to tell process \"System Settings\"
  set sw to missing value
  set deadline to (current date) + ${AX_SETTINGS_SWITCH_WAIT:-60}
  repeat while (current date) < deadline
    if exists window 1 then
      set sw to my findSwitch(window 1, \"$lbl\", true)
      if sw is missing value then set sw to my findSwitch(window 1, \"$lbl\", false)
    end if
    if sw is not missing value then exit repeat
    delay 0.5
  end repeat
  if sw is missing value then error \"no switch named $lbl in System Settings\"
  set v0 to value of sw
  if \"$act\" is \"click\" and v0 is 0 then click sw
  return v0
end tell"
}

# Every "<static text> = <nearest checkbox value>" pair in System Settings' window 1, one per
# line: the evidence for which row a toggle matched. Bounded by the pane's own row count.
ax_settings_dump_rows() {
  ax_osa "
using terms from application \"System Events\"
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
  on walkTexts(el, acc)
    try
      if class of el is static text then
        set anc to el
        set cb to missing value
        repeat 4 times
          set anc to value of attribute \"AXParent\" of anc
          set cb to my findCheckbox(anc)
          if cb is not missing value then exit repeat
        end repeat
        set v to \"-\"
        if cb is not missing value then set v to (value of cb as text)
        set end of acc to ((value of el as text) & \" = \" & v)
      end if
    end try
    try
      repeat with c in UI elements of el
        my walkTexts(c, acc)
      end repeat
    end try
  end walkTexts
end using terms from
tell application \"System Events\" to tell process \"System Settings\"
  set acc to {}
  if exists window 1 then my walkTexts(window 1, acc)
  set AppleScript's text item delimiters to linefeed
  return acc as text
end tell" 2>/dev/null | sed 's/^/    settings row: /' >>"$AX_LOG"
}

ax_toggle_in_system_settings() {  # <row label e.g. mattstack> [deep link to reopen on a pane that never populated]
  local v0 after
  # One full-window walk costs seconds on a busy guest, so the lookup loop
  # is wall-clock; a pane that still shows only the sidebar gets reopened
  # through its own deep link once before giving up.
  if ! v0=$(ax_settings_row_checkbox "$1" click); then
    ax_settings_dump_rows
    [ -n "${2:-}" ] || return 1
    ax_log "System Settings: $1 switch not found; reopening $2"
    open "$2"; sleep 3
    v0=$(ax_settings_row_checkbox "$1" click) || { ax_settings_dump_rows; return 1; }
  fi
  ax_log "System Settings: $1 switch was $v0, clicked"
  ax_admin_auth || ax_log "System Settings: no admin prompt appeared within 30s"
  sleep 2
  ax_settings_dismiss_relaunch_sheet
  after=$(ax_settings_row_checkbox "$1") || return 1
  ax_log "System Settings: $1 switch now $after"
  # On failure System Settings stays open so the caller's screenshot shows the pane.
  [ "$after" = 1 ] || { ax_settings_dump_rows; return 1; }
  ax_osa 'tell application "System Settings" to quit' >/dev/null 2>&1 || true
}
