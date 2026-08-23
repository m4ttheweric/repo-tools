#!/bin/bash
# Layer (a) of the clean-room matrix, locally: the release workflow's clean-room recipe.
# See .github/workflows/release.yml, step "Clean-room install + verify" — keep the two in step.
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

  # Stamp the quarantine attribute the way a browser download does. Extracting
  # an artifact in a shell does NOT set it, so without this the clean-room
  # exercises a path no real user takes -- and cannot catch the class of
  # failure notarization exists to prevent (a correctly signed but
  # un-notarized app is refused on first launch, and every check here would
  # still pass). Best-effort: a filesystem that rejects xattrs must not fail
  # the run, but it must say so rather than silently testing the easy path.
  step "quarantine + Gatekeeper (as a downloaded artifact)"
  if xattr -w com.apple.quarantine "0083;00000000;Safari;" "$APP" 2>/dev/null; then
    if spctl --assess --type exec --context context:primary-signature -vv "$APP" 2>&1 | tee -a "$LOG" | grep -q accepted; then
      echo "  ✓ Gatekeeper accepts the quarantined app" | tee -a "$LOG"
    else
      echo "  ✗ Gatekeeper REJECTS the quarantined app — a real download would be blocked on first launch" | tee -a "$LOG"
      GATEKEEPER_FAILED=1
    fi
    xattr -d com.apple.quarantine "$APP" 2>/dev/null || true
  else
    echo "  ⚠ could not set com.apple.quarantine here — Gatekeeper path NOT exercised" | tee -a "$LOG"
  fi
fi
RT="$APP/Contents/MacOS/rt"
[ -x "${RT:-}" ] || { echo "no rt binary at $APP/Contents/MacOS/rt" >&2; exit 1; }

export CI=true
if [ -n "$HOME_DIR" ]; then mkdir -p "$HOME_DIR"; export HOME="$(cd "$HOME_DIR" && pwd -P)"; fi
# $REAL_HOME/.bun/bin, not $HOME/.bun/bin: oven-sh/setup-bun installs into the
# runner's actual home directory, which is unrelated to the clean room's
# simulated $HOME above. Without it, bun is unresolvable on a CI runner and
# check-bundle.sh's deps.lock-driven Helpers assertions silently drop to a
# fraction of their count instead of failing (see check-bundle.sh's LOCK_TSV
# guard for the other half of this fix).
export PATH="$HOME/.local/bin:$REAL_HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
command -v bun >/dev/null 2>&1 || { echo "  ✗ bun not resolvable on the clean-room PATH ($PATH)" >&2; exit 1; }

step "rt --version (from artifact)";   run "$RT" --version | tee "$OUTDIR/versions.txt" >/dev/null || exit 1
step "rt --post-install $PIA";          run "$RT" --post-install $PIA || exit 1
step "installed rt on PATH";            run test -x "$HOME/.local/bin/rt" && run rt --version || exit 1
step "rt daemon install";               run rt daemon install; sleep 3
step "rt verify --ci";                  rt verify --ci 2>&1 | tee "$OUTDIR/verify-ci.txt" | tee -a "$LOG"
RC=${PIPESTATUS[0]}
CHECK="$(cd "$(dirname "$0")/.." && pwd)/rt-tray/check-bundle.sh"
# Static probe, never executed: check-bundle.sh now parses --app, but a checkout old enough not to
# would fall through to its unconditional `./build.sh release && ./build.sh dev` on any invocation,
# including --help — so probing for --app support by actually invoking it would itself trigger the
# working-tree clobber this guards against.
if [ -x "$CHECK" ] && grep -q -- '--app' "$CHECK"; then
  step "check-bundle.sh --app";         run "$CHECK" --app "$APP" || RC=1
else
  step "check-bundle.sh";               echo "skipped: check-bundle.sh has no --app mode" | tee -a "$LOG"
fi
[ "${GATEKEEPER_FAILED:-0}" = 1 ] && RC=1
printf '\nexit=%s\nartifacts=%s\n' "$RC" "$OUTDIR" | tee -a "$LOG"
exit "$RC"
