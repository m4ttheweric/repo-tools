#!/bin/bash
# Drive the five setup screens of mattstack.app in the guest, as tester.
# Usage: drive-setup.sh <create|join|restore> [--team-slug vmtest] [--pat-env MATTSTACK_VMTEST_PAT] [--invite-code-file <p>]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/ax.sh"
SCENARIO="${1:-create}"; shift || true
SLUG=vmtest; PAT_ENV=MATTSTACK_VMTEST_PAT; CODE_FILE=""
while [ $# -gt 0 ]; do case "$1" in
  --team-slug) SLUG="$2"; shift 2;; --pat-env) PAT_ENV="$2"; shift 2;; --invite-code-file) CODE_FILE="$2"; shift 2;;
  *) ax_fail "unknown arg $1";; esac; done
case "$SCENARIO" in create|join|restore) ;; *) ax_fail "unknown scenario: $SCENARIO (want create|join|restore)";; esac
PAT="${!PAT_ENV:-}"
DRIVER_LAUNCH_ARGS="${DRIVER_LAUNCH_ARGS:-}"

# If the app has to be relaunched by the driver, replay the exact launch env/args (appcast override).
relaunch_app() {
  # shellcheck disable=SC2086
  bash "$HERE/install-app.sh" launch $DRIVER_LAUNCH_ARGS >>"$AX_LOG" 2>&1 || return 1
}

screen_welcome() {
  ax_wait_window "mattstack" 60 || ax_fail "setup window never appeared"
  ax_wait_screen welcome 10 || ax_fail "setup.welcome.screen axid missing"
  ax_shot 01-welcome
  ax_click setup.welcome.continue
}

screen_team() {
  ax_wait_screen team 10 || ax_fail "setup.team.screen did not appear"
  case "$SCENARIO" in
    create)
      ax_click setup.team.card.create
      ax_set_field setup.team.create.name "$SLUG"
      ax_shot 02-team-create
      ;;
    join)
      [ -n "$CODE_FILE" ] && [ -f "$CODE_FILE" ] || ax_fail "join needs --invite-code-file"
      ax_click setup.team.card.join
      ax_set_field setup.team.join.code "$(tr -d '\n' < "$CODE_FILE")"
      ax_shot 02-team-join
      ;;
    restore) ax_log "restore scenario not implemented"; exit 3;;
  esac
  ax_click setup.team.continue
  # Continue validates the remote(s) with git ls-remote; allow time, then the checklist must appear.
  ax_wait_screen checklist 60 || ax_fail "setup.checklist.screen did not appear after team Continue"
}

