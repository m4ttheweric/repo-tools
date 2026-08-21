#!/bin/bash
# Screenshot the Tart window of <vm> into <out.png>, from the host.
# Usage: capture.sh <vm-name> <out.png>
set -euo pipefail
source "$(cd "$(dirname "$0")/../.." && pwd)/lib/common.sh"
VM="${1:-}"; OUT="${2:-}"
[ -n "$VM" ] && [ -n "$OUT" ] || vm_die "usage: capture.sh <vm-name> <out.png>"
WINID_BIN="$VM_CACHE/winid"
if [ ! -x "$WINID_BIN" ] || [ "$VM_ROOT/run/host/winid.swift" -nt "$WINID_BIN" ]; then
  mkdir -p "$VM_CACHE"
  swiftc -O -o "$WINID_BIN" "$VM_ROOT/run/host/winid.swift" 2>/dev/null || vm_die "swiftc failed — Apple CLT required on the host"
fi
WID=$("$WINID_BIN" "$VM") || vm_die "no Tart window for $VM (running with --no-graphics? then screenshots are unavailable)"
screencapture -x -o -l "$WID" "$OUT" || vm_die "screencapture failed"
[ -s "$OUT" ] || vm_die "empty screenshot — grant Screen Recording to your terminal app (System Settings → Privacy & Security → Screen & System Audio Recording) and retry"
# A capture without Screen Recording permission is a solid desktop-coloured image; detect the degenerate 1-colour case.
if command -v sips >/dev/null 2>&1; then
  W=$(sips -g pixelWidth "$OUT" 2>/dev/null | awk '/pixelWidth/{print $2}')
  [ "${W:-0}" -gt 100 ] || vm_die "screenshot too small ($W px) — window minimised?"
fi
vm_log "screenshot → $OUT"
