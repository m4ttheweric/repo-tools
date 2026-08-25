#!/bin/bash
# Shared helpers for rt-tray/vm scripts. Source, don't execute.
# bash 3.2 compatible (macOS stock /bin/bash): no associative arrays, no ${var,,}.

VM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${VM_ARTIFACTS:=$VM_ROOT/artifacts}"
: "${VM_CACHE:=$VM_ROOT/.cache}"
: "${VM_SSH_KEY:=$VM_CACHE/id_ed25519}"
: "${VM_ADMIN_USER:=admin}"
: "${VM_ADMIN_PASS:=admin}"
: "${VM_TESTER_USER:=tester}"
: "${VM_TESTER_PASS:=tester}"
: "${VM_APPCAST_PORT:=8765}"

VM_SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5)

vm_log()  { printf '  %s\n' "$*" >&2; }
vm_warn() { printf '  ! %s\n' "$*" >&2; }
vm_die()  { printf '  ✗ %s\n' "$*" >&2; exit 1; }
vm_now()  { date -u +%Y-%m-%dT%H:%M:%SZ; }

vm_require_cmd() {
  command -v "$1" >/dev/null 2>&1 || vm_die "missing command: $1${2:+ — $2}"
}

# vm_golden_name/vm_image_for take an optional flavour (default cleanroom); xcuitest
# is the Xcode-capable golden that verify-golden.sh's CLT/brew checks must not run against.
vm_golden_name() {
  local ver="$1" flavour="${2:-cleanroom}"
  case "$flavour" in
    cleanroom) printf 'mattstack-golden-%s' "$ver" ;;
    xcuitest)  printf 'mattstack-golden-%s-xcode' "$ver" ;;
    *)         vm_die "unknown golden flavour: $flavour (known: cleanroom xcuitest)" ;;
  esac
}

vm_image_for() {
  local ver="$1" flavour="${2:-cleanroom}" base
  case "$ver" in
    14) base='ghcr.io/cirruslabs/macos-sonoma' ;;
    15) base='ghcr.io/cirruslabs/macos-sequoia' ;;
    26) base='ghcr.io/cirruslabs/macos-tahoe' ;;
    *)  vm_die "no image mapping for macOS $ver (known: 14 15 26)" ;;
  esac
  case "$flavour" in
    cleanroom) printf '%s-vanilla:latest' "$base" ;;
    xcuitest)  printf '%s-xcode:latest' "$base" ;;
    *)         vm_die "unknown golden flavour: $flavour (known: cleanroom xcuitest)" ;;
  esac
}

# ── run directories + phase ledger ──────────────────────────────────────────

vm_run_init() {
  local label="$1"
  VM_RUN_ID="$(date +%Y%m%d-%H%M%S)-$label"
  VM_RUN_DIR="$VM_ARTIFACTS/$VM_RUN_ID"
  mkdir -p "$VM_RUN_DIR/screenshots" "$VM_RUN_DIR/logs" "$VM_RUN_DIR/in"
  # virtiofs maps host/guest uids numerically; admin and tester write into this
  # share from different guest uids, so it must be world-writable on the host.
  chmod -R a+rwX "$VM_RUN_DIR"
  printf '{\n  "id": "%s",\n  "label": "%s",\n  "startedAt": "%s",\n  "host": "%s"\n}\n' \
    "$VM_RUN_ID" "$label" "$(vm_now)" "$(sw_vers -productVersion 2>/dev/null || echo unknown)" > "$VM_RUN_DIR/run.json"
  export VM_RUN_ID VM_RUN_DIR
  vm_log "run $VM_RUN_ID → $VM_RUN_DIR"
}

_vm_phase_started=0
vm_phase_begin() {
  _vm_phase_started=$(date +%s)
  vm_log "── phase: $1"
}