screen_readiness() {
  ax_shot 03-readiness-initial
  # Accounts → GitHub token (the guest has no gh; the PAT is typed, never logged, masked on screen).
  if ax_find setup.checklist.row.account.github >/dev/null 2>&1; then
    [ -n "$PAT" ] || ax_fail "account.github row present but \$$PAT_ENV is empty on the host"
    ax_click setup.checklist.row.account.github.action
    ax_set_field setup.checklist.connect.field.token "$PAT"
    ax_click setup.checklist.connect.submit
    ax_wait_status account.github ready 60 || ax_fail "github row not ready"
  fi
  # Full Disk Access: button → System Settings → toggle (admin auth for a standard user) → Relaunch.
  if [ "$(ax_status perm.fda || true)" != ready ]; then
    ax_click setup.checklist.row.perm.fda.action
    ax_toggle_in_system_settings mattstack || ax_fail "could not toggle FDA in System Settings"
    ax_shot 03-fda-toggled
    # Relaunch re-execs the app in place with its current arguments + environment, so the appcast
    # override survives.
    ax_wait_status perm.fda needs-you 20 || true
    ax_click setup.checklist.relaunch
    sleep 3
    if ! ax_wait_window "mattstack" 60; then
      ax_log "app did not come back by itself after FDA relaunch — relaunching with the driver's env/args"
      relaunch_app || ax_fail "app did not come back after FDA relaunch"
      ax_wait_window "mattstack" 60 || ax_fail "app did not come back after FDA relaunch"
    fi
    ax_wait_screen checklist 30 || ax_fail "checklist did not return after FDA relaunch"
    ax_wait_status perm.fda ready 30 || ax_fail "FDA not applied after relaunch"
  fi
  # Background services (Login Items): register → if requiresApproval, open pane and toggle.
  if [ "$(ax_status perm.login-items || true)" != ready ]; then
    ax_click setup.checklist.row.perm.login-items.action
    sleep 2
    if [ "$(ax_status perm.login-items || true)" != ready ]; then
      ax_toggle_in_system_settings mattstack || ax_log "login items toggle not found (may already be enabled)"
    fi
    ax_wait_status perm.login-items ready 60 || ax_fail "login items row not ready"
  fi
  ax_log "note: the 'Background Items Added' banner is not asserted; row status comes from SMAppService"
  # Notifications (optional): Allow the system prompt if the row asks.
  if ax_find setup.checklist.row.perm.notifications >/dev/null 2>&1 && [ "$(ax_status perm.notifications || true)" != ready ]; then
    ax_click setup.checklist.row.perm.notifications.action; sleep 2; ax_allow_notifications
  fi
  # Apple CLT row: the clean room has none; the app's Install… triggers Apple's dialog — a real network install (~minutes).
  if [ "$(ax_status tool.clt || true)" != ready ]; then
    ax_click setup.checklist.row.tool.clt.action
    ax_osa 'tell application "System Events" to tell process "Install Command Line Developer Tools" to click (first button of window 1 whose name is "Install")' >/dev/null 2>&1 || true
    ax_osa 'tell application "System Events" to tell process "Install Command Line Developer Tools" to click (first button of window 1 whose name is "Agree")' >/dev/null 2>&1 || true
    ax_wait_status tool.clt ready 1200 || ax_fail "CLT install did not finish in 20 min"
    ax_shot 03-clt-installed
  fi
  ax_shot 03-readiness-final
  ax_find setup.checklist.continue >/dev/null || ax_fail "setup.checklist.continue axid missing"
  ax_click setup.checklist.continue
}

screen_install() {
  ax_wait_screen install 10 || ax_fail "setup.install.screen did not appear"
  ax_shot 04-install-start
  # Steps stream; a privileged step raises the admin prompt (standard user → admin creds).
  local n=900 failed
  while [ "$n" -gt 0 ]; do
    ax_admin_auth 2>/dev/null && ax_shot 04-admin-auth || true
    if ax_wait_window "mattstack" 1 && ax_find setup.done.continue >/dev/null 2>&1; then ax_shot 04-install-done; return 0; fi
    # Failure = the Retry button is present; the failing step's own AXIdentifier is the nearest
    # setup.install.step.* seen before it in the flattened tree (the button lives inside that step's row).
    if ax_find setup.install.retry >/dev/null 2>&1; then
      failed=$(ax_osa "tell application \"System Events\" to tell process \"$AX_APP\" to get value of attribute \"AXIdentifier\" of every UI element of entire contents of window 1" 2>/dev/null \
        | tr ',' '\n' | awk '
            /setup\.install\.step\./ { match($0, /setup\.install\.step\.[A-Za-z0-9._-]*/); last = substr($0, RSTART, RLENGTH) }
            /setup\.install\.retry/  { print last; exit }
          ')
      failed="${failed%.status}"; failed="${failed%.log}"
      ax_fail "install step failed (${failed:-see setup.install.retry}); log: setup.install.log.copy"
    fi
    sleep 2; n=$((n-2))
  done
  ax_fail "install did not reach Done in 15 min"
}

screen_done() {
  ax_wait_screen done 10 || ax_fail "setup.done.screen did not appear"
  ax_shot 05-done
  ax_click setup.done.continue
}

ax_log "scenario=$SCENARIO slug=$SLUG"
screen_welcome; screen_team; screen_readiness; screen_install; screen_done
ax_log "five screens complete"
