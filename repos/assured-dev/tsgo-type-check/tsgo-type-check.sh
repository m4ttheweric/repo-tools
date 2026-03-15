#!/bin/bash
set -euo pipefail
#
# tsgo-type-check — fast type-checking for apps/backend in assured-dev
#
# Uses @typescript/native-preview (tsgo, ~15x faster than tsc) with tsc-baseline
# for regression detection. Only NEW type errors fail the run; pre-existing
# errors are tracked in backend.tsc-baseline.json (stored here in repo-tools).
#
# Setup (once per machine):
#   1. Install tools globally:  ./tsgo-type-check.sh install-tools
#   2. Wire into the repo:      bun ~/Documents/GitHub/repo-tools/link-repo-tools.ts
#      (adds tsconfig.tsgo.json + .tsc-baseline.json symlinks to apps/backend/,
#       registers both in .git/info/exclude — zero tracked footprint)
#
# Usage:
#   ./tsgo-type-check.sh [check|save] [--repo <path>]
#
#   check  (default)  fail if any new errors appear beyond the baseline
#   save              update the baseline to reflect the current error set
#   install-tools     install/update tsgo and tsc-baseline globally (run once)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TSGO_VERSION="7.0.0-dev.20260211.1"
TSC_BASELINE_VERSION="1.9.0"

MODE="check"
REPO_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    check|save|install-tools) MODE="$1"; shift ;;
    --repo) REPO_ROOT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Global tool installation ───────────────────────────────────────────────────

install_tools() {
  echo "Installing tsgo and tsc-baseline globally..."
  npm install -g "@typescript/native-preview@$TSGO_VERSION" "tsc-baseline@$TSC_BASELINE_VERSION"
  echo ""
  echo "  ✓ tsgo:         $(tsgo --version 2>/dev/null || echo 'installed')"
  echo "  ✓ tsc-baseline: $(tsc-baseline --version 2>/dev/null || echo 'installed')"
  echo ""
  echo "Next: run link-repo-tools.ts to wire the tsconfig and baseline into your repo."
}

if [[ "$MODE" == "install-tools" ]]; then
  install_tools
  exit 0
fi

# ── Dependency check ───────────────────────────────────────────────────────────

if ! command -v tsgo &>/dev/null || ! command -v tsc-baseline &>/dev/null; then
  echo "Error: tsgo and/or tsc-baseline are not installed globally." >&2
  echo "Run: $0 install-tools" >&2
  exit 1
fi

# ── Repo root detection ────────────────────────────────────────────────────────

if [[ -z "$REPO_ROOT" ]]; then
  SEARCH_DIR="$(pwd)"
  while [[ "$SEARCH_DIR" != "/" ]]; do
    if [[ -d "$SEARCH_DIR/apps/backend" ]]; then
      REPO_ROOT="$SEARCH_DIR"
      break
    fi
    SEARCH_DIR="$(dirname "$SEARCH_DIR")"
  done
fi

if [[ -z "$REPO_ROOT" || ! -d "$REPO_ROOT/apps/backend" ]]; then
  echo "Error: could not find assured-dev repo root (apps/backend not found)." >&2
  echo "Run from within the repo or pass --repo <path>." >&2
  exit 1
fi

BACKEND_DIR="$REPO_ROOT/apps/backend"
TSCONFIG_TARGET="$BACKEND_DIR/tsconfig.tsgo.json"
BASELINE_TARGET="$BACKEND_DIR/.tsc-baseline.json"

# ── Pre-flight: verify link-repo-tools has been run ───────────────────────────

MISSING=()
[[ ! -e "$TSCONFIG_TARGET" ]] && MISSING+=("apps/backend/tsconfig.tsgo.json")
[[ ! -e "$BASELINE_TARGET" ]] && MISSING+=("apps/backend/.tsc-baseline.json")

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "Error: the following symlinks are missing in $REPO_ROOT:" >&2
  for f in "${MISSING[@]}"; do echo "  $f" >&2; done
  echo "" >&2
  echo "Run link-repo-tools.ts to set them up:" >&2
  echo "  bun ~/Documents/GitHub/repo-tools/link-repo-tools.ts" >&2
  exit 1
fi

# ── Run ───────────────────────────────────────────────────────────────────────

cd "$BACKEND_DIR"

PKG_NAME=$(node -p "require('./package.json').name" 2>/dev/null || basename "$BACKEND_DIR")

case "$MODE" in
  check)
    echo "Type-checking $PKG_NAME with tsgo (baseline mode)..."
    (tsgo -p tsconfig.tsgo.json --noEmit 2>&1 || true) \
      | tsc-baseline check --ignoreMessages
    ;;
  save)
    echo "Saving type-check baseline for $PKG_NAME..."
    (tsgo -p tsconfig.tsgo.json --noEmit 2>&1 || true) \
      | tsc-baseline save --ignoreMessages
    echo "Baseline saved → $SCRIPT_DIR/backend.tsc-baseline.json"
    ;;
esac
