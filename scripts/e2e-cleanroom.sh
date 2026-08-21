#!/bin/bash
# Layer (a) of the clean-room matrix, locally: the release workflow's test-install recipe.
# See .github/workflows/release.yml (job test-install) — keep the two in step.
set -uo pipefail
usage() { cat <<'EOF'
usage: e2e-cleanroom.sh [<mattstack-*.zip|.dmg|mattstack.app>]
         (--artifact <mattstack-*.zip|.dmg> | --tag <vX.Y.Z> | --app <mattstack.app>)
         [--home <dir>] [--artifacts-dir <dir>] [--allow-existing-install] [--post-install-args "<args>"]
EOF
exit 2; }
ART=""; TAG=""; APP=""; HOME_DIR=""; OUTDIR=""; ALLOW=0; PIA="--non-interactive --team-of-one --no-launch"
while [ $# -gt 0 ]; do case "$1" in
  --artifact) ART="$2"; shift 2;; --tag) TAG="$2"; shift 2;; --app) APP="$2"; shift 2;;
  --home) HOME_DIR="$2"; shift 2;; --artifacts-dir) OUTDIR="$2"; shift 2;; --allow-existing-install) ALLOW=1; shift;;
  --post-install-args) PIA="$2"; shift 2;; -h|--help) usage;;
  -*) echo "unknown arg $1" >&2; usage;;
  *) case "$1" in *.app) APP="$1";; *) ART="$1";; esac; shift;;   # positional: release.yml passes the zip
  esac; done
[ -n "$ART$TAG$APP" ] || usage

REAL_HOME="$HOME"
if [ "$ALLOW" = 0 ]; then
  if launchctl print "gui/$(id -u)/com.mattstack.daemon" >/dev/null 2>&1 || [ -f "$REAL_HOME/.mattstack/rt/daemon.json" ]; then
    echo "  ✗ this user already has mattstack installed/registered; rt --post-install would launch a second com.mattstack.app." >&2
    echo "    Run inside the VM (rt-tray/vm/run/walkthrough.sh --scenario headless), as the smoke user (rt-tray/vm/run/second-user.sh), or pass --allow-existing-install." >&2
    exit 3
  fi
fi

TS=$(date +%Y%m%d-%H%M%S)
OUTDIR="${OUTDIR:-$(cd "$(dirname "$0")/.." && pwd)/rt-tray/vm/artifacts}/cleanroom-$TS"
mkdir -p "$OUTDIR"
LOG="$OUTDIR/steps.log"
step() { printf '\n== %s ==\n' "$*" | tee -a "$LOG"; }
run()  { "$@" 2>&1 | tee -a "$LOG"; return "${PIPESTATUS[0]}"; }

WORK=$(mktemp -d)
if [ -n "$TAG" ]; then
  step "gh release download $TAG"
  run gh release download "$TAG" -R m4ttstack/rt -p 'mattstack-*.zip' -D "$WORK" || exit 1
  ART=$(ls "$WORK"/mattstack-*.zip | head -1)
fi
if [ -n "$ART" ]; then
  step "extract $(basename "$ART")"
  mkdir -p "$WORK/release"
  case "$ART" in
    *.zip) run ditto -x -k "$ART" "$WORK/release" || exit 1 ;;
    *.dmg) MNT=$(mktemp -d); run hdiutil attach "$ART" -nobrowse -quiet -mountpoint "$MNT" || exit 1
           run ditto "$MNT/mattstack.app" "$WORK/release/mattstack.app"; hdiutil detach "$MNT" -quiet ;;
    *) echo "unknown artifact type: $ART (expected mattstack-<ver>.zip or .dmg)" >&2; exit 1 ;;
  esac
  run ls -la "$WORK/release"
  APP="$WORK/release/mattstack.app"
fi
RT="$APP/Contents/MacOS/rt"
[ -x "${RT:-}" ] || { echo "no rt binary at $APP/Contents/MacOS/rt" >&2; exit 1; }

export CI=true
if [ -n "$HOME_DIR" ]; then export HOME="$HOME_DIR"; mkdir -p "$HOME"; fi
export PATH="$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
step "rt --version (from artifact)";   run "$RT" --version | tee "$OUTDIR/versions.txt" >/dev/null || exit 1
step "rt --post-install $PIA";          run "$RT" --post-install $PIA || exit 1
step "installed rt on PATH";            run test -x "$HOME/.local/bin/rt" && run rt --version || exit 1
step "rt daemon install";               run rt daemon install; sleep 3
step "rt verify --ci";                  rt verify --ci 2>&1 | tee "$OUTDIR/verify-ci.txt" | tee -a "$LOG"
RC=${PIPESTATUS[0]}
CHECK="$(cd "$(dirname "$0")/.." && pwd)/rt-tray/check-bundle.sh"
if [ -x "$CHECK" ]; then
  step "check-bundle.sh --app";         run "$CHECK" --app "$APP" || RC=1
else
  step "check-bundle.sh";               echo "skipped: rt-tray/check-bundle.sh not in this checkout" | tee -a "$LOG"
fi
printf '\nexit=%s\nartifacts=%s\n' "$RC" "$OUTDIR" | tee -a "$LOG"
exit "$RC"
