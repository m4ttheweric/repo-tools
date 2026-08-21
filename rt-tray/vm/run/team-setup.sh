#!/bin/bash
# Throwaway GitHub org for the VM walkthrough. ORCHESTRATOR/MATT: needs MATTSTACK_VMTEST_PAT in env.
# Usage: team-setup.sh reset [--slug vmtest] | invite --handle <h> --out <file> [--slug vmtest] | status
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"
ORG="${MATTSTACK_VMTEST_ORG:-mattstack-vmtest}"
HOME_REPO="${MATTSTACK_VMTEST_HOME_REPO:-mattstack-vmtest-home}"
TEAM_REPO="${MATTSTACK_VMTEST_TEAM_REPO:-mattstack-vmtest-team}"
PAT="${MATTSTACK_VMTEST_PAT:-}"
cmd="${1:-}"; shift || true
SLUG=vmtest; HANDLE=""; OUT=""
while [ $# -gt 0 ]; do case "$1" in --slug) SLUG="$2"; shift 2;; --handle) HANDLE="$2"; shift 2;; --out) OUT="$2"; shift 2;; *) vm_die "unknown arg $1";; esac; done
vm_require_cmd gh "brew install gh"
ghp() { GH_TOKEN="$PAT" gh "$@"; }
need_pat() { [ -n "$PAT" ] || vm_die "MATTSTACK_VMTEST_PAT is empty — export a fine-grained PAT scoped to org $ORG (MATT step; never commit it)"; }

case "$cmd" in
  status)
    vm_log "org=$ORG home=$HOME_REPO team=$TEAM_REPO pat=$([ -n "$PAT" ] && echo present || echo MISSING)"
    [ -n "$PAT" ] && ghp repo list "$ORG" --limit 20 --json name -q '.[].name' | sed 's/^/  repo: /' || true
    ;;
  reset)
    need_pat
    for r in "$HOME_REPO" "$TEAM_REPO" mattstack-home "mattstack-team-$SLUG"; do
      if ghp repo view "$ORG/$r" >/dev/null 2>&1; then ghp repo delete "$ORG/$r" --yes && vm_log "deleted $ORG/$r"; fi
    done
    ghp repo create "$ORG/$HOME_REPO" --private --description "mattstack VM test home repo (throwaway)" >/dev/null && vm_log "created $ORG/$HOME_REPO"
    ghp repo create "$ORG/$TEAM_REPO" --private --description "mattstack VM test team repo (throwaway)" >/dev/null && vm_log "created $ORG/$TEAM_REPO"
    ;;
  invite)
    need_pat; [ -n "$HANDLE" ] && [ -n "$OUT" ] || vm_die "invite needs --handle and --out"
    mkdir -p "$(dirname "$OUT")"; umask 077
    if rt team invite --help >/dev/null 2>&1; then
      # Real path: owner mints against the shared relay (L1 + L6). Team must exist locally: rt team create … first.
      if ! rt team create "$SLUG" --remote "https://github.com/$ORG/$TEAM_REPO.git" --others --json >/dev/null 2>&1; then vm_warn "rt team create returned non-zero (team may already exist)"; fi
      rt team publish --remote "https://github.com/$ORG/$TEAM_REPO.git" --json >/dev/null 2>&1 || true
      if out=$(rt team invite --handle "$HANDLE" --json 2>"$VM_CACHE/invite.err"); then
        printf '%s' "$out" | sed -n 's/.*"code": *"\([^"]*\)".*/\1/p' > "$OUT"
        [ -s "$OUT" ] || vm_die "rt team invite returned no code: $(cat "$VM_CACHE/invite.err")"
        vm_log "invite minted (real) → $OUT  expires: $(printf '%s' "$out" | sed -n 's/.*"expiresAt": *"\([^"]*\)".*/\1/p')"
      else
        vm_die "rt team invite failed (relay down? L6 not deployed?): $(cat "$VM_CACHE/invite.err")"
      fi
    else
      # Stub path until L1/L6 land: a syntactically valid code the app's DEBUG stub (RT_STUB_SCENARIO=join-happy) accepts.
      printf 'STUB-%s-%s\n' "$SLUG" "$(date +%s)" > "$OUT"
      vm_log "invite code is a STUB (rt team invite not available) → $OUT; join scenario needs a DEBUG app launched with RT_STUB_SCENARIO=join-happy RT_STUB_PATH=<repo>/rt-tray/Tests/stub-rt/stub.ts (L3 plan)"
    fi
    ;;
  *) vm_die "usage: team-setup.sh reset|invite|status";;
esac
