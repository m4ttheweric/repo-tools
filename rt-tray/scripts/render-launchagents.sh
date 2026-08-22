#!/bin/bash
# Render the LaunchAgent templates for one flavor into a directory.
# Usage: render-launchagents.sh prod|dev <out-dir>
set -euo pipefail
FLAVOR="$1"; OUT="$2"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
case "$FLAVOR" in
    prod) BUNDLE_ID="com.mattstack.app";     DAEMON_LABEL="com.mattstack.daemon";     DECK_LABEL="com.mattstack.deck" ;;
    dev)  BUNDLE_ID="com.mattstack.app.dev"; DAEMON_LABEL="com.mattstack.daemon.dev"; DECK_LABEL="com.mattstack.deck.dev" ;;
    *) echo "flavor must be prod|dev" >&2; exit 2 ;;
esac
mkdir -p "$OUT"
render() { # template label out
    sed -e "s/@@DAEMON_LABEL@@/$DAEMON_LABEL/g" -e "s/@@DECK_LABEL@@/$DECK_LABEL/g" \
        -e "s/@@BUNDLE_ID@@/$BUNDLE_ID/g" "$1" > "$2"
    /usr/libexec/PlistBuddy -c "Add :KeepAlive dict" "$2"
    /usr/libexec/PlistBuddy -c "Add :KeepAlive:SuccessfulExit bool false" "$2"
    plutil -lint "$2" >/dev/null
}
render "$HERE/LaunchAgent.plist"      "$OUT/$DAEMON_LABEL.plist"
render "$HERE/LaunchAgent-deck.plist" "$OUT/$DECK_LABEL.plist"
echo "rendered $DAEMON_LABEL.plist $DECK_LABEL.plist → $OUT"