# vm_phase_end <name> <pass|fail|skip> [reason] [screenshot...]
vm_phase_end() {
  local name="$1" status="$2" reason="${3:-}"; shift 3 2>/dev/null || shift $#
  local shots="" s
  for s in "$@"; do shots="$shots${shots:+,}\"$s\""; done
  local secs=$(( $(date +%s) - _vm_phase_started ))
  local esc_reason; esc_reason=$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"phase":"%s","status":"%s","reason":"%s","at":"%s","seconds":%d,"screenshots":[%s]}\n' \
    "$name" "$status" "$esc_reason" "$(vm_now)" "$secs" "$shots" >> "$VM_RUN_DIR/phases.jsonl"
  case "$status" in
    pass) vm_log "   ✓ $name" ;;
    skip) vm_warn "   – $name skipped: $reason" ;;
    fail) vm_warn "   ✗ $name FAILED: $reason" ;;
    *)    vm_die "vm_phase_end: bad status '$status'" ;;
  esac
}

vm_phases_failed() { grep -c '"status":"fail"' "$VM_RUN_DIR/phases.jsonl" 2>/dev/null || true; }

vm_render_report() {
  local f="$VM_RUN_DIR/phases.jsonl" out="$VM_RUN_DIR/report.md"
  local total pass fail skip
  total=$(wc -l < "$f" | tr -d ' '); pass=$(grep -c '"status":"pass"' "$f" || true)
  fail=$(grep -c '"status":"fail"' "$f" || true); skip=$(grep -c '"status":"skip"' "$f" || true)
  {
    echo "# clean-room run $VM_RUN_ID"
    echo
    echo "$total phases: $pass passed, $fail failed, $skip skipped."
    [ "$skip" -gt 0 ] && echo "**Skipped phases are not green** — see reasons below."
    echo
    echo "| phase | status | seconds | reason | screenshots |"
    echo "|---|---|---|---|---|"
    sed -E 's/^\{"phase":"([^"]*)","status":"([^"]*)","reason":"((\\.|[^"\\])*)","at":"[^"]*","seconds":([0-9]+),"screenshots":\[([^]]*)\]\}$/| \1 | \2 | \5 | \3 | \6 |/' "$f" \
      | sed -E 's/\\"/"/g; s/\\\\/\\/g'
    echo
    echo "Logs: \`logs/\` · Screenshots: \`screenshots/\` · Ledger: \`phases.jsonl\`"
  } > "$out"
  vm_log "report → $out"
}

# ── tart / ssh ──────────────────────────────────────────────────────────────

vm_ip() {
  local vm="$1" tries="${2:-60}" ip=""
  while [ "$tries" -gt 0 ]; do
    ip=$(tart ip "$vm" 2>/dev/null </dev/null || true)
    [ -n "$ip" ] && { printf '%s' "$ip"; return 0; }
    sleep 2; tries=$((tries-1))
  done
  return 1
}

vm_ssh_try() {
  local user="$1" vm="$2"; shift 2
  local ip; ip=$(vm_ip "$vm" 1) || return 1
  ssh "${VM_SSH_OPTS[@]}" -i "$VM_SSH_KEY" "$user@$ip" "$@"
}

# vm_ssh/vm_scp/vm_ssh_pw exit the whole script on failure — preconditions only.
# Inside a wait loop or ledgered phase, use the _try variants: the dying variants
# make an until-loop impossible (the first no-lease boot kills the script).
vm_ssh() {
  vm_ssh_try "$@" || vm_die "ssh failed for $1@$2"
}

vm_scp() {
  local user="$1" vm="$2" src="$3" dest="$4"
  local ip; ip=$(vm_ip "$vm" 1) || vm_die "no ip for $vm"
  scp -r "${VM_SSH_OPTS[@]}" -i "$VM_SSH_KEY" "$src" "$user@$ip:$dest"
}

vm_ssh_pw() {
  vm_require_cmd sshpass "brew install cirruslabs/cli/sshpass"
  vm_ssh_pw_try "$@" || vm_die "ssh failed for $1@$3"
}

vm_ssh_pw_try() {
  local user="$1" pass="$2" vm="$3"; shift 3
  local ip; ip=$(vm_ip "$vm" 1) || return 1
  sshpass -p "$pass" ssh "${VM_SSH_OPTS[@]}" "$user@$ip" "$@"
}

vm_wait_ssh() {
  local user="$1" vm="$2" timeout="${3:-300}" start; start=$(date +%s)
  while :; do
    if vm_ssh_try "$user" "$vm" true 2>/dev/null; then return 0; fi
    [ $(( $(date +%s) - start )) -ge "$timeout" ] && return 1
    sleep 3
  done
}
